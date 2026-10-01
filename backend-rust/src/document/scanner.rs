use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use rusqlite::{params, Connection};
use tracing::info;
use unicode_normalization::UnicodeNormalization;

use crate::config::Config;
use crate::document::processor::{detect_doc_type, is_supported_document};
use crate::document::trash::list_trash;

/// Collecte récursivement tous les fichiers supportés (PDF, MD, TXT)
/// Exclut le dossier 'assets/' et les fichiers/dossiers cachés.
/// Retourne une liste de tuples (chemin_absolu, chemin_relatif_normalisé).
pub fn collect_document_files_recursive(dir: &Path, base: &Path) -> Vec<(PathBuf, String)> {
    let mut results = Vec::new();
    let entries = match fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return results,
    };

    for entry in entries.flatten() {
        let path = entry.path();
        let file_name = match path.file_name().and_then(|s| s.to_str()) {
            Some(n) => n,
            None => continue,
        };

        // Ignorer les fichiers et dossiers cachés (.git, .DS_Store, etc.)
        if file_name.starts_with('.') {
            continue;
        }

        if path.is_dir() {
            // Ignorer le dossier réservé aux pièces jointes markdown 'assets'
            if file_name.eq_ignore_ascii_case("assets") {
                continue;
            }

            results.extend(collect_document_files_recursive(&path, base));
        } else if path.is_file() && is_supported_document(&path) {
            if let Ok(meta) = fs::metadata(&path) {
                // Fichier non vide
                if meta.len() > 0 {
                    if let Ok(rel) = path.strip_prefix(base) {
                        let rel_str = rel.to_string_lossy().to_string();
                        let norm_fname: String = rel_str.nfc().collect();
                        results.push((path, norm_fname));
                    }
                }
            }
        }
    }

    results
}

/// Synchronise l'arborescence des dossiers physiques avec la table folders
pub fn sync_physical_folders(
    conn: &Connection,
    base_dir: &Path,
    current_dir: &Path,
    parent_folder_id: Option<i64>,
    folder_id_map: &mut HashMap<PathBuf, i64>,
) {
    let entries = match fs::read_dir(current_dir) {
        Ok(e) => e,
        Err(_) => return,
    };

    let mut sub_dirs = Vec::new();
    for entry in entries.flatten() {
        let p = entry.path();
        if p.is_dir() {
            let name = match p.file_name().and_then(|s| s.to_str()) {
                Some(n) => n,
                None => continue,
            };
            // Ignorer répertoires cachés (dont .assets) et assets
            if !name.starts_with('.') && !name.eq_ignore_ascii_case("assets") {
                sub_dirs.push(p);
            }
        }
    }
    sub_dirs.sort();

    for path in sub_dirs {
        let folder_name = match path.file_name().and_then(|s| s.to_str()) {
            Some(n) => n,
            None => continue,
        };
        let clean_name: String = folder_name.nfc().collect();

        // Récupérer ou créer le folder_id
        let existing_id: Option<i64> = conn
            .query_row(
                "SELECT id FROM folders WHERE name = ?1 AND (parent_id = ?2 OR (parent_id IS NULL AND ?2 IS NULL))",
                params![clean_name, parent_folder_id],
                |r| r.get(0),
            )
            .ok();

        let folder_id = match existing_id {
            Some(id) => id,
            None => {
                let res = conn.execute(
                    "INSERT INTO folders (name, parent_id, color) VALUES (?1, ?2, '#3b82f6')",
                    params![clean_name, parent_folder_id],
                );
                if res.is_ok() {
                    conn.last_insert_rowid()
                } else {
                    continue;
                }
            }
        };

        if let Ok(rel) = path.strip_prefix(base_dir) {
            folder_id_map.insert(rel.to_path_buf(), folder_id);
        }

        sync_physical_folders(conn, base_dir, &path, Some(folder_id), folder_id_map);
    }
}

/// Reconstruit intégralement la base de données dérivée SQLite à partir du filesystem
/// (Principe Filesystem-First : la base de données est jetable et reconstructible)
pub fn rebuild_database_from_filesystem(
    conn: &Connection,
    config: &Config,
) -> Result<Vec<i64>, String> {
    if !config.documents_dir.exists() {
        fs::create_dir_all(&config.documents_dir).map_err(|e| e.to_string())?;
    }
    if !config.trash_dir.exists() {
        fs::create_dir_all(&config.trash_dir).map_err(|e| e.to_string())?;
    }

    // 1. Assurer la présence des tables
    let _ = conn.execute_batch(crate::db::schema::CREATE_FOLDERS_TABLE);
    let _ = conn.execute_batch(crate::db::schema::CREATE_DOCUMENTS_TABLE);
    let _ = conn.execute_batch(crate::db::schema::CREATE_PAGES_TABLE);
    let _ = conn.execute_batch(crate::db::schema::CREATE_FTS5_TABLE);

    // 2. Vider les tables dérivées
    conn.execute_batch(
        "DELETE FROM pages;
         DELETE FROM documents;
         DELETE FROM folders;
         DROP TABLE IF EXISTS document_annotations;
         INSERT INTO pages_fts(pages_fts) VALUES('rebuild');
         INSERT INTO documents_fts(documents_fts) VALUES('rebuild');"
    ).map_err(|e| e.to_string())?;

    // 3. Recréer l'arborescence des dossiers physiques
    let mut folder_id_map = HashMap::new();
    sync_physical_folders(conn, &config.documents_dir, &config.documents_dir, None, &mut folder_id_map);

    // 4. Scanner tous les fichiers physiques vivants (PDF, MD, TXT)
    let mut queued_ids = Vec::new();
    let all_files = collect_document_files_recursive(&config.documents_dir, &config.documents_dir);

    for (path, norm_fname) in all_files {
        if let Ok(meta) = fs::metadata(&path) {
            let file_size = meta.len() as i64;
            let doc_type = detect_doc_type(&path);

            let parent_rel = Path::new(&norm_fname).parent().filter(|p| !p.as_os_str().is_empty());
            let folder_id = parent_rel.and_then(|p| folder_id_map.get(p)).copied();

            let stem = Path::new(&norm_fname)
                .file_stem()
                .and_then(|s| s.to_str())
                .unwrap_or(&norm_fname);
            let clean_stem: String = stem.nfc().collect();
            let initial_title = clean_stem.replace('_', " ").trim().to_string();

            let insert_res = conn.execute(
                "INSERT INTO documents (filename, title, file_size, folder_id, doc_type, status)
                 VALUES (?1, ?2, ?3, ?4, ?5, 'pending')",
                params![norm_fname, initial_title, file_size, folder_id, doc_type],
            );
            if insert_res.is_ok() {
                queued_ids.push(conn.last_insert_rowid());
            }
        }
    }

    // 5. Reconstituer l'état de la corbeille depuis les .meta.json du filesystem
    if let Ok(trash_items) = list_trash(config) {
        for item in trash_items {
            let title = Path::new(&item.original_path)
                .file_stem()
                .and_then(|s| s.to_str())
                .unwrap_or(&item.original_path)
                .replace('_', " ");

            let _ = conn.execute(
                "INSERT INTO documents (filename, title, file_size, doc_type, status, deleted_at)
                 VALUES (?1, ?2, ?3, ?4, 'trashed', ?5)",
                params![item.original_path, title, item.file_size, item.doc_type, item.deleted_at],
            );
        }
    }

    // 6. Nettoyer les couvertures dérivées en cache pour regénération propre
    if let Ok(entries) = fs::read_dir(&config.covers_dir) {
        for entry in entries.flatten() {
            let p = entry.path();
            if p.is_file() {
                let _ = fs::remove_file(p);
            }
        }
    }

    info!(
        "[RebuildDB] Reconstruction terminée : {} documents en attente d'indexation",
        queued_ids.len()
    );

    Ok(queued_ids)
}

/// Scanne le filesystem et synchronise les nouveaux fichiers (PDFs + Markdown)
pub fn scan_and_sync_all_documents(
    conn: &Connection,
    pdf_engine: &crate::pdf::engine::PdfEngine,
    config: &Config,
) -> (usize, Vec<String>) {
    use std::collections::HashSet;
    use tracing::warn;

    if !config.documents_dir.exists() {
        let _ = fs::create_dir_all(&config.documents_dir);
        return (0, Vec::new());
    }

    let mut existing_files = HashSet::new();
    if let Ok(mut stmt) = conn.prepare("SELECT filename FROM documents WHERE status != 'failed'") {
        if let Ok(rows) = stmt.query_map([], |r| r.get::<_, String>(0)) {
            for f in rows.flatten() {
                existing_files.insert(f);
            }
        }
    }

    let all_files = collect_document_files_recursive(&config.documents_dir, &config.documents_dir);
    let mut added = Vec::new();

    for (path, norm_fname) in all_files {
        if !existing_files.contains(&norm_fname) {
            let doc_type = detect_doc_type(&path);
            let res = if doc_type == "markdown" {
                crate::document::markdown::index_markdown_file(conn, config, &path, &norm_fname)
            } else {
                crate::pdf::indexer::index_pdf_file(conn, pdf_engine, config, &path, &norm_fname, None)
            };

            match res {
                Ok(_) => {
                    existing_files.insert(norm_fname.clone());
                    added.push(norm_fname);
                }
                Err(e) => {
                    warn!("[Sync] Échec indexation {}: {}", norm_fname, e);
                }
            }
        }
    }

    (added.len(), added)
}

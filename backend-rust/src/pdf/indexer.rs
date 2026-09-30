use std::fs::File;
use std::io::Read;
use std::path::{Path, PathBuf};
use sha2::{Digest, Sha256};
use unicode_normalization::UnicodeNormalization;
use rusqlite::{params, Connection, Result};
use tracing::{info, error};

use crate::config::Config;
use super::engine::PdfEngine;

pub fn compute_file_hash(path: &Path) -> std::io::Result<String> {
    let mut file = File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buffer = [0u8; 64 * 1024];

    loop {
        let count = file.read(&mut buffer)?;
        if count == 0 {
            break;
        }
        hasher.update(&buffer[..count]);
    }

    Ok(hex::encode(hasher.finalize()))
}

pub fn index_pdf_file(
    conn: &Connection,
    pdf_engine: &PdfEngine,
    _config: &Config,
    file_path: &Path,
    original_filename: &str,
    custom_title: Option<&str>,
) -> std::result::Result<i64, String> {
    let file_size = std::fs::metadata(file_path).map(|m| m.len() as i64).unwrap_or(0);
    if file_size < 5 {
        return Err(format!("Fichier PDF vide ou invalide ({} octet(s))", file_size));
    }

    let mut header = [0u8; 1024];
    if let Ok(mut f) = std::fs::File::open(file_path) {
        if let Ok(n) = f.read(&mut header) {
            let has_pdf_magic = header[..n].windows(5).any(|w| w == b"%PDF-");
            if !has_pdf_magic {
                return Err("Fichier corrompu : signature %PDF- absente dans les 1024 premiers octets".to_string());
            }
        }
    }

    let file_hash = compute_file_hash(file_path).map_err(|e| e.to_string())?;

    // Métadonnées rapides (1 seule ouverture PDF) : titre + nombre de pages
    let metadata = pdf_engine.extract_document_metadata(file_path)?;

    // Nettoyage et normalisation du titre
    let stem = Path::new(original_filename)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or(original_filename);

    let clean_base_title: String = stem.nfc().collect();
    let clean_base_title = clean_base_title.replace('_', " ").trim().to_string();

    let title = if let Some(ct) = custom_title {
        ct.to_string()
    } else {
        clean_base_title
    };

    // Vérifier si le document existe déjà par nom de fichier
    let existing_id: Option<i64> = conn
        .query_row(
            "SELECT id FROM documents WHERE filename = ?1",
            params![original_filename],
            |row| row.get(0),
        )
        .ok();

    let inferred_folder_id: Option<i64> = Path::new(original_filename)
        .parent()
        .and_then(|p| p.to_str())
        // 'assets' (et ses sous-chemins) est le stockage des pièces jointes, pas un dossier utilisateur
        .filter(|p| !p.is_empty() && !p.split('/').any(|seg| seg.eq_ignore_ascii_case("assets")))
        .and_then(|sub_dir| {
            conn.query_row("SELECT id FROM folders WHERE name = ?1", params![sub_dir], |r| r.get(0)).ok()
                .or_else(|| {
                    tracing::warn!("[FolderInfer-PDF] Création dossier '{}' depuis fichier '{}'", sub_dir, original_filename);
                    conn.execute("INSERT INTO folders (name, color) VALUES (?1, '#3b82f6')", params![sub_dir])
                        .ok()
                        .map(|_| conn.last_insert_rowid())
                })
        });

    let doc_id = if let Some(id) = existing_id {
        conn.execute("DELETE FROM pages WHERE doc_id = ?1", params![id]).map_err(|e| e.to_string())?;
        conn.execute(
            "UPDATE documents SET title = ?1, file_hash = ?2, total_pages = ?3, file_size = ?4, folder_id = COALESCE(folder_id, ?5), status = 'ready', error_message = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?6",
            params![title, file_hash, metadata.total_pages, file_size, inferred_folder_id, id],
        ).map_err(|e| e.to_string())?;
        id
    } else {
        conn.execute(
            "INSERT INTO documents (filename, title, file_hash, total_pages, file_size, folder_id, status, error_message) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'ready', NULL)",
            params![original_filename, title, file_hash, metadata.total_pages, file_size, inferred_folder_id],
        ).map_err(|e| e.to_string())?;
        conn.last_insert_rowid()
    };

    // Plus de couverture pré-générée sur disque : /api/cover rend à la volée.

    // 1. Extraction en mémoire hors de toute transaction SQLite :
    //    Le parsing Pdfium (qui peut durer des dizaines de secondes sur un gros livre)
    //    ne bloque ainsi JAMAIS la base de données.
    let mut extracted_pages = Vec::new();
    if let Err(e) = pdf_engine.extract_pages_streaming(file_path, |page_number, text_content, words_json| {
        extracted_pages.push((page_number, text_content, words_json));
        Ok(())
    }) {
        let _ = conn.execute(
            "UPDATE documents SET status = 'failed', error_message = ?1, updated_at = CURRENT_TIMESTAMP WHERE id = ?2",
            params![format!("Extraction interrompue : {}", e), doc_id],
        );
        return Err(format!("Extraction interrompue : {}", e));
    }

    // 2. Insertion atomique ultra-rapide (< 50ms) dans SQLite :
    //    Le verrou d'écriture SQLite n'est maintenu que quelques millisecondes,
    //    éliminant tout timeout (504) pour les connexions utilisateur ou la navigation.
    let mut inserted_pages: i64 = 0;
    {
        let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
        {
            let mut insert_page = tx
                .prepare("INSERT INTO pages (doc_id, page_number, text_content, words_json) VALUES (?1, ?2, ?3, ?4)")
                .map_err(|e| e.to_string())?;

            for (page_number, text_content, words_json) in extracted_pages {
                insert_page
                    .execute(params![doc_id, page_number, text_content, words_json])
                    .map_err(|e| e.to_string())?;
                inserted_pages += 1;
            }
        }
        tx.commit().map_err(|e| e.to_string())?;
    }

    info!("[Indexer] Document {} ('{}') indexé avec succès ({} pages).", doc_id, title, inserted_pages);
    Ok(doc_id)
}

pub fn remove_document(conn: &Connection, config: &Config, doc_id: i64) -> Result<bool, String> {
    let filename: Option<String> = conn
        .query_row("SELECT filename FROM documents WHERE id = ?1", params![doc_id], |r| r.get(0))
        .ok();

    let fname = match filename {
        Some(f) => f,
        None => return Ok(false),
    };

    // La suppression dans pages déclenche automatiquement le trigger pages_ad pour pages_fts
    conn.execute("DELETE FROM pages WHERE doc_id = ?1", params![doc_id]).map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM documents WHERE id = ?1", params![doc_id]).map_err(|e| e.to_string())?;

    // Supprimer le fichier PDF
    let pdf_path = resolve_pdf_path(&config.documents_dir, &fname)
        .unwrap_or_else(|| config.documents_dir.join(&fname));
    if pdf_path.exists() {
        let _ = std::fs::remove_file(pdf_path);
    }

    // Nettoyer les éventuels restes de caches de vignettes (versions antérieures)
    let cover_webp = config.covers_dir.join(format!("{}.webp", doc_id));
    let _ = std::fs::remove_file(cover_webp);
    let doc_cache_dir = config.cache_dir.join(format!("doc_{}", doc_id));
    if doc_cache_dir.exists() {
        let _ = std::fs::remove_dir_all(doc_cache_dir);
    }

    Ok(true)
}

/// Collecte récursivement tous les fichiers PDF dans un dossier et ses sous-dossiers.
/// Retourne une liste de tuples (chemin_absolu, chemin_relatif_normalisé).
pub fn collect_pdf_files_recursive(dir: &Path, base: &Path) -> Vec<(PathBuf, String)> {
    let mut results = Vec::new();
    if let Ok(entries) = std::fs::read_dir(dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                results.extend(collect_pdf_files_recursive(&path, base));
            } else if path.is_file() {
                if let Some(ext) = path.extension().and_then(|e| e.to_str()) {
                    if ext.eq_ignore_ascii_case("pdf") {
                        if let Ok(meta) = std::fs::metadata(&path) {
                            if meta.len() >= 5 {
                                if let Ok(rel) = path.strip_prefix(base) {
                                    let rel_str = rel.to_string_lossy().to_string();
                                    let norm_fname: String = rel_str.nfc().collect();
                                    results.push((path, norm_fname));
                                }
                            }
                        }
                    }
                }
            }
        }
    }
    results
}

/// Résout un chemin de fichier PDF de façon ultra-résiliente :
/// - Vérification directe (base_dir / fname)
/// - Normalisation Unicode croisée (NFD vs NFC) indispensable entre macOS (APFS NFD) et Linux/Synology (ext4/btrfs raw bytes)
/// - Recherche récursive dans les sous-dossiers si le fichier a été déplacé ou enregistré sans son préfixe
/// - Tolérance casse (case-insensitive) si nécessaire
pub fn resolve_pdf_path(base_dir: &Path, fname: &str) -> Option<PathBuf> {
    // 1. Essai direct tel quel
    let direct = base_dir.join(fname);
    if direct.exists() {
        return Some(direct);
    }

    // 2. Variantes directes Unicode NFD (macOS) et NFC (Linux/Web)
    let nfd_name: String = fname.nfd().collect();
    let direct_nfd = base_dir.join(&nfd_name);
    if direct_nfd.exists() {
        return Some(direct_nfd);
    }

    let nfc_name: String = fname.nfc().collect();
    let direct_nfc = base_dir.join(&nfc_name);
    if direct_nfc.exists() {
        return Some(direct_nfc);
    }

    // 3. Fallback : scan récursif avec comparaison Unicode normalisée (NFC) et insensible à la casse
    let target_base_nfc: String = Path::new(fname)
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| fname.to_string())
        .nfc()
        .collect();

    fn find_in_dir_recursive(dir: &Path, target_nfc: &str) -> Option<PathBuf> {
        let entries = match std::fs::read_dir(dir) {
            Ok(e) => e,
            Err(_) => return None,
        };
        for entry in entries.flatten() {
            let p = entry.path();
            if p.is_dir() {
                if let Some(found) = find_in_dir_recursive(&p, target_nfc) {
                    return Some(found);
                }
            } else if p.is_file() {
                if let Some(name) = p.file_name() {
                    let name_str = name.to_string_lossy();
                    let name_nfc: String = name_str.nfc().collect();
                    if name_nfc == target_nfc || name_nfc.eq_ignore_ascii_case(target_nfc) {
                        return Some(p);
                    }
                }
            }
        }
        None
    }

    find_in_dir_recursive(base_dir, &target_base_nfc)
}

pub fn scan_and_sync_documents(
    conn: &Connection,
    pdf_engine: &PdfEngine,
    config: &Config,
) -> (usize, Vec<String>) {
    use rayon::prelude::*;

    if !config.documents_dir.exists() {
        std::fs::create_dir_all(&config.documents_dir).ok();
        return (0, Vec::new());
    }

    let mut stmt = match conn.prepare("SELECT filename, file_hash FROM documents WHERE status != 'failed'") {
        Ok(s) => s,
        Err(_) => return (0, Vec::new()),
    };

    let mut existing_files = std::collections::HashSet::new();
    let mut existing_hashes = std::collections::HashSet::new();

    if let Ok(rows) = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, Option<String>>(1)?))) {
        for (f, h) in rows.flatten() {
            existing_files.insert(f.clone());
            if let Some(base) = Path::new(&f).file_name().and_then(|s| s.to_str()) {
                existing_files.insert(base.to_string());
            }
            if let Some(hash) = h {
                existing_hashes.insert(hash);
            }
        }
    }

    let all_pdfs = collect_pdf_files_recursive(&config.documents_dir, &config.documents_dir);
    let mut candidate_paths = Vec::new();
    for (path, norm_fname) in all_pdfs {
        let base_name = path.file_name().and_then(|f| f.to_str()).unwrap_or(&norm_fname);
        let norm_base: String = base_name.nfc().collect();
        if !existing_files.contains(&norm_fname) && !existing_files.contains(&norm_base) {
            candidate_paths.push((path, norm_fname));
        }
    }

    // Calcul multi-cœurs des hashs SHA256 avec Rayon
    let candidates_with_hashes: Vec<_> = candidate_paths
        .into_par_iter()
        .filter_map(|(path, norm_fname)| {
            compute_file_hash(&path).ok().map(|hash| (path, norm_fname, hash))
        })
        .collect();

    let mut added = Vec::new();
    for (path, norm_fname, fhash) in candidates_with_hashes {
        if !existing_hashes.contains(&fhash) {
            match index_pdf_file(conn, pdf_engine, config, &path, &norm_fname, None) {
                Ok(_) => {
                    existing_files.insert(norm_fname.clone());
                    existing_hashes.insert(fhash);
                    added.push(norm_fname);
                }
                Err(e) => {
                    error!("[Sync] Échec indexation {}: {}", norm_fname, e);
                }
            }
        }
    }

    (added.len(), added)
}

/// Extrait le titre propre selon la logique la plus récente
pub fn extract_cleaned_title(
    _pdf_engine: &PdfEngine,
    _file_path: &Path,
    original_filename: &str,
    custom_title: Option<&str>,
) -> String {
    let stem = Path::new(original_filename)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or(original_filename);

    let clean_base_title: String = stem.nfc().collect();
    let clean_base_title = clean_base_title.replace('_', " ").trim().to_string();

    if let Some(ct) = custom_title {
        ct.to_string()
    } else {
        clean_base_title
    }
}

/// Réinitialise l'indexation de tous les documents tout en conservant scrupuleusement l'arborescence (folders)
/// Helper récursif pour mapper l'arborescence réelle des dossiers du disque dans la table folders
fn sync_physical_folders_to_db(
    conn: &Connection,
    base_dir: &Path,
    current_dir: &Path,
    parent_folder_id: Option<i64>,
    folder_id_map: &mut std::collections::HashMap<PathBuf, i64>,
) {
    let entries = match std::fs::read_dir(current_dir) {
        Ok(e) => e,
        Err(_) => return,
    };
    let mut sub_dirs = Vec::new();
    for entry in entries.flatten() {
        let p = entry.path();
        if p.is_dir() {
            sub_dirs.push(p);
        }
    }
    sub_dirs.sort();

    for path in sub_dirs {
        let folder_name = match path.file_name().and_then(|s| s.to_str()) {
            Some(n) => n,
            None => continue,
        };
        // Ignorer le dossier réservé aux pièces jointes markdown et les dossiers cachés
        // (même convention que document/scanner.rs : 'assets' n'est pas un dossier utilisateur)
        if folder_name.starts_with('.') || folder_name.eq_ignore_ascii_case("assets") {
            continue;
        }
        let clean_name: String = folder_name.nfc().collect();
        let res = conn.execute(
            "INSERT INTO folders (name, parent_id, color) VALUES (?1, ?2, '#3b82f6')",
            params![clean_name, parent_folder_id],
        );
        if res.is_ok() {
            let folder_id = conn.last_insert_rowid();
            if let Ok(rel) = path.strip_prefix(base_dir) {
                folder_id_map.insert(rel.to_path_buf(), folder_id);
            }
            sync_physical_folders_to_db(conn, base_dir, &path, Some(folder_id), folder_id_map);
        }
    }
}

/// Réinitialise l'indexation de tous les documents : le système de fichiers est la source unique de vérité.
pub fn reindex_all_library(
    conn: &Connection,
    _pdf_engine: &PdfEngine,
    config: &Config,
) -> Result<Vec<i64>, String> {
    if !config.documents_dir.exists() {
        return Ok(Vec::new());
    }

    // 1. Assurer la présence des schémas / tables indispensables
    let _ = conn.execute_batch(crate::db::schema::CREATE_FOLDERS_TABLE);
    let _ = conn.execute_batch(crate::db::schema::CREATE_DOCUMENTS_TABLE);
    let _ = conn.execute_batch(crate::db::schema::CREATE_PAGES_TABLE);
    let _ = conn.execute_batch(crate::db::schema::CREATE_FTS5_TABLE);

    // 2. Vider intégralement la base SQLite (y compris dossiers et annotations)
    let _ = conn.execute("DELETE FROM pages", []);
    let _ = conn.execute("DELETE FROM documents", []);
    let _ = conn.execute("DELETE FROM folders", []);
    let _ = conn.execute("DROP TABLE IF EXISTS document_annotations", []);
    let _ = conn.execute("INSERT INTO pages_fts(pages_fts) VALUES('rebuild')", []);
    let _ = conn.execute("INSERT INTO documents_fts(documents_fts) VALUES('rebuild')", []);

    // 3. Recréer fidèlement l'arborescence des dossiers à partir du système de fichiers
    let mut folder_id_map = std::collections::HashMap::new();
    sync_physical_folders_to_db(conn, &config.documents_dir, &config.documents_dir, None, &mut folder_id_map);

    // 4. Scanner récursivement le répertoire des documents physiques
    let mut queued_ids = Vec::new();
    let all_pdfs = collect_pdf_files_recursive(&config.documents_dir, &config.documents_dir);

    for (path, norm_fname) in all_pdfs {
        if let Ok(meta) = std::fs::metadata(&path) {
            let file_size = meta.len() as i64;
            if file_size < 5 {
                continue;
            }
            let base_name = path.file_name().and_then(|f| f.to_str()).unwrap_or(&norm_fname);
            let norm_base: String = base_name.nfc().collect();

            // Déterminer le folder_id physique à partir du dossier parent réel
            let parent_rel = Path::new(&norm_fname).parent().filter(|p| !p.as_os_str().is_empty());
            let folder_id = parent_rel.and_then(|p| folder_id_map.get(p)).copied();

            let stem = Path::new(&norm_base)
                .file_stem()
                .and_then(|s| s.to_str())
                .unwrap_or(&norm_base);
            let clean_stem: String = stem.nfc().collect();
            let initial_title = clean_stem.replace('_', " ").trim().to_string();

            let insert_res = conn.execute(
                "INSERT INTO documents (filename, title, file_size, folder_id, status) VALUES (?1, ?2, ?3, ?4, 'pending')",
                params![norm_fname, initial_title, file_size, folder_id],
            );
            if let Ok(_) = insert_res {
                let new_id = conn.last_insert_rowid();
                queued_ids.push(new_id);
            }
        }
    }

    // 4. Nettoyer les couvertures pour forcer la regénération propre
    if let Ok(entries) = std::fs::read_dir(&config.covers_dir) {
        for entry in entries.flatten() {
            let p = entry.path();
            if p.is_file() {
                let _ = std::fs::remove_file(p);
            }
        }
    }

    info!("[ReindexAll] Réinitialisation terminée : {} document(s) prêts pour indexation complète", queued_ids.len());
    Ok(queued_ids)
}

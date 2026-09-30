use std::fs;
use std::path::{Path, PathBuf};
use chrono::{DateTime, Duration, Utc};
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use tracing::info;
use crate::config::Config;
use crate::document::processor::detect_doc_type;

#[derive(Debug, Serialize, Deserialize)]
pub struct TrashMetadata {
    pub original_path: String,
    pub deleted_at: String,
    pub expires_at: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct TrashItem {
    pub trash_name: String,
    pub original_path: String,
    pub deleted_at: String,
    pub expires_at: String,
    pub file_size: i64,
    pub doc_type: String,
}

/// Convertit un chemin relatif en nom de fichier plat sûr pour la corbeille
pub fn to_trash_filename(rel_path: &str) -> String {
    let safe = rel_path.replace('/', "__").replace('\\', "__");
    format!("del_{}", safe)
}

/// Résout l'emplacement physique d'un document dans documents_dir
pub fn resolve_file_path(base_dir: &Path, rel_path: &str) -> Option<PathBuf> {
    let clean = rel_path.trim_start_matches('/');

    // 1. Essai direct (si c'est un fichier existant ou chemin direct)
    let direct = base_dir.join(clean);
    if direct.is_file() {
        return Some(direct);
    }

    // 2. Si c'est un document Markdown dans son dossier de note : base_dir/[parent/]stem/stem.md
    let path_obj = Path::new(clean);
    let stem = path_obj.file_stem().and_then(|s| s.to_str()).unwrap_or(clean);
    let parent = path_obj.parent();

    let note_dir_file = match parent {
        Some(p) if !p.as_os_str().is_empty() => base_dir.join(p).join(stem).join(format!("{}.md", stem)),
        _ => base_dir.join(stem).join(format!("{}.md", stem)),
    };
    if note_dir_file.is_file() {
        return Some(note_dir_file);
    }

    let note_dir_file_mk = match parent {
        Some(p) if !p.as_os_str().is_empty() => base_dir.join(p).join(stem).join(format!("{}.markdown", stem)),
        _ => base_dir.join(stem).join(format!("{}.markdown", stem)),
    };
    if note_dir_file_mk.is_file() {
        return Some(note_dir_file_mk);
    }

    // 3. Recherche par stem de dossier de note
    if let Some(note_dir) = crate::document::markdown::find_note_dir_by_stem(base_dir, stem) {
        if let Some(md_file) = crate::document::markdown::find_markdown_file_in_note_dir(&note_dir) {
            return Some(md_file);
        }
    }

    // 4. Fallback sur resolve_pdf_path
    crate::pdf::indexer::resolve_pdf_path(base_dir, clean)
}

/// Résout le dossier physique d'une note Markdown (ex: data/documents/nom_de_la_note/)
pub fn resolve_note_dir(base_dir: &Path, rel_path_or_stem: &str) -> Option<PathBuf> {
    let clean = rel_path_or_stem.trim_start_matches('/');
    let path_obj = Path::new(clean);
    let stem = path_obj.file_stem().and_then(|s| s.to_str()).unwrap_or(clean);
    let parent = path_obj.parent();

    // 1. Tester base_dir/[parent/]stem
    let direct_dir = match parent {
        Some(p) if !p.as_os_str().is_empty() => base_dir.join(p).join(stem),
        _ => base_dir.join(stem),
    };
    if crate::document::markdown::is_markdown_note_dir(&direct_dir) {
        return Some(direct_dir);
    }

    // 2. Si le chemin pointe vers le fichier markdown
    if let Some(file_path) = resolve_file_path(base_dir, clean) {
        if let Some(p) = file_path.parent() {
            if crate::document::markdown::is_markdown_note_dir(p) {
                return Some(p.to_path_buf());
            }
        }
    }

    // 3. Recherche récursive
    crate::document::markdown::find_note_dir_by_stem(base_dir, stem)
}

/// Déplace un document vers la corbeille (Soft-Delete)
pub fn soft_delete(conn: &Connection, config: &Config, filename: &str) -> Result<(), String> {
    let trash_dir = &config.trash_dir;
    fs::create_dir_all(trash_dir).map_err(|e| e.to_string())?;

    let src = resolve_file_path(&config.documents_dir, filename)
        .ok_or_else(|| format!("Fichier introuvable sur le disque : {}", filename))?;

    let trash_filename = to_trash_filename(filename);
    let dest_file = trash_dir.join(&trash_filename);

    // 1. Déplacer le fichier physique vers data/trash/
    fs::rename(&src, &dest_file)
        .map_err(|e| format!("Impossible de déplacer vers la corbeille : {}", e))?;

    // 2. Déplacer les assets si Markdown
    let doc_type = detect_doc_type(&src);
    if doc_type == "markdown" || filename.ends_with(".md") || filename.ends_with(".markdown") {
        let stem = Path::new(filename)
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or(filename);

        // Déplacer les assets depuis le dossier de la note (nom_de_la_note/assets/)
        if let Some(parent) = src.parent() {
            let note_assets = parent.join("assets");
            if note_assets.exists() {
                let assets_dst = trash_dir.join(format!("del_{}_assets", stem));
                let _ = fs::rename(&note_assets, &assets_dst);
            }
            // Si le dossier de la note est vide, le nettoyer
            let _ = fs::remove_dir(parent);
        }

        // Fallback rétrocompatible pour l'ancien chemin assets/<stem>
        let old_assets = config.documents_dir.join("assets").join(stem);
        if old_assets.exists() {
            let assets_dst = trash_dir.join(format!("del_{}_assets", stem));
            if !assets_dst.exists() {
                let _ = fs::rename(&old_assets, &assets_dst);
            } else {
                let _ = fs::remove_dir_all(&old_assets);
            }
        }
    }

    // 3. Écrire le fichier .meta.json
    let now = Utc::now();
    let expires = now + Duration::days(30);
    let meta = TrashMetadata {
        original_path: filename.to_string(),
        deleted_at: now.to_rfc3339(),
        expires_at: expires.to_rfc3339(),
    };
    let meta_json_path = trash_dir.join(format!("{}.meta.json", trash_filename));
    let json_bytes = serde_json::to_string_pretty(&meta).map_err(|e| e.to_string())?;
    fs::write(&meta_json_path, json_bytes).map_err(|e| e.to_string())?;

    // 4. Mettre à jour l'index SQLite (sans perdre la référence)
    let _ = conn.execute(
        "UPDATE documents SET status = 'trashed', deleted_at = CURRENT_TIMESTAMP WHERE filename = ?1",
        params![filename],
    );
    // Supprimer le texte FTS5 pour qu'il n'apparaisse plus dans les recherches
    let _ = conn.execute(
        "DELETE FROM pages WHERE doc_id = (SELECT id FROM documents WHERE filename = ?1)",
        params![filename],
    );

    info!("[Trash] Document '{}' déplacé en corbeille sous '{}'", filename, trash_filename);
    Ok(())
}

/// Restaure un document depuis la corbeille vers son emplacement d'origine
pub fn restore_from_trash(conn: &Connection, config: &Config, identifier: &str) -> Result<(i64, String), String> {
    let trash_dir = &config.trash_dir;

    // identifier peut être 'notes.md', 'Cardiologie/cours.pdf', ou 'del_notes.md'
    let trash_filename = if identifier.starts_with("del_") {
        identifier.to_string()
    } else {
        to_trash_filename(identifier)
    };

    let meta_path = trash_dir.join(format!("{}.meta.json", trash_filename));
    if !meta_path.exists() {
        return Err(format!("Métadonnées de corbeille introuvables pour {}", identifier));
    }

    let meta_content = fs::read_to_string(&meta_path).map_err(|e| e.to_string())?;
    let meta: TrashMetadata = serde_json::from_str(&meta_content)
        .map_err(|e| format!("Erreur lecture métadonnées corbeille : {}", e))?;

    let src_file = trash_dir.join(&trash_filename);
    if !src_file.exists() {
        return Err(format!("Fichier corbeille introuvable : {:?}", src_file));
    }

    // 1. Remettre le fichier à son emplacement d'origine
    let doc_type = detect_doc_type(&src_file);
    let is_md = doc_type == "markdown" || meta.original_path.ends_with(".md") || meta.original_path.ends_with(".markdown");

    let (dest, note_dir_opt) = if is_md {
        let stem = Path::new(&meta.original_path)
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or(&meta.original_path);
        let orig_parent = Path::new(&meta.original_path).parent();
        let target_note_dir = match orig_parent {
            Some(p) if !p.as_os_str().is_empty() => config.documents_dir.join(p).join(stem),
            _ => config.documents_dir.join(stem),
        };
        fs::create_dir_all(&target_note_dir).map_err(|e| e.to_string())?;
        let md_target = target_note_dir.join(format!("{}.md", stem));
        (md_target, Some(target_note_dir))
    } else {
        let dest = config.documents_dir.join(&meta.original_path);
        if let Some(parent) = dest.parent() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        (dest, None)
    };

    fs::rename(&src_file, &dest)
        .map_err(|e| format!("Impossible de restaurer le fichier vers {:?} : {}", dest, e))?;

    // 2. Restaurer les assets si Markdown
    if is_md {
        let stem = Path::new(&meta.original_path)
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or(&meta.original_path);
        let assets_src = trash_dir.join(format!("del_{}_assets", stem));
        if assets_src.exists() {
            let assets_dst = if let Some(ref nd) = note_dir_opt {
                nd.join("assets")
            } else {
                config.documents_dir.join("assets").join(stem)
            };
            if let Some(parent) = assets_dst.parent() {
                let _ = fs::create_dir_all(parent);
            }
            let _ = fs::rename(&assets_src, &assets_dst);
        }
    }

    // 3. Supprimer le .meta.json
    let _ = fs::remove_file(&meta_path);

    // 4. Mettre à jour SQLite
    let existing_id: Option<i64> = conn
        .query_row(
            "SELECT id FROM documents WHERE filename = ?1",
            params![meta.original_path],
            |r| r.get(0),
        )
        .ok();

    let doc_id = match existing_id {
        Some(id) => {
            let _ = conn.execute(
                "UPDATE documents SET status = 'pending', deleted_at = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?1",
                params![id],
            );
            id
        }
        None => {
            let file_size = fs::metadata(&dest).map(|m| m.len() as i64).unwrap_or(0);
            let title = Path::new(&meta.original_path)
                .file_stem()
                .and_then(|s| s.to_str())
                .unwrap_or(&meta.original_path)
                .replace('_', " ");
            conn.execute(
                "INSERT INTO documents (filename, title, file_size, doc_type, status) VALUES (?1, ?2, ?3, ?4, 'pending')",
                params![meta.original_path, title, file_size, doc_type],
            ).map_err(|e| e.to_string())?;
            conn.last_insert_rowid()
        }
    };

    info!("[Trash] Document '{}' restauré avec succès (doc_id: {})", meta.original_path, doc_id);
    Ok((doc_id, meta.original_path))
}

/// Liste tous les fichiers actuellement dans la corbeille
pub fn list_trash(config: &Config) -> Result<Vec<TrashItem>, String> {
    let trash_dir = &config.trash_dir;
    if !trash_dir.exists() {
        return Ok(Vec::new());
    }

    let entries = fs::read_dir(trash_dir).map_err(|e| e.to_string())?;
    let mut items = Vec::new();

    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_file() && path.extension().and_then(|e| e.to_str()) == Some("json") {
            let name = path.file_name().and_then(|s| s.to_str()).unwrap_or_default();
            if name.ends_with(".meta.json") {
                let base_trash_name = name.trim_end_matches(".meta.json");
                let file_path = trash_dir.join(base_trash_name);

                if let Ok(content) = fs::read_to_string(&path) {
                    if let Ok(meta) = serde_json::from_str::<TrashMetadata>(&content) {
                        let file_size = fs::metadata(&file_path).map(|m| m.len() as i64).unwrap_or(0);
                        let doc_type = detect_doc_type(Path::new(&meta.original_path)).to_string();

                        items.push(TrashItem {
                            trash_name: base_trash_name.to_string(),
                            original_path: meta.original_path,
                            deleted_at: meta.deleted_at,
                            expires_at: meta.expires_at,
                            file_size,
                            doc_type,
                        });
                    }
                }
            }
        }
    }

    // Trier du plus récemment supprimé au plus ancien
    items.sort_by(|a, b| b.deleted_at.cmp(&a.deleted_at));
    Ok(items)
}

/// Supprime définitivement un fichier de la corbeille
pub fn permanently_delete_trash_item(conn: &Connection, config: &Config, identifier: &str) -> Result<bool, String> {
    let trash_dir = &config.trash_dir;

    let trash_filename = if identifier.starts_with("del_") {
        identifier.to_string()
    } else {
        to_trash_filename(identifier)
    };

    let meta_path = trash_dir.join(format!("{}.meta.json", trash_filename));
    let mut original_path = None;

    if meta_path.exists() {
        if let Ok(content) = fs::read_to_string(&meta_path) {
            if let Ok(meta) = serde_json::from_str::<TrashMetadata>(&content) {
                original_path = Some(meta.original_path);
            }
        }
        let _ = fs::remove_file(&meta_path);
    }

    let file_path = trash_dir.join(&trash_filename);
    if file_path.exists() {
        let _ = fs::remove_file(&file_path);
    }

    // Supprimer assets si MD
    if let Some(ref orig) = original_path {
        let stem = Path::new(orig).file_stem().and_then(|s| s.to_str()).unwrap_or(orig);
        let assets_path = trash_dir.join(format!("del_{}_assets", stem));
        if assets_path.exists() {
            let _ = fs::remove_dir_all(&assets_path);
        }

        // Nettoyer la ligne de documents dans SQLite si status = 'trashed'
        let _ = conn.execute(
            "DELETE FROM documents WHERE filename = ?1 AND status = 'trashed'",
            params![orig],
        );
    }

    Ok(true)
}

/// Purge automatique des fichiers expirés (> 30 jours)
pub fn purge_expired_trash(conn: &Connection, config: &Config) -> Result<usize, String> {
    let items = list_trash(config)?;
    let now = Utc::now();
    let mut purged = 0;

    for item in items {
        if let Ok(exp) = DateTime::parse_from_rfc3339(&item.expires_at) {
            if exp.with_timezone(&Utc) < now {
                if let Ok(true) = permanently_delete_trash_item(conn, config, &item.trash_name) {
                    purged += 1;
                }
            }
        }
    }

    if purged > 0 {
        info!("[Trash] {} élément(s) expiré(s) purgé(s) de la corbeille", purged);
    }
    Ok(purged)
}

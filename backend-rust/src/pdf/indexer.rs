use std::fs::File;
use std::io::Read;
use std::path::Path;
use sha2::{Digest, Sha256};
use unicode_normalization::UnicodeNormalization;
use rusqlite::{params, Connection, Result};
use tracing::{info, warn, error};

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
    config: &Config,
    file_path: &Path,
    original_filename: &str,
    custom_title: Option<&str>,
) -> std::result::Result<i64, String> {
    let file_hash = compute_file_hash(file_path).map_err(|e| e.to_string())?;
    let file_size = std::fs::metadata(file_path).map(|m| m.len() as i64).unwrap_or(0);

    let extracted = pdf_engine.extract_document_data(file_path)?;

    // Nettoyage et normalisation du titre
    let stem = Path::new(original_filename)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or(original_filename);

    let clean_base_title: String = stem.nfc().collect();
    let clean_base_title = clean_base_title.replace('_', " ").trim().to_string();

    let meta_title: String = extracted.meta_title.nfc().collect();
    let title = if let Some(ct) = custom_title {
        ct.to_string()
    } else if !meta_title.is_empty()
        && meta_title.len() > 2
        && !["microsoft", "word", "powerpoint", "untitled"]
            .iter()
            .any(|&prefix| meta_title.to_lowercase().starts_with(prefix))
    {
        meta_title
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

    let doc_id = if let Some(id) = existing_id {
        conn.execute("DELETE FROM pages WHERE doc_id = ?1", params![id]).map_err(|e| e.to_string())?;
        conn.execute(
            "UPDATE documents SET title = ?1, file_hash = ?2, total_pages = ?3, file_size = ?4, status = 'ready', error_message = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?5",
            params![title, file_hash, extracted.total_pages, file_size, id],
        ).map_err(|e| e.to_string())?;
        id
    } else {
        conn.execute(
            "INSERT INTO documents (filename, title, file_hash, total_pages, file_size, status, error_message) VALUES (?1, ?2, ?3, ?4, ?5, 'ready', NULL)",
            params![original_filename, title, file_hash, extracted.total_pages, file_size],
        ).map_err(|e| e.to_string())?;
        conn.last_insert_rowid()
    };

    // Générer la couverture WebP si au moins 1 page
    if extracted.total_pages > 0 {
        let cover_webp = config.covers_dir.join(format!("{}.webp", doc_id));
        if let Err(e) = pdf_engine.render_cover(file_path, &cover_webp) {
            warn!("[Indexer] Impossible de générer la couverture pour doc {} : {}", doc_id, e);
        }
    }

    // Insérer les pages dans une transaction (le trigger pages_ai indexe automatiquement dans pages_fts)
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    {
        let mut insert_page = tx
            .prepare("INSERT INTO pages (doc_id, page_number, text_content, words_json) VALUES (?1, ?2, ?3, ?4)")
            .map_err(|e| e.to_string())?;

        for p in extracted.pages {
            insert_page
                .execute(params![doc_id, p.page_number, p.text_content, p.words_json])
                .map_err(|e| e.to_string())?;
        }
    }
    tx.commit().map_err(|e| e.to_string())?;

    info!("[Indexer] Document {} ('{}') indexé avec succès ({} pages).", doc_id, title, extracted.total_pages);
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
    let pdf_path = config.documents_dir.join(&fname);
    if pdf_path.exists() {
        let _ = std::fs::remove_file(pdf_path);
    }

    // Supprimer la couverture WebP
    let cover_webp = config.covers_dir.join(format!("{}.webp", doc_id));
    let _ = std::fs::remove_file(cover_webp);

    // Nettoyer les crops en cache
    let doc_cache_dir = config.cache_dir.join(format!("doc_{}", doc_id));
    if doc_cache_dir.exists() {
        let _ = std::fs::remove_dir_all(doc_cache_dir);
    }

    Ok(true)
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

    let mut stmt = match conn.prepare("SELECT filename, file_hash FROM documents") {
        Ok(s) => s,
        Err(_) => return (0, Vec::new()),
    };

    let mut existing_files = std::collections::HashSet::new();
    let mut existing_hashes = std::collections::HashSet::new();

    if let Ok(rows) = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, Option<String>>(1)?))) {
        for (f, h) in rows.flatten() {
            existing_files.insert(f);
            if let Some(hash) = h {
                existing_hashes.insert(hash);
            }
        }
    }

    let mut candidate_paths = Vec::new();
    if let Ok(entries) = std::fs::read_dir(&config.documents_dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_file() {
                if let Some(ext) = path.extension().and_then(|e| e.to_str()) {
                    if ext.eq_ignore_ascii_case("pdf") {
                        if let Some(fname) = path.file_name().and_then(|f| f.to_str()) {
                            let norm_fname: String = fname.nfc().collect();
                            if !existing_files.contains(&norm_fname) && !existing_files.contains(fname) {
                                candidate_paths.push((path, norm_fname));
                            }
                        }
                    }
                }
            }
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

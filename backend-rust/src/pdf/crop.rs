use std::path::PathBuf;
use regex::Regex;
use rusqlite::{params, Connection};
use tracing::warn;

use crate::config::Config;
use crate::search::engine::find_occurrences_on_page;
use super::engine::PdfEngine;

pub fn get_or_generate_crop_on_demand(
    conn: &Connection,
    pdf_engine: &PdfEngine,
    config: &Config,
    doc_id: i64,
    page_number: i64,
    occ_id: usize,
    query_hash: &str,
    terms_str: &str,
) -> Option<PathBuf> {
    // Sanitisation stricte du query_hash (anti Path Traversal)
    let re_hash = Regex::new(r"^[a-f0-9]{1,32}$").unwrap();
    let safe_hash = if re_hash.is_match(query_hash.trim()) {
        query_hash.trim()
    } else {
        ""
    };

    let doc_cache_dir = config.cache_dir.join(format!("doc_{}", doc_id));
    std::fs::create_dir_all(&doc_cache_dir).ok();

    let crop_filename = if !safe_hash.is_empty() {
        format!("p{}_occ{}_{}.webp", page_number, occ_id, safe_hash)
    } else {
        format!("p{}_occ{}.webp", page_number, occ_id)
    };

    let crop_path = doc_cache_dir.join(&crop_filename);
    if crop_path.exists() {
        return Some(crop_path);
    }

    // Vérifier aussi le format jpg historique si présent
    let crop_jpg = doc_cache_dir.join(crop_filename.replace(".webp", ".jpg"));
    if crop_jpg.exists() {
        return Some(crop_jpg);
    }

    // Génération à la volée (Lazy Crop)
    let mut stmt = match conn.prepare(
        "SELECT p.words_json, d.filename FROM pages p JOIN documents d ON d.id = p.doc_id WHERE p.doc_id = ?1 AND p.page_number = ?2",
    ) {
        Ok(s) => s,
        Err(_) => return None,
    };

    let row = stmt.query_row(params![doc_id, page_number], |r| {
        Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
    });

    let (words_json, filename) = match row {
        Ok(val) => val,
        Err(_) => return None,
    };

    let pdf_path = config.documents_dir.join(&filename);
    if !pdf_path.exists() {
        warn!("[Crop] Fichier PDF introuvable : {:?}", pdf_path);
        return None;
    }

    let words_data: Vec<serde_json::Value> = serde_json::from_str(&words_json).unwrap_or_default();
    let terms: Vec<String> = terms_str
        .split(',')
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect();

    let occs = find_occurrences_on_page(
        &words_data,
        &terms,
        safe_hash,
        doc_id,
        page_number,
        0.0,
        "",
        842.0,
    );

    let target_occ = occs.iter().find(|o| o.occ_id == occ_id).or_else(|| occs.first())?;

    let render_res = pdf_engine.render_crop(
        &pdf_path,
        page_number,
        target_occ.rect,
        &crop_path,
        &[target_occ.rect],
    );

    match render_res {
        Ok(_) => Some(crop_path),
        Err(e) => {
            warn!("[Crop] Échec génération vignette doc {} p{} : {}", doc_id, page_number, e);
            None
        }
    }
}

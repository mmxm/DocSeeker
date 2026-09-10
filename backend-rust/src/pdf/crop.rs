use std::path::PathBuf;
use regex::Regex;
use lazy_static::lazy_static;
use rusqlite::{params, Connection};
use tracing::warn;

use crate::config::Config;
use crate::search::engine::find_occurrences_on_page;
use super::engine::PdfEngine;

lazy_static! {
    static ref RE_HASH: Regex = Regex::new(r"^[a-f0-9]{1,32}$").unwrap();
}

/// Calcule les chemins attendus pour une vignette (.webp et .jpg historique)
pub fn compute_crop_path(
    config: &Config,
    doc_id: i64,
    page_number: i64,
    occ_id: usize,
    query_hash: &str,
) -> (PathBuf, PathBuf) {
    let safe_hash = if RE_HASH.is_match(query_hash.trim()) {
        query_hash.trim()
    } else {
        ""
    };
    let doc_cache_dir = config.cache_dir.join(format!("doc_{}", doc_id));
    let crop_filename = if !safe_hash.is_empty() {
        format!("p{}_occ{}_{}.webp", page_number, occ_id, safe_hash)
    } else {
        format!("p{}_occ{}.webp", page_number, occ_id)
    };
    let webp_path = doc_cache_dir.join(&crop_filename);
    let jpg_path = doc_cache_dir.join(crop_filename.replace(".webp", ".jpg"));
    (webp_path, jpg_path)
}

/// Génère toutes les vignettes des occurrences d'une page en une seule passe de rendu Pdfium
pub fn generate_crops_for_page(
    pdf_engine: &PdfEngine,
    config: &Config,
    doc_id: i64,
    page_number: i64,
    requested_occ_id: usize,
    query_hash: &str,
    terms_str: &str,
    words_json: &str,
    filename: &str,
) -> Option<PathBuf> {
    let safe_hash = if RE_HASH.is_match(query_hash.trim()) {
        query_hash.trim()
    } else {
        ""
    };

    let doc_cache_dir = config.cache_dir.join(format!("doc_{}", doc_id));
    std::fs::create_dir_all(&doc_cache_dir).ok();

    let pdf_path = config.documents_dir.join(filename);
    if !pdf_path.exists() {
        warn!("[Crop] Fichier PDF introuvable : {:?}", pdf_path);
        return None;
    }

    let words_data: Vec<serde_json::Value> = serde_json::from_str(words_json).unwrap_or_default();
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

    if occs.is_empty() {
        return None;
    }

    let mut target_crop_path = None;

    // Rendu groupé de TOUTES les occurrences de la page (économise les réouvertures/rendus du PDF)
    for occ in &occs {
        let occ_filename = if !safe_hash.is_empty() {
            format!("p{}_occ{}_{}.webp", page_number, occ.occ_id, safe_hash)
        } else {
            format!("p{}_occ{}.webp", page_number, occ.occ_id)
        };
        let occ_path = doc_cache_dir.join(&occ_filename);

        if !occ_path.exists() {
            let res = pdf_engine.render_crop(
                &pdf_path,
                page_number,
                occ.rect,
                &occ_path,
                &occ.highlight_rects,
            );
            if let Err(e) = res {
                warn!("[Crop] Échec génération vignette doc {} p{} occ {} : {}", doc_id, page_number, occ.occ_id, e);
            }
        }

        if occ.occ_id == requested_occ_id {
            target_crop_path = Some(occ_path);
        }
    }

    // Si l'occ_id demandé n'a pas été trouvé exactement, utiliser la première occurrence
    if target_crop_path.is_none() {
        if let Some(first_occ) = occs.first() {
            let occ_filename = if !safe_hash.is_empty() {
                format!("p{}_occ{}_{}.webp", page_number, first_occ.occ_id, safe_hash)
            } else {
                format!("p{}_occ{}.webp", page_number, first_occ.occ_id)
            };
            target_crop_path = Some(doc_cache_dir.join(&occ_filename));
        }
    }

    target_crop_path.filter(|p| p.exists())
}

/// Rétro-compatibilité : recherche en base et génération
#[allow(dead_code)]
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
    let (webp_path, jpg_path) = compute_crop_path(config, doc_id, page_number, occ_id, query_hash);
    if webp_path.exists() {
        return Some(webp_path);
    }
    if jpg_path.exists() {
        return Some(jpg_path);
    }

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

    generate_crops_for_page(
        pdf_engine,
        config,
        doc_id,
        page_number,
        occ_id,
        query_hash,
        terms_str,
        &words_json,
        &filename,
    )
}


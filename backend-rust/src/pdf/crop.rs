use std::path::PathBuf;
use regex::Regex;
use lazy_static::lazy_static;
use tracing::warn;

use crate::config::Config;
use crate::search::engine::find_occurrences_on_page;
use crate::search::types::WordEntry;
use super::engine::PdfEngine;

lazy_static! {
    static ref RE_HASH: Regex = Regex::new(r"^[a-f0-9]{1,32}$").unwrap();
}

/// Calcule le chemin attendu pour une vignette WebP
pub fn compute_crop_path(
    config: &Config,
    doc_id: i64,
    page_number: i64,
    occ_id: usize,
    query_hash: &str,
) -> PathBuf {
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
    doc_cache_dir.join(&crop_filename)
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

    let words_data: Vec<WordEntry> = serde_json::from_str(words_json).unwrap_or_default();
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

    let target_occ = occs.iter().find(|o| o.occ_id == requested_occ_id).or_else(|| occs.first());
    let target_occ = match target_occ {
        Some(o) => o,
        None => return None,
    };

    let target_filename = if !safe_hash.is_empty() {
        format!("p{}_occ{}_{}.webp", page_number, target_occ.occ_id, safe_hash)
    } else {
        format!("p{}_occ{}.webp", page_number, target_occ.occ_id)
    };
    let target_path = doc_cache_dir.join(&target_filename);

    // 1. FAST-PATH PRIORITAIRE : Rendu immédiat de l'occurrence demandée
    if !target_path.exists() {
        if let Err(e) = pdf_engine.render_crop(
            &pdf_path,
            page_number,
            target_occ.rect,
            &target_path,
            &target_occ.highlight_rects,
        ) {
            warn!("[Crop] Échec génération vignette doc {} p{} occ {} : {}", doc_id, page_number, target_occ.occ_id, e);
        }
    }

    if target_path.exists() {
        Some(target_path)
    } else {
        None
    }
}



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

/// Génère la vignette WebP d'une occurrence en mémoire (aucun cache disque).
/// Retourne les octets de l'image, ou None si l'occurrence est introuvable/illisible.
#[allow(clippy::too_many_arguments)]
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
) -> Option<Vec<u8>> {
    let safe_hash = if RE_HASH.is_match(query_hash.trim()) {
        query_hash.trim()
    } else {
        ""
    };

    let _ = config; // conservé pour compatibilité de signature (plus aucun chemin disque)
    let _ = (doc_id, safe_hash);

    let pdf_path = match crate::pdf::indexer::resolve_pdf_path(&config.documents_dir, filename) {
        Some(p) => p,
        None => {
            warn!("[Crop] Fichier PDF introuvable pour filename : {}", filename);
            return None;
        }
    };

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

    let target_occ = occs.iter().find(|o| o.occ_id == requested_occ_id).or_else(|| occs.first())?;

    match pdf_engine.render_crop(
        &pdf_path,
        page_number,
        target_occ.rect,
        &target_occ.highlight_rects,
    ) {
        Ok(bytes) if !bytes.is_empty() => Some(bytes),
        Ok(_) => None,
        Err(e) => {
            warn!("[Crop] Échec génération vignette doc {} p{} occ {} : {}", doc_id, page_number, target_occ.occ_id, e);
            None
        }
    }
}

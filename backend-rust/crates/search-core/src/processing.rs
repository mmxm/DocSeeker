use std::collections::HashMap;
use serde::{Deserialize, Serialize};

use crate::constants::{
    FONT_SIZE_BONUS_MAX, FONT_SIZE_BONUS_MULTIPLIER, FONT_SIZE_BONUS_THRESHOLD,
    MAX_OCCURRENCES_PER_DOC, MULTI_TERMS_ALL_MATCHED_BONUS, MULTI_TERMS_PARTIAL_MATCHED_BONUS,
};
use crate::matching::find_occurrences_on_page;
use crate::types::{DocumentSearchResult, OccurrenceResult, WordEntry};

/// Structure d'entrée représentant une ligne SQL brute renvoyée par la requête FTS5
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RawSqlSearchRow {
    pub doc_id: i64,
    pub filename: String,
    pub title: String,
    pub folder_id: Option<i64>,
    pub total_pages: i64,
    pub created_at: String,
    pub updated_at: String,
    pub doc_relevance_score: f64,
    pub matching_pages_count: i64,
    pub page_number: i64,
    pub words_json: String,
    pub page_bm25: f64,
    #[serde(default)]
    pub total_docs: usize,
    #[serde(default)]
    pub total_occurrences: usize,
}

/// Accumulateur interne pour la collecte des données d'un document
struct DocAccumulator {
    id: i64,
    filename: String,
    title: String,
    folder_id: Option<i64>,
    total_pages: i64,
    created_at: String,
    updated_at: String,
    base_relevance_score: f64,
    matching_pages_count: i64,
    occurrences: Vec<OccurrenceResult>,
}

/// Algorithme STRICTEMENT unifié de traitement, scoring et sélection des vignettes.
/// Exécuté à l'identique côté serveur Rust natif et côté client WebAssembly.
pub fn process_search_results(
    rows: &[RawSqlSearchRow],
    terms: &[String],
    query_hash: &str,
) -> Vec<DocumentSearchResult> {
    if rows.is_empty() {
        return Vec::new();
    }

    let encoded_terms = urlencoding::encode(&terms.join(",")).to_string();

    let mut doc_map: Vec<DocAccumulator> = Vec::new();
    let mut doc_index_map: HashMap<i64, usize> = HashMap::new();

    for row in rows {
        let idx = if let Some(&i) = doc_index_map.get(&row.doc_id) {
            i
        } else {
            let new_idx = doc_map.len();
            doc_index_map.insert(row.doc_id, new_idx);
            doc_map.push(DocAccumulator {
                id: row.doc_id,
                filename: row.filename.clone(),
                title: row.title.clone(),
                folder_id: row.folder_id,
                total_pages: row.total_pages,
                created_at: row.created_at.clone(),
                updated_at: row.updated_at.clone(),
                base_relevance_score: row.doc_relevance_score,
                matching_pages_count: row.matching_pages_count,
                occurrences: Vec::new(),
            });
            new_idx
        };

        if !row.words_json.trim().is_empty() && row.words_json != "[]" {
            let words_data: Vec<WordEntry> = serde_json::from_str(&row.words_json).unwrap_or_default();
            let page_occs = find_occurrences_on_page(
                &words_data,
                terms,
                query_hash,
                row.doc_id,
                row.page_number,
                row.page_bm25,
                &encoded_terms,
                842.0,
            );
            doc_map[idx].occurrences.extend(page_occs);
        }
    }

    let mut final_results = Vec::new();

    for mut doc in doc_map {
        // 1. Tri multi-critères rigoureux des occurrences :
        //    a) distinct_terms_count DESC (termes trouvés)
        //    b) font_size DESC (les grands titres de chapitre ressortent en priorité absolue !)
        //    c) bm25_score ASC (densité textuelle)
        //    d) page_number ASC (chronologie)
        doc.occurrences.sort_by(|a, b| {
            b.distinct_terms_count
                .cmp(&a.distinct_terms_count)
                .then_with(|| b.font_size.partial_cmp(&a.font_size).unwrap_or(std::cmp::Ordering::Equal))
                .then_with(|| a.bm25_score.partial_cmp(&b.bm25_score).unwrap_or(std::cmp::Ordering::Equal))
                .then_with(|| a.page_number.cmp(&b.page_number))
        });

        // 2. Raffinement du score Goodnotes
        let mut refined_score = doc.base_relevance_score;

        let best_font = doc.occurrences.iter().map(|o| o.font_size).fold(0.0, f64::max);
        if best_font > FONT_SIZE_BONUS_THRESHOLD {
            let font_bonus = ((best_font - FONT_SIZE_BONUS_THRESHOLD) * FONT_SIZE_BONUS_MULTIPLIER)
                .clamp(0.0, FONT_SIZE_BONUS_MAX);
            refined_score += font_bonus;
        }

        if terms.len() > 1 {
            let max_distinct = doc.occurrences.iter().map(|o| o.distinct_terms_count).max().unwrap_or(0);
            if max_distinct >= terms.len() {
                refined_score += MULTI_TERMS_ALL_MATCHED_BONUS;
            } else if max_distinct >= 2 {
                refined_score += (max_distinct as f64 / terms.len() as f64) * MULTI_TERMS_PARTIAL_MATCHED_BONUS;
            }
        }

        // 3. Tronquage à MAX_OCCURRENCES_PER_DOC (25)
        let mut ribbon_vignettes = doc.occurrences.clone();
        ribbon_vignettes.truncate(MAX_OCCURRENCES_PER_DOC);

        final_results.push(DocumentSearchResult {
            id: doc.id,
            filename: doc.filename,
            title: doc.title,
            folder_id: doc.folder_id,
            total_pages: doc.total_pages,
            created_at: doc.created_at,
            updated_at: doc.updated_at,
            cover_url: format!("/api/cover/{}", doc.id),
            vignettes: ribbon_vignettes.clone(),
            occurrences_by_page: ribbon_vignettes,
            total_occurrences: (doc.matching_pages_count as usize).max(doc.occurrences.len()),
            relevance_score: (refined_score * 100.0).round() / 100.0,
            matched_all_terms: true,
        });
    }

    // 4. Tri décroissant des documents par pertinence finale
    final_results.sort_by(|a, b| {
        b.relevance_score
            .partial_cmp(&a.relevance_score)
            .unwrap_or(std::cmp::Ordering::Equal)
    });

    final_results
}

/// Tri et pagination des occurrences au sein d'un document spécifique (Split View)
pub fn process_doc_search_results(
    mut occurrences: Vec<OccurrenceResult>,
    offset: Option<usize>,
    limit: Option<usize>,
) -> (usize, Vec<OccurrenceResult>) {
    let total = occurrences.len();

    if offset.is_some() || limit.is_some() {
        occurrences.sort_by(|a, b| {
            b.distinct_terms_count
                .cmp(&a.distinct_terms_count)
                .then_with(|| b.font_size.partial_cmp(&a.font_size).unwrap_or(std::cmp::Ordering::Equal))
                .then_with(|| a.bm25_score.partial_cmp(&b.bm25_score).unwrap_or(std::cmp::Ordering::Equal))
                .then_with(|| a.page_number.cmp(&b.page_number))
        });
        let off = offset.unwrap_or(0);
        let lim = limit.unwrap_or(25);
        let paged = occurrences.into_iter().skip(off).take(lim).collect();
        (total, paged)
    } else {
        occurrences.sort_by(|a, b| {
            a.page_number
                .cmp(&b.page_number)
                .then_with(|| a.occ_id.cmp(&b.occ_id))
        });
        (total, occurrences)
    }
}

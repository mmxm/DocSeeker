use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct OccurrenceResult {
    pub page_number: i64,
    pub occ_id: usize,
    pub crop_url: String,
    pub text_snippet: String,
    pub distinct_terms_count: usize,
    pub matched_terms: Vec<String>,
    pub y_ratio: f64,
    pub y_pos: f64,
    pub rect: [f64; 4],
    pub bm25_score: f64,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct DocumentSearchResult {
    pub id: i64,
    pub filename: String,
    pub title: String,
    pub folder_id: Option<i64>,
    pub total_pages: i64,
    pub created_at: String,
    pub updated_at: String,
    pub cover_url: String,
    pub vignettes: Vec<OccurrenceResult>,
    pub occurrences_by_page: Vec<OccurrenceResult>,
    pub total_occurrences: usize,
    pub relevance_score: f64,
    pub matched_all_terms: bool,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct SearchResponse {
    pub query: String,
    pub query_hash: String,
    pub total_documents: usize,
    pub total_occurrences: usize,
    pub results: Vec<DocumentSearchResult>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct DocSearchResponse {
    pub doc_id: i64,
    pub query: String,
    pub total_occurrences: usize,
    pub occurrences: Vec<OccurrenceResult>,
}

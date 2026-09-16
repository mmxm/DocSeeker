use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct WordEntry(pub f64, pub f64, pub f64, pub f64, pub String, pub i64, pub i64);

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
    #[serde(default)]
    pub highlight_rects: Vec<[f64; 4]>,
    pub bm25_score: f64,
    #[serde(default)]
    pub font_size: f64,
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
    #[serde(default)]
    pub page: usize,
    #[serde(default)]
    pub limit: usize,
    #[serde(default)]
    pub total_pages: usize,
    #[serde(default)]
    pub has_more: bool,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct DocSearchResponse {
    pub doc_id: i64,
    pub query: String,
    pub total_occurrences: usize,
    pub occurrences: Vec<OccurrenceResult>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct OfflineBundleDocument {
    pub id: i64,
    pub filename: String,
    pub title: String,
    pub file_hash: Option<String>,
    pub folder_id: Option<i64>,
    pub total_pages: i64,
    pub file_size: i64,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct OfflineBundlePage {
    pub page_number: i64,
    pub text_content: String,
    pub words: Vec<WordEntry>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct OfflineBundleResponse {
    pub document: OfflineBundleDocument,
    pub pages: Vec<OfflineBundlePage>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct CachedDocumentItem {
    pub id: i64,
    pub file_hash: Option<String>,
    pub updated_at: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct SyncCheckPayload {
    pub cached_documents: Vec<CachedDocumentItem>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct SyncCheckResponse {
    pub outdated_ids: Vec<i64>,
    pub deleted_ids: Vec<i64>,
    pub server_time: String,
}

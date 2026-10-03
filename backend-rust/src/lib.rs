pub mod auth;
pub mod config;
pub mod db;
pub mod document;
pub mod pdf;
pub mod pipeline;
pub mod routes;
pub mod search;
pub mod static_files;

use lru::LruCache;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};

pub use config::Config;
pub use db::DbPool;
pub use pdf::engine::PdfEngine;
pub use pipeline::IndexingPipeline;
pub use auth::rate_limit::LoginRateLimiter;
pub use search::types::SearchResponse;

/// Entrée du cache de résultats de recherche : (résultats, instant d'insertion)
pub type SearchCacheEntry = (SearchResponse, std::time::Instant);

pub const SEARCH_CACHE_TTL_SECS: u64 = 60;

pub struct AppState {
    pub config: Config,
    pub db: DbPool,
    pub pdf_engine: Arc<PdfEngine>,
    pub pipeline: Arc<IndexingPipeline>,
    pub rate_limiter: Arc<LoginRateLimiter>,
    pub crop_semaphore: Arc<tokio::sync::Semaphore>,
    pub crop_in_flight: Arc<Mutex<HashMap<String, Arc<tokio::sync::Notify>>>>,
    pub crop_cache: Arc<Mutex<LruCache<String, Vec<u8>>>>,
    /// Cache applicatif des résultats de recherche : clé = query_hash + offset + limit + filtre
    pub search_cache: Arc<Mutex<HashMap<String, SearchCacheEntry>>>,
}


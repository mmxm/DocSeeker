pub mod auth;
pub mod config;
pub mod db;
pub mod pdf;
pub mod pipeline;
pub mod routes;
pub mod search;
pub mod static_files;

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use rusqlite::Connection;

pub use config::Config;
pub use pdf::engine::PdfEngine;
pub use pipeline::IndexingPipeline;
pub use auth::rate_limit::LoginRateLimiter;
pub use search::types::SearchResponse;

pub struct AppState {
    pub config: Config,
    pub db: Arc<Mutex<Connection>>,
    pub pdf_engine: Arc<PdfEngine>,
    pub pipeline: Arc<IndexingPipeline>,
    pub rate_limiter: Arc<LoginRateLimiter>,
    pub crop_semaphore: Arc<tokio::sync::Semaphore>,
    pub crop_in_flight: Arc<Mutex<HashMap<String, Arc<tokio::sync::Notify>>>>,
}


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

/// Cache de vignettes shardé : 16 LruCache indépendants pour réduire la
/// contention Mutex lors des requêtes crop parallèles (375 → ~23 par shard).
const CROP_CACHE_SHARDS: usize = 16;
const CROP_CACHE_CAPACITY_PER_SHARD: usize = 200; // 16 × 200 = 3 200 entrées max

pub struct ShardedCropCache {
    shards: Vec<Mutex<LruCache<String, Vec<u8>>>>,
}

impl ShardedCropCache {
    pub fn new() -> Self {
        let shards = (0..CROP_CACHE_SHARDS)
            .map(|_| Mutex::new(LruCache::new(
                std::num::NonZeroUsize::new(CROP_CACHE_CAPACITY_PER_SHARD).unwrap()
            )))
            .collect();
        Self { shards }
    }

    fn shard_index(key: &str) -> usize {
        // FNV-1a simple pour la distribution des clés
        let mut hash: u64 = 14695981039346656037;
        for b in key.bytes() {
            hash ^= b as u64;
            hash = hash.wrapping_mul(1099511628211);
        }
        (hash as usize) % CROP_CACHE_SHARDS
    }

    pub fn get(&self, key: &str) -> Option<Vec<u8>> {
        let idx = Self::shard_index(key);
        let mut shard = self.shards[idx].lock().unwrap_or_else(|e| e.into_inner());
        shard.get(key).cloned()
    }

    pub fn put(&self, key: String, value: Vec<u8>) {
        let idx = Self::shard_index(&key);
        let mut shard = self.shards[idx].lock().unwrap_or_else(|e| e.into_inner());
        shard.put(key, value);
    }
}

impl Default for ShardedCropCache {
    fn default() -> Self { Self::new() }
}

pub struct AppState {
    pub config: Config,
    pub db: DbPool,
    pub pdf_engine: Arc<PdfEngine>,
    pub pipeline: Arc<IndexingPipeline>,
    pub rate_limiter: Arc<LoginRateLimiter>,
    pub crop_semaphore: Arc<tokio::sync::Semaphore>,
    pub crop_in_flight: Arc<Mutex<HashMap<String, Arc<tokio::sync::Notify>>>>,
    /// Cache de vignettes shardé : 16 LruCache pour réduire la contention Mutex
    pub crop_cache: Arc<ShardedCropCache>,
    /// Cache applicatif des résultats de recherche : clé = query_hash + offset + limit + filtre
    pub search_cache: Arc<Mutex<HashMap<String, SearchCacheEntry>>>,
}


use axum::{
    extract::{Query, State},
    http::StatusCode,
    response::{IntoResponse, Json, Response},
};
use serde::Deserialize;
use std::sync::Arc;

use crate::AppState;
use crate::search::engine::{search_documents, search_within_document};

#[derive(Deserialize)]
pub struct SearchQueryParams {
    pub q: Option<String>,
    pub titles_only: Option<bool>,
    pub folder_id: Option<i64>,
    pub limit: Option<usize>,
    pub offset: Option<usize>,
}

#[derive(Deserialize)]
pub struct DocSearchQueryParams {
    pub doc_id: i64,
    pub q: Option<String>,
}

pub async fn search_handler(
    State(state): State<Arc<AppState>>,
    Query(params): Query<SearchQueryParams>,
) -> Result<Json<serde_json::Value>, Response> {
    let query_str = params.q.unwrap_or_default();
    let titles_only = params.titles_only.unwrap_or(false);
    let limit = params.limit.unwrap_or(15);
    let offset = params.offset.unwrap_or(0);

    let cache_key = format!("{}:{}:{:?}:{}:{}", query_str.trim(), titles_only, params.folder_id, limit, offset);

    // 1. FAST-PATH: Vérification dans le cache LRU en RAM (< 0.1 ms)
    if let Ok(mut cache) = state.search_cache.lock() {
        if let Some(cached) = cache.get(&cache_key) {
            return Ok(Json(serde_json::to_value(cached).unwrap_or_default()));
        }
    }

    let search_res = {
        let conn = state.db.lock().map_err(|_| {
            (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": "DB lock error"}))).into_response()
        })?;

        search_documents(&conn, &query_str, titles_only, params.folder_id, Some(limit), Some(offset))
            .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": e.to_string()}))).into_response())?
    };

    // 2. Mise en cache LRU du résultat
    if let Ok(mut cache) = state.search_cache.lock() {
        cache.put(cache_key, search_res.clone());
    }

    Ok(Json(serde_json::to_value(search_res).unwrap_or_default()))
}

pub async fn doc_search_handler(
    State(state): State<Arc<AppState>>,
    Query(params): Query<DocSearchQueryParams>,
) -> Result<Json<serde_json::Value>, Response> {
    let query_str = params.q.unwrap_or_default();

    let conn = state.db.lock().map_err(|_| {
        (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": "DB lock error"}))).into_response()
    })?;

    let search_res = search_within_document(&conn, params.doc_id, &query_str)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": e.to_string()}))).into_response())?;

    Ok(Json(serde_json::to_value(search_res).unwrap_or_default()))
}

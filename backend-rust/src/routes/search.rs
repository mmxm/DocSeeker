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
    pub offset: Option<usize>,
    pub limit: Option<usize>,
}

pub async fn search_handler(
    State(state): State<Arc<AppState>>,
    Query(params): Query<SearchQueryParams>,
) -> Result<Json<serde_json::Value>, Response> {
    let query_str = params.q.unwrap_or_default();
    let titles_only = params.titles_only.unwrap_or(false);
    let limit = params.limit.unwrap_or(15);
    let offset = params.offset.unwrap_or(0);
    let folder_id = params.folder_id;

    // Clé de cache : combinaison unique de tous les paramètres de recherche
    let cache_key = format!(
        "{}|{}|{}|{}|{}",
        query_str,
        titles_only,
        folder_id.map_or(-1, |id| id),
        limit,
        offset
    );

    // 1. Vérifier le cache TTL (sans tenir le verrou pendant la requête SQL)
    {
        let mut cache = state.search_cache.lock().unwrap_or_else(|e| e.into_inner());
        let ttl = std::time::Duration::from_secs(crate::SEARCH_CACHE_TTL_SECS);
        cache.retain(|_, (_, ts)| ts.elapsed() < ttl);
        if let Some((cached_response, _)) = cache.get(&cache_key) {
            return Ok(Json(serde_json::to_value(cached_response).unwrap_or_default()));
        }
    }

    // 2. Exécuter la CTE SQLite dans un thread bloquant dédié
    //    pour ne pas monopoliser un thread du runtime Tokio async.
    let db = state.db.clone();
    let search_res = tokio::task::spawn_blocking(move || {
        let conn = db.get().map_err(|e| e.to_string())?;
        search_documents(&conn, &query_str, titles_only, folder_id, Some(limit), Some(offset))
            .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": e.to_string()}))).into_response())?
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": e}))).into_response())?;

    // 3. Stocker le résultat dans le cache
    {
        let mut cache = state.search_cache.lock().unwrap_or_else(|e| e.into_inner());
        cache.insert(cache_key, (search_res.clone(), std::time::Instant::now()));
    }

    Ok(Json(serde_json::to_value(search_res).unwrap_or_default()))
}

pub async fn doc_search_handler(
    State(state): State<Arc<AppState>>,
    Query(params): Query<DocSearchQueryParams>,
) -> Result<Json<serde_json::Value>, Response> {
    let query_str = params.q.unwrap_or_default();
    let doc_id = params.doc_id;
    let offset = params.offset;
    let limit = params.limit;

    // Exécuter la recherche interne au document dans un thread bloquant dédié
    let db = state.db.clone();
    let search_res = tokio::task::spawn_blocking(move || {
        let conn = db.get().map_err(|e| e.to_string())?;
        search_within_document(&conn, doc_id, &query_str, offset, limit)
            .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": e.to_string()}))).into_response())?
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": e}))).into_response())?;

    Ok(Json(serde_json::to_value(search_res).unwrap_or_default()))
}

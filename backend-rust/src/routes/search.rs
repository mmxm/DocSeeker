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

    let conn = state.db.lock().map_err(|_| {
        (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": "DB lock error"}))).into_response()
    })?;

    let search_res = search_documents(&conn, &query_str, titles_only, params.folder_id)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": e.to_string()}))).into_response())?;

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

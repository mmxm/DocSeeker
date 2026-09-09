use axum::{
    extract::{Multipart, Path, State},
    http::StatusCode,
    response::{IntoResponse, Json, Response},
};
use rusqlite::params;
use serde::Deserialize;
use std::sync::Arc;

use crate::AppState;

#[derive(Deserialize)]
pub struct AnnotationsPayload {
    pub annotations: serde_json::Value,
}

pub async fn get_annotations(
    State(state): State<Arc<AppState>>,
    Path(doc_id): Path<i64>,
) -> Result<Json<serde_json::Value>, Response> {
    let conn = state.db.lock().map_err(|_| {
        (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": "DB lock error"}))).into_response()
    })?;

    let json_str: Result<String, _> = conn.query_row(
        "SELECT annotations_json FROM document_annotations WHERE doc_id = ?1",
        params![doc_id],
        |r| r.get(0),
    );

    match json_str {
        Ok(str_val) => {
            let parsed: serde_json::Value = serde_json::from_str(&str_val).unwrap_or(serde_json::json!([]));
            Ok(Json(serde_json::json!({"doc_id": doc_id, "annotations": parsed})))
        }
        Err(_) => Ok(Json(serde_json::json!({"doc_id": doc_id, "annotations": []}))),
    }
}

pub async fn save_annotations(
    State(state): State<Arc<AppState>>,
    Path(doc_id): Path<i64>,
    Json(payload): Json<AnnotationsPayload>,
) -> Result<Json<serde_json::Value>, Response> {
    let conn = state.db.lock().map_err(|_| {
        (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": "DB lock error"}))).into_response()
    })?;

    let serialized = serde_json::to_string(&payload.annotations).unwrap_or_else(|_| "[]".to_string());

    conn.execute(
        "INSERT INTO document_annotations (doc_id, annotations_json, updated_at) \
         VALUES (?1, ?2, CURRENT_TIMESTAMP) \
         ON CONFLICT(doc_id) DO UPDATE SET annotations_json = excluded.annotations_json, updated_at = CURRENT_TIMESTAMP",
        params![doc_id, serialized],
    ).map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": e.to_string()}))).into_response())?;

    Ok(Json(serde_json::json!({"status": "ok", "doc_id": doc_id})))
}

pub async fn save_pdf(
    State(state): State<Arc<AppState>>,
    Path(doc_id): Path<i64>,
    mut multipart: Multipart,
) -> Result<Json<serde_json::Value>, Response> {
    let filename: Option<String> = {
        let conn = state.db.lock().map_err(|_| {
            (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": "DB lock error"}))).into_response()
        })?;
        conn.query_row("SELECT filename FROM documents WHERE id = ?1", params![doc_id], |r| r.get(0)).ok()
    };

    let fname = match filename {
        Some(f) => f,
        None => return Err((StatusCode::NOT_FOUND, Json(serde_json::json!({"error": "Document introuvable"}))).into_response()),
    };

    let mut pdf_bytes = Vec::new();
    while let Ok(Some(field)) = multipart.next_field().await {
        if field.name() == Some("file") {
            if let Ok(bytes) = field.bytes().await {
                pdf_bytes = bytes.to_vec();
            }
        }
    }

    if pdf_bytes.is_empty() {
        return Err((StatusCode::BAD_REQUEST, Json(serde_json::json!({"error": "Contenu PDF vide"}))).into_response());
    }

    let pdf_path = state.config.documents_dir.join(&fname);
    if let Err(e) = std::fs::write(&pdf_path, &pdf_bytes) {
        return Err((StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": format!("Échec d'écriture : {}", e)}))).into_response());
    }

    // Réindexer en tâche de fond pour mettre à jour le hash, pages et FTS
    state.pipeline.enqueue(doc_id);

    Ok(Json(serde_json::json!({
        "status": "ok",
        "doc_id": doc_id,
        "message": "Fichier PDF mis à jour avec succès et réindexation planifiée"
    })))
}

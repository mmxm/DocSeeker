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
    State(_state): State<Arc<AppState>>,
    Path(doc_id): Path<i64>,
) -> Result<Json<serde_json::Value>, Response> {
    Ok(Json(serde_json::json!({"doc_id": doc_id, "annotations": []})))
}

pub async fn save_annotations(
    State(_state): State<Arc<AppState>>,
    Path(doc_id): Path<i64>,
    Json(_payload): Json<AnnotationsPayload>,
) -> Result<Json<serde_json::Value>, Response> {
    Ok(Json(serde_json::json!({"status": "ok", "doc_id": doc_id})))
}

pub async fn save_pdf(
    State(state): State<Arc<AppState>>,
    Path(doc_id): Path<i64>,
    mut multipart: Multipart,
) -> Result<Json<serde_json::Value>, Response> {
    let filename: Option<String> = {
        let conn = state.db.get().map_err(|_| {
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

    let pdf_path = crate::pdf::indexer::resolve_pdf_path(&state.config.documents_dir, &fname)
        .unwrap_or_else(|| state.config.documents_dir.join(&fname));
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

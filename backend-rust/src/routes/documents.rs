use axum::{
    extract::{Multipart, Path, Query, State},
    http::StatusCode,
    response::{IntoResponse, Json, Response},
};
use rusqlite::params;
use serde::{Deserialize, Serialize};
use sha2::Digest;
use std::sync::Arc;
use unicode_normalization::UnicodeNormalization;

use crate::AppState;
use crate::pdf::indexer::{remove_document, scan_and_sync_documents};

#[derive(Serialize)]
pub struct DocumentListItem {
    pub id: i64,
    pub filename: String,
    pub title: String,
    pub folder_id: Option<i64>,
    pub status: String,
    pub error_message: Option<String>,
    pub total_pages: i64,
    pub file_size: i64,
    pub created_at: String,
    pub updated_at: String,
    pub cover_url: String,
}

#[derive(Deserialize)]
pub struct DocumentListQuery {
    pub folder_id: Option<String>,
    pub status: Option<String>,
}

#[derive(Deserialize)]
pub struct MoveDocumentPayload {
    pub folder_id: Option<i64>,
}

#[derive(Deserialize)]
pub struct BatchMovePayload {
    pub doc_ids: Vec<i64>,
    pub folder_id: Option<i64>,
}

#[derive(Deserialize)]
pub struct UpdateDocumentPayload {
    pub title: Option<String>,
}

pub async fn list_documents(
    State(state): State<Arc<AppState>>,
    Query(query): Query<DocumentListQuery>,
) -> Result<Json<serde_json::Value>, Response> {
    let conn = state.db.lock().map_err(|_| {
        (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": "DB lock error"}))).into_response()
    })?;

    let sql = match query.folder_id.as_deref() {
        Some("root") => {
            "SELECT id, filename, title, folder_id, COALESCE(status, 'ready'), error_message, total_pages, file_size, created_at, COALESCE(updated_at, created_at) \
             FROM documents WHERE folder_id IS NULL ORDER BY title ASC"
        }
        Some(fid) if fid.parse::<i64>().is_ok() => {
            "SELECT id, filename, title, folder_id, COALESCE(status, 'ready'), error_message, total_pages, file_size, created_at, COALESCE(updated_at, created_at) \
             FROM documents WHERE folder_id = ?1 ORDER BY title ASC"
        }
        _ => {
            "SELECT id, filename, title, folder_id, COALESCE(status, 'ready'), error_message, total_pages, file_size, created_at, COALESCE(updated_at, created_at) \
             FROM documents ORDER BY title ASC"
        }
    };

    let mut stmt = conn.prepare(sql).map_err(|e| {
        (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": e.to_string()}))).into_response()
    })?;

    let rows = if let Some(fid) = query.folder_id.as_deref() {
        if let Ok(id_num) = fid.parse::<i64>() {
            stmt.query_map(params![id_num], map_doc_row)
        } else {
            stmt.query_map([], map_doc_row)
        }
    } else {
        stmt.query_map([], map_doc_row)
    };

    let mut docs: Vec<DocumentListItem> = rows
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": e.to_string()}))).into_response())?
        .flatten()
        .collect();

    if let Some(ref st) = query.status {
        docs.retain(|d| &d.status == st);
    }

    let total = docs.len();
    Ok(Json(serde_json::json!({
        "documents": docs,
        "total": total
    })))
}

fn map_doc_row(row: &rusqlite::Row) -> rusqlite::Result<DocumentListItem> {
    let id: i64 = row.get(0)?;
    Ok(DocumentListItem {
        id,
        filename: row.get(1)?,
        title: row.get::<_, Option<String>>(2)?.unwrap_or_default(),
        folder_id: row.get(3)?,
        status: row.get(4)?,
        error_message: row.get(5)?,
        total_pages: row.get(6)?,
        file_size: row.get(7)?,
        created_at: row.get(8)?,
        updated_at: row.get(9)?,
        cover_url: format!("/api/cover/{}", id),
    })
}

pub async fn get_document_status(
    State(state): State<Arc<AppState>>,
    Path(doc_id): Path<i64>,
) -> Result<Json<serde_json::Value>, Response> {
    let conn = state.db.lock().map_err(|_| {
        (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": "DB lock error"}))).into_response()
    })?;

    let res = conn.query_row(
        "SELECT id, filename, title, status, error_message, total_pages FROM documents WHERE id = ?1",
        params![doc_id],
        |r| {
            Ok(serde_json::json!({
                "id": r.get::<_, i64>(0)?,
                "filename": r.get::<_, String>(1)?,
                "title": r.get::<_, Option<String>>(2)?.unwrap_or_default(),
                "status": r.get::<_, Option<String>>(3)?.unwrap_or_else(|| "ready".to_string()),
                "error_message": r.get::<_, Option<String>>(4)?,
                "total_pages": r.get::<_, i64>(5)?,
            }))
        },
    );

    match res {
        Ok(json) => Ok(Json(json)),
        Err(_) => Err((StatusCode::NOT_FOUND, Json(serde_json::json!({"error": "Document introuvable"}))).into_response()),
    }
}

pub async fn update_document(
    State(state): State<Arc<AppState>>,
    Path(doc_id): Path<i64>,
    Json(payload): Json<UpdateDocumentPayload>,
) -> Result<Json<serde_json::Value>, Response> {
    let conn = state.db.lock().map_err(|_| {
        (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": "DB lock error"}))).into_response()
    })?;

    if let Some(ref title) = payload.title {
        let clean_title: String = title.trim().nfc().collect();
        conn.execute(
            "UPDATE documents SET title = ?1, updated_at = CURRENT_TIMESTAMP WHERE id = ?2",
            params![clean_title, doc_id],
        ).ok();
    }

    Ok(Json(serde_json::json!({"status": "ok"})))
}

pub async fn move_document(
    State(state): State<Arc<AppState>>,
    Path(doc_id): Path<i64>,
    Json(payload): Json<MoveDocumentPayload>,
) -> Result<Json<serde_json::Value>, Response> {
    let conn = state.db.lock().map_err(|_| {
        (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": "DB lock error"}))).into_response()
    })?;

    conn.execute(
        "UPDATE documents SET folder_id = ?1, updated_at = CURRENT_TIMESTAMP WHERE id = ?2",
        params![payload.folder_id, doc_id],
    ).map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": e.to_string()}))).into_response())?;

    Ok(Json(serde_json::json!({"status": "ok", "doc_id": doc_id, "folder_id": payload.folder_id})))
}

pub async fn batch_move_documents(
    State(state): State<Arc<AppState>>,
    Json(payload): Json<BatchMovePayload>,
) -> Result<Json<serde_json::Value>, Response> {
    let conn = state.db.lock().map_err(|_| {
        (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": "DB lock error"}))).into_response()
    })?;

    for id in &payload.doc_ids {
        let _ = conn.execute(
            "UPDATE documents SET folder_id = ?1, updated_at = CURRENT_TIMESTAMP WHERE id = ?2",
            params![payload.folder_id, id],
        );
    }

    Ok(Json(serde_json::json!({"status": "ok", "moved_count": payload.doc_ids.len()})))
}

pub async fn delete_document_handler(
    State(state): State<Arc<AppState>>,
    Path(doc_id): Path<i64>,
) -> Result<Json<serde_json::Value>, Response> {
    let conn = state.db.lock().map_err(|_| {
        (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": "DB lock error"}))).into_response()
    })?;

    match remove_document(&conn, &state.config, doc_id) {
        Ok(true) => {
            if let Ok(mut cache) = state.search_cache.lock() {
                cache.clear();
            }
            Ok(Json(serde_json::json!({"status": "ok", "deleted_id": doc_id})))
        }
        Ok(false) => Err((StatusCode::NOT_FOUND, Json(serde_json::json!({"error": "Document introuvable"}))).into_response()),
        Err(e) => Err((StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": e}))).into_response()),
    }
}

pub async fn check_hash(
    State(state): State<Arc<AppState>>,
    Path(file_hash): Path<String>,
) -> Result<Json<serde_json::Value>, Response> {
    let conn = state.db.lock().map_err(|_| {
        (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": "DB lock error"}))).into_response()
    })?;

    let res = conn.query_row(
        "SELECT id, filename, title, created_at FROM documents WHERE file_hash = ?1",
        params![file_hash],
        |r| {
            Ok(serde_json::json!({
                "exists": true,
                "existing_doc": {
                    "id": r.get::<_, i64>(0)?,
                    "filename": r.get::<_, String>(1)?,
                    "title": r.get::<_, Option<String>>(2)?.unwrap_or_default(),
                    "created_at": r.get::<_, String>(3)?,
                }
            }))
        },
    );

    match res {
        Ok(json) => Ok(Json(json)),
        Err(_) => Ok(Json(serde_json::json!({
            "exists": false,
            "existing_doc": null
        }))),
    }
}

pub async fn upload_document(
    State(state): State<Arc<AppState>>,
    mut multipart: Multipart,
) -> Result<Json<serde_json::Value>, Response> {
    let mut uploaded_filename = String::new();
    let mut custom_title: Option<String> = None;
    let mut target_folder_id: Option<i64> = None;
    let mut file_bytes: Vec<u8> = Vec::new();

    while let Ok(Some(field)) = multipart.next_field().await {
        let field_name = field.name().unwrap_or("").to_string();
        if field_name == "file" {
            if let Some(fname) = field.file_name() {
                uploaded_filename = fname.to_string();
            }
            if let Ok(bytes) = field.bytes().await {
                file_bytes = bytes.to_vec();
            }
        } else if field_name == "title" {
            if let Ok(text) = field.text().await {
                let trimmed = text.trim().to_string();
                if !trimmed.is_empty() {
                    custom_title = Some(trimmed);
                }
            }
        } else if field_name == "folder_id" {
            if let Ok(text) = field.text().await {
                target_folder_id = text.trim().parse::<i64>().ok();
            }
        }
    }

    if uploaded_filename.is_empty() || file_bytes.is_empty() {
        return Err((StatusCode::BAD_REQUEST, Json(serde_json::json!({"error": "Fichier PDF manquant ou vide"}))).into_response());
    }

    if !uploaded_filename.to_lowercase().ends_with(".pdf") {
        return Err((StatusCode::BAD_REQUEST, Json(serde_json::json!({"error": "Seuls les fichiers PDF sont acceptés"}))).into_response());
    }

    // Validation signature magique PDF
    if file_bytes.len() < 5 || !file_bytes.starts_with(b"%PDF-") {
        return Err((StatusCode::BAD_REQUEST, Json(serde_json::json!({"error": "Format invalide : signature PDF manquante"}))).into_response());
    }

    // Calcul de l'empreinte SHA-256
    let mut hasher = sha2::Sha256::new();
    sha2::Digest::update(&mut hasher, &file_bytes);
    let file_hash = hex::encode(sha2::Digest::finalize(hasher));
    let file_size = file_bytes.len() as i64;

    // Détection stricte de doublon
    {
        let conn = state.db.lock().map_err(|_| {
            (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": "DB lock error"}))).into_response()
        })?;

        let duplicate: Option<(i64, String, Option<String>, String)> = conn
            .query_row(
                "SELECT id, filename, title, created_at FROM documents WHERE file_hash = ?1",
                params![file_hash],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
            )
            .ok();

        if let Some((dup_id, dup_fname, dup_title, dup_created)) = duplicate {
            return Err((
                StatusCode::CONFLICT,
                Json(serde_json::json!({
                    "error": "duplicate",
                    "message": "Un document strictement identique existe déjà dans la base.",
                    "existing_doc": {
                        "id": dup_id,
                        "filename": dup_fname,
                        "title": dup_title.unwrap_or_default(),
                        "created_at": dup_created
                    }
                })),
            ).into_response());
        }
    }

    let norm_filename: String = uploaded_filename.nfc().collect();
    let dest_path = state.config.documents_dir.join(&norm_filename);

    // Écriture du fichier sur disque
    std::fs::create_dir_all(&state.config.documents_dir).ok();
    if let Err(e) = std::fs::write(&dest_path, &file_bytes) {
        return Err((StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": format!("Échec d'écriture du fichier : {}", e)}))).into_response());
    }

    // Insertion immédiate en DB en état 'pending' pour retour instantané
    let doc_id = {
        let conn = state.db.lock().map_err(|_| {
            (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": "DB lock error"}))).into_response()
        })?;

        let clean_title = custom_title.clone().unwrap_or_else(|| {
            let stem = std::path::Path::new(&norm_filename)
                .file_stem()
                .and_then(|s| s.to_str())
                .unwrap_or(&norm_filename);
            stem.replace('_', " ").trim().to_string()
        });

        let existing: Option<i64> = conn
            .query_row("SELECT id FROM documents WHERE filename = ?1", params![norm_filename], |r| r.get(0))
            .ok();

        if let Some(id) = existing {
            conn.execute(
                "UPDATE documents SET title = ?1, file_hash = ?2, file_size = ?3, status = 'pending', folder_id = ?4, error_message = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?5",
                params![clean_title, file_hash, file_size, target_folder_id, id],
            ).ok();
            id
        } else {
            conn.execute(
                "INSERT INTO documents (filename, title, file_hash, file_size, status, folder_id) VALUES (?1, ?2, ?3, ?4, 'pending', ?5)",
                params![norm_filename, clean_title, file_hash, file_size, target_folder_id],
            ).ok();
            conn.last_insert_rowid()
        }
    };

    // Envoi dans la queue d'indexation d'arrière-plan
    state.pipeline.enqueue(doc_id);

    Ok(Json(serde_json::json!({
        "status": "queued",
        "doc_id": doc_id,
        "filename": norm_filename,
        "title": custom_title.unwrap_or(norm_filename)
    })))
}

pub async fn reindex_document(
    State(state): State<Arc<AppState>>,
    Path(doc_id): Path<i64>,
) -> Result<Json<serde_json::Value>, Response> {
    state.pipeline.enqueue(doc_id);
    if let Ok(mut cache) = state.search_cache.lock() {
        cache.clear();
    }
    Ok(Json(serde_json::json!({"status": "queued", "doc_id": doc_id})))
}

pub async fn sync_documents_handler(
    State(state): State<Arc<AppState>>,
) -> Result<Json<serde_json::Value>, Response> {
    let (added_count, added_files) = {
        let conn = state.db.lock().map_err(|_| {
            (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": "DB lock error"}))).into_response()
        })?;
        let (added_count, added_files) = scan_and_sync_documents(&conn, &state.pdf_engine, &state.config);
        if added_count > 0 {
            if let Ok(mut cache) = state.search_cache.lock() {
                cache.clear();
            }
        }
        (added_count, added_files)
    };

    Ok(Json(serde_json::json!({
        "added": added_count,
        "indexed_files": added_files
    })))
}

pub async fn get_pipeline_status(
    State(state): State<Arc<AppState>>,
) -> Json<serde_json::Value> {
    Json(state.pipeline.get_status())
}

pub async fn retry_failed_pipeline(
    State(state): State<Arc<AppState>>,
) -> Json<serde_json::Value> {
    let retried = state.pipeline.retry_failed();
    Json(serde_json::json!({"retried_count": retried}))
}

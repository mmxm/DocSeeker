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

    loop {
        match multipart.next_field().await {
            Ok(Some(field)) => {
                let field_name = field.name().unwrap_or("").to_string();
                if field_name == "file" {
                    if let Some(fname) = field.file_name() {
                        uploaded_filename = fname.to_string();
                    }
                    match field.bytes().await {
                        Ok(bytes) => file_bytes = bytes.to_vec(),
                        Err(e) => {
                            return Err((
                                StatusCode::BAD_REQUEST,
                                Json(serde_json::json!({
                                    "error": format!("Erreur lors de la lecture du fichier : {}", e)
                                })),
                            ).into_response());
                        }
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
            Ok(None) => break,
            Err(e) => {
                return Err((
                    StatusCode::BAD_REQUEST,
                    Json(serde_json::json!({
                        "error": format!("Erreur de transmission multipart : {}", e)
                    })),
                ).into_response());
            }
        }
    }

    if uploaded_filename.is_empty() || file_bytes.is_empty() {
        return Err((StatusCode::BAD_REQUEST, Json(serde_json::json!({"error": "Fichier PDF manquant ou vide"}))).into_response());
    }

    if !uploaded_filename.to_lowercase().ends_with(".pdf") {
        return Err((StatusCode::BAD_REQUEST, Json(serde_json::json!({"error": "Seuls les fichiers PDF sont acceptés"}))).into_response());
    }

    // Validation signature magique PDF (conforme ISO 32000-1 §7.5.2 : %PDF- dans les 1024 premiers octets)
    let header_window = &file_bytes[..file_bytes.len().min(1024)];
    let has_pdf_magic = header_window.windows(5).any(|w| w == b"%PDF-");
    if !has_pdf_magic {
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
    Ok(Json(serde_json::json!({"status": "queued", "doc_id": doc_id})))
}

pub async fn sync_documents_handler(
    State(state): State<Arc<AppState>>,
) -> Result<Json<serde_json::Value>, Response> {
    let retried = state.pipeline.retry_failed();
    let (added_count, added_files) = {
        let conn = state.db.lock().map_err(|_| {
            (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": "DB lock error"}))).into_response()
        })?;
        let (added_count, added_files) = scan_and_sync_documents(&conn, &state.pdf_engine, &state.config);
        (added_count, added_files)
    };

    Ok(Json(serde_json::json!({
        "added": added_count,
        "retried": retried,
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

// -----------------------------------------------------------------------------
// DTOs & Endpoints pour le Mode Hors-Ligne & Synchronisation Résiliente
// -----------------------------------------------------------------------------

#[derive(Serialize)]
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

#[derive(Serialize)]
pub struct OfflineBundlePage {
    pub page_number: i64,
    pub text_content: String,
    pub words: Vec<crate::search::types::WordEntry>,
}

#[derive(Serialize)]
pub struct OfflineBundleResponse {
    pub document: OfflineBundleDocument,
    pub pages: Vec<OfflineBundlePage>,
}

#[derive(Deserialize)]
pub struct CachedDocumentItem {
    pub id: i64,
    pub file_hash: Option<String>,
    pub updated_at: Option<String>,
}

#[derive(Deserialize)]
pub struct SyncCheckPayload {
    pub cached_documents: Vec<CachedDocumentItem>,
}

#[derive(Serialize)]
pub struct SyncCheckResponse {
    pub outdated_ids: Vec<i64>,
    pub deleted_ids: Vec<i64>,
    pub server_time: String,
}

/// GET /api/documents/{id}/offline-bundle
/// Exporte tout le matériel textuel et spatial d'un document pour alimentation du cache local
pub async fn get_offline_bundle(
    State(state): State<Arc<AppState>>,
    Path(doc_id): Path<i64>,
) -> Result<Json<OfflineBundleResponse>, Response> {
    let conn = state.db.lock().map_err(|_| {
        (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": "DB lock error"}))).into_response()
    })?;

    // 1. Récupération des métadonnées du document
    let mut stmt_doc = conn.prepare(
        "SELECT id, filename, title, file_hash, folder_id, total_pages, file_size, created_at, COALESCE(updated_at, created_at) \
         FROM documents WHERE id = ?1 AND COALESCE(status, 'ready') = 'ready'"
    ).map_err(|e| {
        (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": e.to_string()}))).into_response()
    })?;

    let document = stmt_doc.query_row(params![doc_id], |row| {
        Ok(OfflineBundleDocument {
            id: row.get(0)?,
            filename: row.get(1)?,
            title: row.get(2)?,
            file_hash: row.get(3)?,
            folder_id: row.get(4)?,
            total_pages: row.get(5)?,
            file_size: row.get(6)?,
            created_at: row.get(7)?,
            updated_at: row.get(8)?,
        })
    }).map_err(|_| {
        (StatusCode::NOT_FOUND, Json(serde_json::json!({"error": "Document introuvable ou non prêt"}))).into_response()
    })?;

    // 2. Récupération des pages et désérialisation propre du tableau spatial words
    let mut stmt_pages = conn.prepare(
        "SELECT page_number, text_content, words_json FROM pages WHERE doc_id = ?1 ORDER BY page_number ASC"
    ).map_err(|e| {
        (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": e.to_string()}))).into_response()
    })?;

    let pages_iter = stmt_pages.query_map(params![doc_id], |row| {
        let page_number: i64 = row.get(0)?;
        let text_content: String = row.get::<_, Option<String>>(1)?.unwrap_or_default();
        let words_raw: Option<String> = row.get(2)?;
        let words: Vec<crate::search::types::WordEntry> = words_raw
            .and_then(|json_str| serde_json::from_str(&json_str).ok())
            .unwrap_or_default();

        Ok(OfflineBundlePage {
            page_number,
            text_content,
            words,
        })
    }).map_err(|e| {
        (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": e.to_string()}))).into_response()
    })?;

    let pages: Vec<OfflineBundlePage> = pages_iter.flatten().collect();

    Ok(Json(OfflineBundleResponse {
        document,
        pages,
    }))
}

/// POST /api/sync/check
/// Vérifie la fraîcheur des documents en cache selon la stratégie Last-Write-Wins
pub async fn sync_check_handler(
    State(state): State<Arc<AppState>>,
    Json(payload): Json<SyncCheckPayload>,
) -> Result<Json<SyncCheckResponse>, Response> {
    let conn = state.db.lock().map_err(|_| {
        (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": "DB lock error"}))).into_response()
    })?;

    let mut outdated_ids = Vec::new();
    let mut deleted_ids = Vec::new();

    let mut stmt = conn.prepare(
        "SELECT file_hash, COALESCE(updated_at, created_at), COALESCE(status, 'ready') FROM documents WHERE id = ?1"
    ).map_err(|e| {
        (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": e.to_string()}))).into_response()
    })?;

    for cached_doc in payload.cached_documents {
        let row_res = stmt.query_row(params![cached_doc.id], |row| {
            let hash: Option<String> = row.get(0)?;
            let updated_at: String = row.get(1)?;
            let status: String = row.get(2)?;
            Ok((hash, updated_at, status))
        });

        match row_res {
            Ok((server_hash, server_updated_at, status)) => {
                if status != "ready" {
                    deleted_ids.push(cached_doc.id);
                } else {
                    let hash_changed = match (&server_hash, &cached_doc.file_hash) {
                        (Some(s), Some(c)) => s != c,
                        (Some(_), None) => true,
                        (None, Some(_)) => true,
                        (None, None) => false,
                    };
                    let time_changed = match &cached_doc.updated_at {
                        Some(c_time) => &server_updated_at > c_time,
                        None => true,
                    };

                    if hash_changed || time_changed {
                        outdated_ids.push(cached_doc.id);
                    }
                }
            }
            Err(rusqlite::Error::QueryReturnedNoRows) => {
                deleted_ids.push(cached_doc.id);
            }
            Err(e) => {
                tracing::warn!("[Sync Check] Erreur lecture document {}: {}", cached_doc.id, e);
            }
        }
    }

    let server_time = chrono::Utc::now().to_rfc3339();

    Ok(Json(SyncCheckResponse {
        outdated_ids,
        deleted_ids,
        server_time,
    }))
}


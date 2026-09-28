use axum::{
    body::Bytes,
    extract::{Multipart, Path, State},
    http::{header, StatusCode},
    response::{IntoResponse, Json, Response},
};
use rusqlite::params;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use std::sync::Arc;

use crate::AppState;
use crate::document::processor::detect_doc_type;
use crate::document::scanner::rebuild_database_from_filesystem;
use crate::document::sync::{compute_sync_plan, SyncManifestRequest};
use crate::document::trash::{
    list_trash, permanently_delete_trash_item, resolve_file_path, restore_from_trash, soft_delete,
};

#[derive(Deserialize)]
pub struct CreateFilePayload {
    pub filename: String,
    #[serde(default)]
    pub content: String,
}

#[derive(Serialize)]
pub struct FileOperationResponse {
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub filename: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub doc_id: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

/// GET /api/files/*filename : Lecture brute d'un fichier (PDF ou Markdown)
pub async fn get_file_handler(
    State(state): State<Arc<AppState>>,
    Path(filename): Path<String>,
) -> Response {
    let clean_fname = filename.trim_start_matches('/');
    let file_path = match resolve_file_path(&state.config.documents_dir, clean_fname) {
        Some(p) => p,
        None => {
            return (
                StatusCode::NOT_FOUND,
                Json(serde_json::json!({"error": format!("Fichier introuvable : {}", clean_fname)})),
            )
                .into_response();
        }
    };

    let bytes = match fs::read(&file_path) {
        Ok(b) => b,
        Err(e) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({"error": format!("Impossible de lire le fichier : {}", e)})),
            )
                .into_response();
        }
    };

    let doc_type = detect_doc_type(&file_path);
    let content_type = match doc_type {
        "markdown" => "text/markdown; charset=utf-8",
        "text" => "text/plain; charset=utf-8",
        _ => "application/pdf",
    };

    (
        StatusCode::OK,
        [
            (header::CONTENT_TYPE, content_type),
            (
                header::CONTENT_DISPOSITION,
                &format!("inline; filename=\"{}\"", file_path.file_name().and_then(|s| s.to_str()).unwrap_or("document")),
            ),
        ],
        bytes,
    )
        .into_response()
}

/// PUT /api/files/*filename : Écriture atomique (sauvegarde note MD ou push PDF)
pub async fn save_file_handler(
    State(state): State<Arc<AppState>>,
    Path(filename): Path<String>,
    body: Bytes,
) -> Response {
    let clean_fname = filename.trim_start_matches('/');
    if clean_fname.contains("..") {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({"error": "Chemin non sécurisé (tentative de traversal)"})),
        )
            .into_response();
    }

    let target_path = state.config.documents_dir.join(clean_fname);
    if let Some(parent) = target_path.parent() {
        if let Err(e) = fs::create_dir_all(parent) {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({"error": format!("Impossible de créer le dossier parent : {}", e)})),
            )
                .into_response();
        }
    }

    // Écriture atomique via un fichier temporaire .tmp
    let tmp_path = target_path.with_extension("tmp_save");
    if let Err(e) = fs::write(&tmp_path, &body) {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"error": format!("Erreur d'écriture du fichier temporaire : {}", e)})),
        )
            .into_response();
    }

    if let Err(e) = fs::rename(&tmp_path, &target_path) {
        let _ = fs::remove_file(&tmp_path);
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"error": format!("Erreur lors du déplacement atomique : {}", e)})),
        )
            .into_response();
    }

    // Déclencher l'indexation
    let doc_id = match state.db.get() {
        Ok(conn) => {
            let doc_type = detect_doc_type(&target_path);
            let existing_id: Option<i64> = conn
                .query_row(
                    "SELECT id FROM documents WHERE filename = ?1",
                    params![clean_fname],
                    |r| r.get(0),
                )
                .ok();

            match existing_id {
                Some(id) => {
                    let _ = conn.execute(
                        "UPDATE documents SET status = 'pending', updated_at = CURRENT_TIMESTAMP WHERE id = ?1",
                        params![id],
                    );
                    state.pipeline.enqueue(id);
                    id
                }
                None => {
                    let stem = target_path
                        .file_stem()
                        .and_then(|s| s.to_str())
                        .unwrap_or(clean_fname)
                        .replace('_', " ");
                    let file_size = body.len() as i64;
                    let insert_res = conn.execute(
                        "INSERT INTO documents (filename, title, file_size, doc_type, status) VALUES (?1, ?2, ?3, ?4, 'pending')",
                        params![clean_fname, stem, file_size, doc_type],
                    );
                    if insert_res.is_ok() {
                        let new_id = conn.last_insert_rowid();
                        state.pipeline.enqueue(new_id);
                        new_id
                    } else {
                        0
                    }
                }
            }
        }
        Err(_) => 0,
    };

    (
        StatusCode::OK,
        Json(FileOperationResponse {
            status: "ok".to_string(),
            filename: Some(clean_fname.to_string()),
            doc_id: if doc_id > 0 { Some(doc_id) } else { None },
            message: Some("Fichier sauvegardé avec succès".to_string()),
        }),
    )
        .into_response()
}

/// POST /api/files : Création d'une nouvelle note Markdown
pub async fn create_file_handler(
    State(state): State<Arc<AppState>>,
    Json(payload): Json<CreateFilePayload>,
) -> Response {
    let mut fname = payload.filename.trim().to_string();
    if fname.is_empty() {
        fname = "Nouvelle note.md".to_string();
    }
    if !fname.ends_with(".md") && !fname.ends_with(".markdown") {
        fname.push_str(".md");
    }

    if fname.contains("..") {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({"error": "Chemin invalide"})),
        )
            .into_response();
    }

    let target_path = state.config.documents_dir.join(&fname);
    if target_path.exists() {
        return (
            StatusCode::CONFLICT,
            Json(serde_json::json!({
                "error": format!("Un fichier portant le nom '{}' existe déjà. Choisissez un autre titre.", fname)
            })),
        )
            .into_response();
    }

    if let Some(parent) = target_path.parent() {
        let _ = fs::create_dir_all(parent);
    }

    let content = if payload.content.is_empty() {
        let title = PathBuf::from(&fname)
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("Nouvelle note")
            .replace('_', " ");
        format!("# {}\n\n", title)
    } else {
        payload.content
    };

    if let Err(e) = fs::write(&target_path, content.as_bytes()) {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"error": format!("Impossible de créer le fichier : {}", e)})),
        )
            .into_response();
    }

    let doc_id = match state.db.get() {
        Ok(conn) => {
            let stem = PathBuf::from(&fname)
                .file_stem()
                .and_then(|s| s.to_str())
                .unwrap_or(&fname)
                .replace('_', " ");
            let file_size = content.len() as i64;
            let res = conn.execute(
                "INSERT INTO documents (filename, title, file_size, doc_type, status) VALUES (?1, ?2, ?3, 'markdown', 'pending')",
                params![fname, stem, file_size],
            );
            if res.is_ok() {
                let id = conn.last_insert_rowid();
                state.pipeline.enqueue(id);
                id
            } else {
                0
            }
        }
        Err(_) => 0,
    };

    (
        StatusCode::CREATED,
        Json(FileOperationResponse {
            status: "created".to_string(),
            filename: Some(fname),
            doc_id: if doc_id > 0 { Some(doc_id) } else { None },
            message: Some("Note créée avec succès".to_string()),
        }),
    )
        .into_response()
}

/// DELETE /api/files/*filename : Soft-delete vers la corbeille
pub async fn soft_delete_file_handler(
    State(state): State<Arc<AppState>>,
    Path(filename): Path<String>,
) -> Response {
    let clean_fname = filename.trim_start_matches('/');
    let conn = match state.db.get() {
        Ok(c) => c,
        Err(_) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({"error": "Erreur accès base de données"})),
            )
                .into_response();
        }
    };

    match soft_delete(&conn, &state.config, clean_fname) {
        Ok(()) => (
            StatusCode::OK,
            Json(FileOperationResponse {
                status: "trashed".to_string(),
                filename: Some(clean_fname.to_string()),
                doc_id: None,
                message: Some("Document déplacé dans la corbeille".to_string()),
            }),
        )
            .into_response(),
        Err(e) => (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({"error": e})),
        )
            .into_response(),
    }
}

/// POST /api/files/*filename/restore : Restauration depuis la corbeille
pub async fn restore_file_handler(
    State(state): State<Arc<AppState>>,
    Path(filename): Path<String>,
) -> Response {
    let clean_fname = filename.trim_start_matches('/');
    let conn = match state.db.get() {
        Ok(c) => c,
        Err(_) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({"error": "Erreur accès base de données"})),
            )
                .into_response();
        }
    };

    match restore_from_trash(&conn, &state.config, clean_fname) {
        Ok((doc_id, orig_path)) => {
            state.pipeline.enqueue(doc_id);
            (
                StatusCode::OK,
                Json(FileOperationResponse {
                    status: "restored".to_string(),
                    filename: Some(orig_path),
                    doc_id: Some(doc_id),
                    message: Some("Document restauré avec succès".to_string()),
                }),
            )
                .into_response()
        }
        Err(e) => (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({"error": e})),
        )
            .into_response(),
    }
}

/// GET /api/trash : Liste les éléments de la corbeille
pub async fn list_trash_handler(State(state): State<Arc<AppState>>) -> Response {
    match list_trash(&state.config) {
        Ok(items) => (StatusCode::OK, Json(serde_json::json!({ "items": items }))).into_response(),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"error": e})),
        )
            .into_response(),
    }
}

/// DELETE /api/trash/*filename : Suppression définitive d'un élément de la corbeille
pub async fn purge_trash_handler(
    State(state): State<Arc<AppState>>,
    Path(filename): Path<String>,
) -> Response {
    let clean_fname = filename.trim_start_matches('/');
    let conn = match state.db.get() {
        Ok(c) => c,
        Err(_) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({"error": "Erreur accès base de données"})),
            )
                .into_response();
        }
    };

    match permanently_delete_trash_item(&conn, &state.config, clean_fname) {
        Ok(_) => (
            StatusCode::OK,
            Json(serde_json::json!({"status": "deleted", "filename": clean_fname})),
        )
            .into_response(),
        Err(e) => (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({"error": e})),
        )
            .into_response(),
    }
}

#[derive(Deserialize)]
pub struct RestorePayload {
    pub filename: String,
}

/// POST /api/trash/restore : Restauration depuis la corbeille via JSON payload
pub async fn restore_payload_handler(
    State(state): State<Arc<AppState>>,
    Json(payload): Json<RestorePayload>,
) -> Response {
    let clean_fname = payload.filename.trim_start_matches('/');
    let conn = match state.db.get() {
        Ok(c) => c,
        Err(_) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({"error": "Erreur accès base de données"})),
            )
                .into_response();
        }
    };

    match restore_from_trash(&conn, &state.config, clean_fname) {
        Ok((doc_id, orig_path)) => {
            state.pipeline.enqueue(doc_id);
            (
                StatusCode::OK,
                Json(FileOperationResponse {
                    status: "restored".to_string(),
                    filename: Some(orig_path),
                    doc_id: Some(doc_id),
                    message: Some("Document restauré avec succès".to_string()),
                }),
            )
                .into_response()
        }
        Err(e) => (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({"error": e})),
        )
            .into_response(),
    }
}

/// POST /api/assets/:stem : Upload d'image/asset pour une note Markdown
pub async fn upload_asset_handler(
    State(state): State<Arc<AppState>>,
    Path(stem): Path<String>,
    mut multipart: Multipart,
) -> Response {
    let clean_stem = stem.trim_start_matches('/').replace('/', "_");
    let assets_dir = state.config.documents_dir.join("assets").join(&clean_stem);
    if let Err(e) = fs::create_dir_all(&assets_dir) {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"error": format!("Impossible de créer le dossier d'assets : {}", e)})),
        )
            .into_response();
    }

    let mut saved_files = Vec::new();

    while let Ok(Some(field)) = multipart.next_field().await {
        let name = field.file_name().unwrap_or("asset.png").to_string();
        let safe_name = PathBuf::from(&name)
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or("asset.png")
            .to_string();

        let target = assets_dir.join(&safe_name);
        if let Ok(data) = field.bytes().await {
            if fs::write(&target, data).is_ok() {
                let relative_url = format!("/api/assets/{}/{}", clean_stem, safe_name);
                saved_files.push(serde_json::json!({
                    "name": safe_name,
                    "url": relative_url,
                }));
            }
        }
    }

    (
        StatusCode::OK,
        Json(serde_json::json!({
            "status": "ok",
            "assets": saved_files,
        })),
    )
        .into_response()
}

/// GET /api/assets/:stem/:name : Accès en lecture à un asset Markdown
pub async fn get_asset_handler(
    State(state): State<Arc<AppState>>,
    Path((stem, asset_name)): Path<(String, String)>,
) -> Response {
    let clean_stem = stem.trim_start_matches('/').replace('/', "_");
    let safe_asset = PathBuf::from(&asset_name)
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or(&asset_name)
        .to_string();

    let asset_path = state.config.documents_dir.join("assets").join(clean_stem).join(safe_asset);
    if !asset_path.exists() {
        return (StatusCode::NOT_FOUND, "Asset non trouvé").into_response();
    }

    let bytes = match fs::read(&asset_path) {
        Ok(b) => b,
        Err(_) => return (StatusCode::INTERNAL_SERVER_ERROR, "Erreur lecture asset").into_response(),
    };

    let mime = mime_guess::from_path(&asset_path).first_or_octet_stream();
    (
        StatusCode::OK,
        [(header::CONTENT_TYPE, mime.as_ref())],
        bytes,
    )
        .into_response()
}

/// POST /api/sync/manifest : Protocole de synchronisation différentielle LWW
pub async fn sync_manifest_handler(
    State(state): State<Arc<AppState>>,
    Json(req): Json<SyncManifestRequest>,
) -> Response {
    let plan = compute_sync_plan(&state.config, &req);
    (StatusCode::OK, Json(plan)).into_response()
}

/// POST /api/rebuild-db : Reconstruction complète de la base SQLite à partir du filesystem
pub async fn rebuild_db_handler(State(state): State<Arc<AppState>>) -> Response {
    let conn = match state.db.get() {
        Ok(c) => c,
        Err(_) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({"error": "Erreur connexion DB"})),
            )
                .into_response();
        }
    };

    match rebuild_database_from_filesystem(&conn, &state.config) {
        Ok(queued_ids) => {
            for id in &queued_ids {
                state.pipeline.enqueue(*id);
            }
            (
                StatusCode::OK,
                Json(serde_json::json!({
                    "status": "rebuilding",
                    "queued_count": queued_ids.len(),
                    "message": "Base de données reconstruite depuis le système de fichiers, réindexation lancée",
                })),
            )
                .into_response()
        }
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"error": format!("Échec reconstruction : {}", e)})),
        )
            .into_response(),
    }
}

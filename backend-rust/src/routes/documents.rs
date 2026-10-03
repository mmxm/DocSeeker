use axum::{
    extract::{Multipart, Path, Query, State},
    http::StatusCode,
    response::{IntoResponse, Json, Response},
};
use rusqlite::params;
use serde::{Deserialize, Serialize};
use sha2::Digest;
use std::sync::Arc;
use tokio::io::AsyncWriteExt;
use unicode_normalization::UnicodeNormalization;

use crate::AppState;
use crate::pdf::indexer::{reindex_all_library, scan_and_sync_documents};

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
    #[serde(skip_serializing_if = "Option::is_none")]
    pub doc_type: Option<String>,
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
pub struct BatchReindexPayload {
    pub doc_ids: Vec<i64>,
}

#[derive(Deserialize)]
pub struct UpdateDocumentPayload {
    pub title: Option<String>,
    /// Nombre de pages réel remonté par le lecteur PDF.js (source de vérité)
    pub total_pages: Option<i64>,
}

pub async fn list_documents(
    State(state): State<Arc<AppState>>,
    Query(query): Query<DocumentListQuery>,
) -> Result<Json<serde_json::Value>, Response> {
    let conn = state.db.get().map_err(|_| {
        (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": "DB lock error"}))).into_response()
    })?;

    let sql = match query.folder_id.as_deref() {
        Some("root") => {
            "SELECT id, filename, title, folder_id, COALESCE(status, 'ready'), error_message, total_pages, file_size, created_at, COALESCE(updated_at, created_at), COALESCE(doc_type, 'pdf') \
             FROM documents WHERE folder_id IS NULL ORDER BY title ASC"
        }
        Some(fid) if fid.parse::<i64>().is_ok() => {
            "SELECT id, filename, title, folder_id, COALESCE(status, 'ready'), error_message, total_pages, file_size, created_at, COALESCE(updated_at, created_at), COALESCE(doc_type, 'pdf') \
             FROM documents WHERE folder_id = ?1 ORDER BY title ASC"
        }
        _ => {
            "SELECT id, filename, title, folder_id, COALESCE(status, 'ready'), error_message, total_pages, file_size, created_at, COALESCE(updated_at, created_at), COALESCE(doc_type, 'pdf') \
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
        doc_type: row.get(10).ok(),
    })
}

pub async fn get_document_status(
    State(state): State<Arc<AppState>>,
    Path(doc_id): Path<i64>,
) -> Result<Json<serde_json::Value>, Response> {
    let conn = state.db.get().map_err(|_| {
        (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": "DB lock error"}))).into_response()
    })?;

    let res = conn.query_row(
        "SELECT id, filename, title, status, error_message, total_pages, COALESCE(doc_type, 'pdf') FROM documents WHERE id = ?1",
        params![doc_id],
        |r| {
            Ok(serde_json::json!({
                "id": r.get::<_, i64>(0)?,
                "filename": r.get::<_, String>(1)?,
                "title": r.get::<_, Option<String>>(2)?.unwrap_or_default(),
                "status": r.get::<_, Option<String>>(3)?.unwrap_or_else(|| "ready".to_string()),
                "error_message": r.get::<_, Option<String>>(4)?,
                "total_pages": r.get::<_, i64>(5)?,
                "doc_type": r.get::<_, Option<String>>(6)?.unwrap_or_else(|| "pdf".to_string()),
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
    let conn = state.db.get().map_err(|_| {
        (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": "DB lock error"}))).into_response()
    })?;

    let mut response_title = None;
    let mut response_filename = None;

    if let Some(ref title) = payload.title {
        let raw_title = title.trim();
        if raw_title.is_empty() {
            return Err((StatusCode::BAD_REQUEST, Json(serde_json::json!({"error": "Le titre ne peut pas être vide"}))).into_response());
        }

        // Nettoyer l'extension .pdf si saisie par l'utilisateur
        let title_stem = if raw_title.to_lowercase().ends_with(".pdf") {
            &raw_title[..raw_title.len() - 4]
        } else {
            raw_title
        };
        let clean_title: String = title_stem.trim().nfc().collect();
        if clean_title.is_empty() {
            return Err((StatusCode::BAD_REQUEST, Json(serde_json::json!({"error": "Le titre ne peut pas être vide"}))).into_response());
        }
        if clean_title.contains('/') || clean_title.contains('\\') || clean_title.contains("..") {
            return Err((StatusCode::BAD_REQUEST, Json(serde_json::json!({"error": "Le titre contient des caractères interdits (/ ou \\)"}))).into_response());
        }

        // Récupérer le fichier actuel en base
        let current_fname: String = conn.query_row(
            "SELECT filename FROM documents WHERE id = ?1",
            params![doc_id],
            |r| r.get(0),
        ).map_err(|_| {
            (StatusCode::NOT_FOUND, Json(serde_json::json!({"error": "Document introuvable"}))).into_response()
        })?;

        // Conserver l'extension du fichier d'origine (.md, .pdf, etc.)
        let ext = std::path::Path::new(&current_fname)
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("pdf");
        let new_file_base = if clean_title.ends_with(&format!(".{}", ext)) {
            clean_title.to_string()
        } else {
            format!("{}.{}", clean_title, ext)
        };
        let new_relative_fname = match std::path::Path::new(&current_fname).parent() {
            Some(p) if !p.as_os_str().is_empty() => p.join(&new_file_base).to_string_lossy().to_string(),
            _ => new_file_base,
        };
        let norm_new_fname: String = new_relative_fname.nfc().collect();

        if norm_new_fname != current_fname {
            // Vérifier les doublons de nom de fichier
            let collision: Option<i64> = conn.query_row(
                "SELECT id FROM documents WHERE filename = ?1 AND id != ?2",
                params![norm_new_fname, doc_id],
                |r| r.get(0),
            ).ok();
            if collision.is_some() {
                return Err((StatusCode::CONFLICT, Json(serde_json::json!({"error": "Un document portant ce nom de fichier existe déjà dans ce dossier"}))).into_response());
            }

            // Renommage physique du fichier sur le disque du volume
            let is_md = current_fname.ends_with(".md") || current_fname.ends_with(".markdown");
            if is_md {
                let old_stem = std::path::Path::new(&current_fname).file_stem().and_then(|s| s.to_str()).unwrap_or("");
                let new_stem = std::path::Path::new(&norm_new_fname).file_stem().and_then(|s| s.to_str()).unwrap_or(&clean_title);

                if let Some(src_path) = crate::document::trash::resolve_file_path(&state.config.documents_dir, &current_fname) {
                    let parent_dir = src_path.parent().unwrap_or(&state.config.documents_dir);
                    let dest_path = parent_dir.join(format!("{}.md", new_stem));

                    // 1. Renommer le fichier .md
                    if src_path != dest_path {
                        if let Err(e) = std::fs::rename(&src_path, &dest_path) {
                            tracing::warn!("[Documents] Échec renommage fichier note {} -> {} : {}", src_path.display(), dest_path.display(), e);
                            return Err((StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": format!("Impossible de renommer le fichier de la note sur le disque : {}", e)}))).into_response());
                        }
                    }

                    // 2. Renommer le dossier d'assets dans .assets/ : parent/.assets/<old_stem> -> parent/.assets/<new_stem>
                    let old_assets = parent_dir.join(".assets").join(old_stem);
                    let new_assets = parent_dir.join(".assets").join(new_stem);
                    if old_assets.is_dir() && old_assets != new_assets {
                        let _ = std::fs::create_dir_all(parent_dir.join(".assets"));
                        if let Err(e) = std::fs::rename(&old_assets, &new_assets) {
                            tracing::warn!("[Documents] Échec renommage dossier assets {} -> {} : {}", old_assets.display(), new_assets.display(), e);
                        }
                    }

                    // 3. Réécriture des références d'assets (/api/assets/<ancien_stem>/ -> /api/assets/<nouveau_stem>/) dans le fichier .md
                    if dest_path.exists() {
                        if let Ok(content) = std::fs::read_to_string(&dest_path) {
                            let old_raw = format!("/api/assets/{}/", old_stem);
                            let new_raw = format!("/api/assets/{}/", new_stem);
                            let old_enc = format!("/api/assets/{}/", urlencoding::encode(old_stem));
                            let new_enc = format!("/api/assets/{}/", urlencoding::encode(new_stem));

                            let mut updated = content.replace(&old_raw, &new_raw);
                            if old_enc != old_raw {
                                updated = updated.replace(&old_enc, &new_enc);
                            }
                            if updated != content {
                                let _ = std::fs::write(&dest_path, updated);
                            }
                        }
                    }
                }
            } else if let Some(src_path) = crate::document::trash::resolve_file_path(&state.config.documents_dir, &current_fname) {
                let dest_path = state.config.documents_dir.join(&norm_new_fname);
                if let Some(parent) = dest_path.parent() {
                    let _ = std::fs::create_dir_all(parent);
                }
                if src_path != dest_path {
                    if let Err(e) = std::fs::rename(&src_path, &dest_path) {
                        tracing::warn!("[Documents] Échec du renommage physique {} -> {} : {}", src_path.display(), dest_path.display(), e);
                        return Err((StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": format!("Impossible de renommer le fichier sur le disque : {}", e)}))).into_response());
                    }
                    tracing::info!("[Documents] Fichier renommé physiquement sur le disque : {} -> {}", src_path.display(), dest_path.display());
                }
            }

            conn.execute(
                "UPDATE documents SET title = ?1, filename = ?2, updated_at = CURRENT_TIMESTAMP WHERE id = ?3",
                params![clean_title, norm_new_fname, doc_id],
            ).map_err(|e| {
                (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": e.to_string()}))).into_response()
            })?;
        } else {
            conn.execute(
                "UPDATE documents SET title = ?1, updated_at = CURRENT_TIMESTAMP WHERE id = ?2",
                params![clean_title, doc_id],
            ).ok();
        }

        response_title = Some(clean_title);
        response_filename = Some(norm_new_fname);
    }

    // Correction du nombre de pages par la valeur exacte lue par PDF.js
    if let Some(pages) = payload.total_pages {
        if pages > 0 {
            conn.execute(
                "UPDATE documents SET total_pages = ?1, updated_at = CURRENT_TIMESTAMP WHERE id = ?2",
                params![pages, doc_id],
            ).ok();
        }
    }

    Ok(Json(serde_json::json!({
        "status": "ok",
        "title": response_title,
        "filename": response_filename,
    })))
}

fn move_doc_physical(
    conn: &rusqlite::Connection,
    config: &crate::config::Config,
    doc_id: i64,
    target_folder_id: Option<i64>,
) -> std::result::Result<(), String> {
    let current_fname: String = conn.query_row(
        "SELECT filename FROM documents WHERE id = ?1",
        params![doc_id],
        |r| r.get(0),
    ).map_err(|e| e.to_string())?;

    let base_name = std::path::Path::new(&current_fname)
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or(current_fname.clone());

    // Calculer le nouveau chemin relatif et le répertoire de destination physique
    let (mut new_rel_fname, dest_dir) = match target_folder_id {
        Some(fid) => {
            if let Some(folder_rel) = crate::routes::folders::get_folder_relative_path(conn, fid) {
                let folder_rel_str = folder_rel.to_string_lossy().to_string();
                let full_rel = format!("{}/{}", folder_rel_str, base_name);
                let full_dest = config.documents_dir.join(&folder_rel);
                (full_rel, full_dest)
            } else {
                (base_name.clone(), config.documents_dir.clone())
            }
        }
        None => (base_name.clone(), config.documents_dir.clone()),
    };

    // Gestion des conflits d'unicité de filename en base SQLite
    let conflicting: Option<(i64, String)> = conn.query_row(
        "SELECT id, status FROM documents WHERE filename = ?1 AND id != ?2",
        params![new_rel_fname, doc_id],
        |r| Ok((r.get(0)?, r.get(1)?)),
    ).ok();

    if let Some((conf_id, conf_status)) = conflicting {
        if conf_status == "trashed" {
            // Le document en conflit est un déchet en corbeille : supprimer la ligne orpheline pour libérer le nom
            let _ = conn.execute("DELETE FROM documents WHERE id = ?1", params![conf_id]);
        } else {
            // Document actif en conflit : suffixer pour garantir l'unicité
            let stem = std::path::Path::new(&base_name).file_stem().and_then(|s| s.to_str()).unwrap_or(&base_name);
            let ext = std::path::Path::new(&base_name).extension().and_then(|s| s.to_str()).unwrap_or("");
            let unique_base = if ext.is_empty() {
                format!("{}_{}", stem, doc_id)
            } else {
                format!("{}_{}.{}", stem, doc_id, ext)
            };
            if let Some(fid) = target_folder_id {
                if let Some(folder_rel) = crate::routes::folders::get_folder_relative_path(conn, fid) {
                    new_rel_fname = format!("{}/{}", folder_rel.to_string_lossy(), unique_base);
                } else {
                    new_rel_fname = unique_base;
                }
            } else {
                new_rel_fname = unique_base;
            }
        }
    }

    let is_md = current_fname.ends_with(".md") || current_fname.ends_with(".markdown");
    if is_md {
        if let Some(src_path) = crate::document::trash::resolve_file_path(&config.documents_dir, &current_fname) {
            let stem = std::path::Path::new(&base_name).file_stem().and_then(|s| s.to_str()).unwrap_or(&base_name);
            let _ = std::fs::create_dir_all(&dest_dir);
            let dest_file_path = dest_dir.join(&base_name);

            // 1. Déplacer le fichier .md (avec fallback copie si rename cross-filesystem échoue)
            if src_path != dest_file_path {
                if std::fs::rename(&src_path, &dest_file_path).is_err() {
                    if std::fs::copy(&src_path, &dest_file_path).is_ok() {
                        let _ = std::fs::remove_file(&src_path);
                    }
                }
            }

            // 2. Déplacer le dossier d'assets associé : src_parent/.assets/<stem> -> dest_dir/.assets/<stem>
            if let Some(src_parent) = src_path.parent() {
                let src_assets = src_parent.join(".assets").join(stem);
                if src_assets.is_dir() {
                    let dest_assets_parent = dest_dir.join(".assets");
                    let _ = std::fs::create_dir_all(&dest_assets_parent);
                    let dest_assets = dest_assets_parent.join(stem);
                    if src_assets != dest_assets {
                        let _ = std::fs::rename(&src_assets, &dest_assets);
                        let _ = std::fs::remove_dir(src_parent.join(".assets"));
                    }
                }
            }
        }
    } else {
        // Déplacer physiquement le fichier sur le disque (avec fallback cross-device / NAS)
        if let Some(src_path) = crate::pdf::indexer::resolve_pdf_path(&config.documents_dir, &current_fname) {
            let _ = std::fs::create_dir_all(&dest_dir);
            let dest_file_path = dest_dir.join(&base_name);
            if src_path != dest_file_path {
                if std::fs::rename(&src_path, &dest_file_path).is_err() {
                    if std::fs::copy(&src_path, &dest_file_path).is_ok() {
                        let _ = std::fs::remove_file(&src_path);
                    }
                }
            }
        }
    }

    // Mettre à jour l'enregistrement dans la base
    conn.execute(
        "UPDATE documents SET folder_id = ?1, filename = ?2, updated_at = CURRENT_TIMESTAMP WHERE id = ?3",
        params![target_folder_id, new_rel_fname, doc_id],
    ).map_err(|e| e.to_string())?;

    Ok(())
}

pub async fn move_document(
    State(state): State<Arc<AppState>>,
    Path(doc_id): Path<i64>,
    Json(payload): Json<MoveDocumentPayload>,
) -> Result<Json<serde_json::Value>, Response> {
    let conn = state.db.get().map_err(|_| {
        (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": "DB lock error"}))).into_response()
    })?;

    move_doc_physical(&conn, &state.config, doc_id, payload.folder_id)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": e}))).into_response())?;

    Ok(Json(serde_json::json!({"status": "ok", "doc_id": doc_id, "folder_id": payload.folder_id})))
}

pub async fn batch_move_documents(
    State(state): State<Arc<AppState>>,
    Json(payload): Json<BatchMovePayload>,
) -> Result<Json<serde_json::Value>, Response> {
    let conn = state.db.get().map_err(|_| {
        (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": "DB lock error"}))).into_response()
    })?;

    let mut moved_count = 0;
    let mut errors = Vec::new();

    for id in &payload.doc_ids {
        match move_doc_physical(&conn, &state.config, *id, payload.folder_id) {
            Ok(()) => moved_count += 1,
            Err(e) => {
                tracing::error!("[BatchMove] Échec déplacement doc {}: {}", id, e);
                errors.push(format!("Doc {}: {}", id, e));
            }
        }
    }

    if !errors.is_empty() && moved_count == 0 {
        return Err((
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({
                "error": format!("Impossible de déplacer : {}", errors.join("; "))
            })),
        ).into_response());
    }

    Ok(Json(serde_json::json!({
        "status": "ok",
        "moved_count": moved_count,
        "errors": if errors.is_empty() { None } else { Some(errors) }
    })))
}

pub async fn delete_document_handler(
    State(state): State<Arc<AppState>>,
    Path(doc_id): Path<i64>,
) -> Result<Json<serde_json::Value>, Response> {
    let conn = state.db.get().map_err(|_| {
        (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": "DB lock error"}))).into_response()
    })?;

    let filename: Option<String> = conn
        .query_row("SELECT filename FROM documents WHERE id = ?1", params![doc_id], |r| r.get(0))
        .ok();

    let fname = match filename {
        Some(f) => f,
        None => return Err((StatusCode::NOT_FOUND, Json(serde_json::json!({"error": "Document introuvable"}))).into_response()),
    };

    // Si le fichier physique n'existe plus sur le disque, supprimer directement l'enregistrement orphelin de la base
    if crate::document::trash::resolve_file_path(&state.config.documents_dir, &fname).is_none() {
        let _ = conn.execute("DELETE FROM documents WHERE id = ?1", params![doc_id]);
        let cover_path = state.config.covers_dir.join(format!("{}.webp", doc_id));
        if cover_path.exists() {
            let _ = std::fs::remove_file(cover_path);
        }
        return Ok(Json(serde_json::json!({"status": "ok", "deleted_id": doc_id, "orphan_cleaned": true})));
    }

    match crate::document::trash::soft_delete(&conn, &state.config, &fname) {
        Ok(()) => {
            Ok(Json(serde_json::json!({"status": "ok", "deleted_id": doc_id, "trashed": true})))
        }
        Err(e) => Err((StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": e}))).into_response()),
    }
}

pub async fn check_hash(
    State(state): State<Arc<AppState>>,
    Path(file_hash): Path<String>,
) -> Result<Json<serde_json::Value>, Response> {
    let conn = state.db.get().map_err(|_| {
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

    // Streaming : le fichier est écrit sur disque au fil de l'eau avec hachage incrémental.
    // Aucune bufferisation du PDF complet en RAM (correctif OOM conteneur 2 Go : un upload
    // de 800 Mo ne consomme plus que ~1 Mo de mémoire au lieu de 800 Mo).
    let mut hasher = sha2::Sha256::new();
    let mut file_size: i64 = 0;
    let mut header_window: Vec<u8> = Vec::new();
    #[allow(unused_assignments)]
    let mut temp_file: Option<tokio::fs::File> = None;
    let mut temp_path: Option<std::path::PathBuf> = None;

    // Garde-fou : suppression du fichier partiel si la requête échoue en cours de route
    struct PartialUploadCleanup(Option<std::path::PathBuf>);
    impl Drop for PartialUploadCleanup {
        fn drop(&mut self) {
            if let Some(path) = self.0.take() {
                let _ = std::fs::remove_file(path);
            }
        }
    }
    let mut cleanup = PartialUploadCleanup(None);

    loop {
        match multipart.next_field().await {
            Ok(Some(mut field)) => {
                let field_name = field.name().unwrap_or("").to_string();
                if field_name == "file" {
                    if let Some(fname) = field.file_name() {
                        uploaded_filename = fname.to_string();
                    }
                    if uploaded_filename.is_empty() {
                        return Err((
                            StatusCode::BAD_REQUEST,
                            Json(serde_json::json!({ "error": "Nom de fichier manquant" })),
                        ).into_response());
                    }

                    // Fichier partiel : .upload-<nonce>-<nom>.part dans le répertoire documents
                    let norm_name: String = uploaded_filename.nfc().collect();
                    let nonce = std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .map(|d| d.as_nanos())
                        .unwrap_or(0);
                    let tmp_path = state.config.documents_dir.join(format!(".upload-{}-{}.part", nonce, norm_name));
                    std::fs::create_dir_all(&state.config.documents_dir).ok();
                    let out = tokio::fs::File::create(&tmp_path).await.map_err(|e| {
                        (
                            StatusCode::INTERNAL_SERVER_ERROR,
                            Json(serde_json::json!({ "error": format!("Échec de création du fichier temporaire : {}", e) })),
                        ).into_response()
                    })?;
                    temp_path = Some(tmp_path.clone());
                    cleanup.0 = Some(tmp_path);
                    temp_file = Some(out);

                    // Écriture + hachage chunk par chunk : RAM constante (~1 Mo)
                    loop {
                        match field.chunk().await {
                            Ok(Some(chunk)) => {
                                file_size += chunk.len() as i64;
                                if file_size > state.config.max_upload_size as i64 {
                                    return Err((
                                        StatusCode::PAYLOAD_TOO_LARGE,
                                        Json(serde_json::json!({ "error": "Fichier trop volumineux (MAX_UPLOAD_SIZE dépassé)" })),
                                    ).into_response());
                                }
                                if header_window.len() < 1024 {
                                    let take = (1024 - header_window.len()).min(chunk.len());
                                    header_window.extend_from_slice(&chunk[..take]);
                                }
                                hasher.update(&chunk);
                                if let Some(out) = temp_file.as_mut() {
                                    out.write_all(&chunk).await.map_err(|e| {
                                        (
                                            StatusCode::INTERNAL_SERVER_ERROR,
                                            Json(serde_json::json!({ "error": format!("Échec d'écriture du fichier : {}", e) })),
                                        ).into_response()
                                    })?;
                                }
                            }
                            Ok(None) => break,
                            Err(e) => {
                                return Err((
                                    StatusCode::BAD_REQUEST,
                                    Json(serde_json::json!({
                                        "error": format!("Erreur lors de la lecture du fichier : {}", e)
                                    })),
                                ).into_response());
                            }
                        }
                    }
                    if let Some(out) = temp_file.as_mut() {
                        out.flush().await.ok();
                    }
                    drop(temp_file.take()); // fichier fermé ; le renommage interviendra après la détection de doublon
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

    if uploaded_filename.is_empty() || file_size < 5 {
        return Err((StatusCode::BAD_REQUEST, Json(serde_json::json!({"error": "Fichier PDF manquant ou vide"}))).into_response());
    }

    if !uploaded_filename.to_lowercase().ends_with(".pdf") {
        return Err((StatusCode::BAD_REQUEST, Json(serde_json::json!({"error": "Seuls les fichiers PDF sont acceptés"}))).into_response());
    }

    // Validation signature magique PDF (conforme ISO 32000-1 §7.5.2 : %PDF- dans les 1024 premiers octets)
    let has_pdf_magic = header_window.windows(5).any(|w| w == b"%PDF-");
    if !has_pdf_magic {
        return Err((StatusCode::BAD_REQUEST, Json(serde_json::json!({"error": "Format invalide : signature PDF manquante"}))).into_response());
    }

    // Empreinte SHA-256 calculée de façon incrémentale pendant le streaming
    let file_hash = hex::encode(hasher.finalize());

    // Détection stricte de doublon
    {
        let conn = state.db.get().map_err(|_| {
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
    let (dest_path, final_rel_filename) = {
        let conn = state.db.get().map_err(|_| {
            (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": "DB lock error"}))).into_response()
        })?;
        match target_folder_id {
            Some(fid) => {
                if let Some(folder_rel) = crate::routes::folders::get_folder_relative_path(&conn, fid) {
                    let folder_dir = state.config.documents_dir.join(&folder_rel);
                    std::fs::create_dir_all(&folder_dir).ok();
                    let full_dest = folder_dir.join(&norm_filename);
                    let rel_fname = format!("{}/{}", folder_rel.to_string_lossy(), norm_filename);
                    (full_dest, rel_fname)
                } else {
                    (state.config.documents_dir.join(&norm_filename), norm_filename.clone())
                }
            }
            None => (state.config.documents_dir.join(&norm_filename), norm_filename.clone()),
        }
    };

    // Promotion atomique du fichier temporaire (streamé) vers son emplacement définitif
    if let Some(tmp_path) = temp_path.take() {
        if let Err(e) = tokio::fs::rename(&tmp_path, &dest_path).await {
            return Err((StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": format!("Échec d'écriture du fichier : {}", e)}))).into_response());
        }
        cleanup.0 = None; // le fichier partiel a été promu, plus rien à nettoyer
    }

    // Insertion immédiate en DB en état 'pending' pour retour instantané
    let doc_id = {
        let conn = state.db.get().map_err(|_| {
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
            .query_row("SELECT id FROM documents WHERE filename = ?1", params![final_rel_filename], |r| r.get(0))
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
                params![final_rel_filename, clean_title, file_hash, file_size, target_folder_id],
            ).ok();
            conn.last_insert_rowid()
        }
    };

    // Envoi dans la queue d'indexation d'arrière-plan
    state.pipeline.enqueue(doc_id);

    Ok(Json(serde_json::json!({
        "status": "queued",
        "doc_id": doc_id,
        "filename": final_rel_filename,
        "title": custom_title.unwrap_or(norm_filename)
    })))
}

pub async fn reindex_document(
    State(state): State<Arc<AppState>>,
    Path(doc_id): Path<i64>,
) -> Result<Json<serde_json::Value>, Response> {
    let mut updated_title = None;
    if let Ok(conn) = state.db.get() {
        if let Ok(fname) = conn.query_row("SELECT filename FROM documents WHERE id = ?1", params![doc_id], |r| r.get::<_, String>(0)) {
            let stem = std::path::Path::new(&fname)
                .file_stem()
                .and_then(|s| s.to_str())
                .unwrap_or(&fname);
            let clean_base_title: String = stem.nfc().collect();
            let clean_base_title = clean_base_title.replace('_', " ").trim().to_string();
            let _ = conn.execute(
                "UPDATE documents SET title = ?1, status = 'pending', error_message = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?2",
                params![clean_base_title, doc_id],
            );
            updated_title = Some(clean_base_title);
        }
    }
    state.pipeline.enqueue(doc_id);
    Ok(Json(serde_json::json!({
        "status": "queued",
        "doc_id": doc_id,
        "title": updated_title,
    })))
}

pub async fn batch_reindex_documents(
    State(state): State<Arc<AppState>>,
    Json(payload): Json<BatchReindexPayload>,
) -> Result<Json<serde_json::Value>, Response> {
    let conn = state.db.get().map_err(|_| {
        (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": "DB lock error"}))).into_response()
    })?;

    let mut queued = 0;
    for &doc_id in &payload.doc_ids {
        if let Ok(fname) = conn.query_row("SELECT filename FROM documents WHERE id = ?1", params![doc_id], |r| r.get::<_, String>(0)) {
            let stem = std::path::Path::new(&fname)
                .file_stem()
                .and_then(|s| s.to_str())
                .unwrap_or(&fname);
            let clean_base_title: String = stem.nfc().collect();
            let clean_base_title = clean_base_title.replace('_', " ").trim().to_string();
            let _ = conn.execute(
                "UPDATE documents SET title = ?1, status = 'pending', error_message = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?2",
                params![clean_base_title, doc_id],
            );
            state.pipeline.enqueue(doc_id);
            queued += 1;
        }
    }

    Ok(Json(serde_json::json!({
        "status": "ok",
        "total_queued": queued,
    })))
}

pub async fn reindex_all_documents(
    State(state): State<Arc<AppState>>,
) -> Result<Json<serde_json::Value>, Response> {
    let queued_ids = {
        let conn = state.db.get().map_err(|_| {
            (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": "DB lock error"}))).into_response()
        })?;
        reindex_all_library(&conn, &state.pdf_engine, &state.config)
            .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": e}))).into_response())?
    };

    let total = queued_ids.len();
    for id in queued_ids {
        state.pipeline.enqueue(id);
    }

    Ok(Json(serde_json::json!({
        "status": "ok",
        "total_queued": total
    })))
}

/// POST /api/maintenance/resync-library ou /api/documents/resync-library
/// Réconcilie l'arborescence et les fichiers avec la base de données sans réindexer les documents existants
pub async fn resync_library_handler(
    State(state): State<Arc<AppState>>,
) -> Result<Json<serde_json::Value>, Response> {
    let report = {
        let conn = state.db.get().map_err(|_| {
            (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": "DB lock error"}))).into_response()
        })?;
        crate::document::scanner::reconcile_database_with_filesystem(&conn, &state.config)
            .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": e}))).into_response())?
    };

    // Mettre en file d'attente les nouveaux documents découverts
    for id in &report.queued_ids {
        state.pipeline.enqueue(*id);
    }

    Ok(Json(serde_json::json!({
        "status": "ok",
        "folders_created": report.folders_created,
        "folders_deleted": report.folders_deleted,
        "docs_preserved": report.docs_preserved,
        "docs_moved": report.docs_moved,
        "docs_removed": report.docs_removed,
        "docs_new_queued": report.docs_new_queued,
    })))
}

pub async fn sync_documents_handler(
    State(state): State<Arc<AppState>>,
) -> Result<Json<serde_json::Value>, Response> {
    let retried = state.pipeline.retry_failed();
    let (added_count, added_files) = {
        let conn = state.db.get().map_err(|_| {
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
    pub doc_type: String,
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
    let conn = state.db.get().map_err(|_| {
        (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": "DB lock error"}))).into_response()
    })?;

    // 1. Récupération des métadonnées du document
    let mut stmt_doc = conn.prepare(
        "SELECT id, filename, title, COALESCE(doc_type, 'pdf'), file_hash, folder_id, total_pages, file_size, created_at, COALESCE(updated_at, created_at) \
         FROM documents WHERE id = ?1 AND COALESCE(status, 'ready') = 'ready'"
    ).map_err(|e| {
        (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": e.to_string()}))).into_response()
    })?;

    let document = stmt_doc.query_row(params![doc_id], |row| {
        Ok(OfflineBundleDocument {
            id: row.get(0)?,
            filename: row.get(1)?,
            title: row.get(2)?,
            doc_type: row.get(3)?,
            file_hash: row.get(4)?,
            folder_id: row.get(5)?,
            total_pages: row.get(6)?,
            file_size: row.get(7)?,
            created_at: row.get(8)?,
            updated_at: row.get(9)?,
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
    let conn = state.db.get().map_err(|_| {
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

/// GET /api/documents/:id/download : Télécharge un document (archive .zip avec assets pour Markdown, fichier source pour PDF)
pub async fn download_document_handler(
    State(state): State<Arc<AppState>>,
    Path(doc_id): Path<i64>,
) -> Response {
    let conn = match state.db.get() {
        Ok(c) => c,
        Err(_) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({"error": "Base de données inaccessible"})),
            )
                .into_response();
        }
    };

    let doc_res = conn.query_row(
        "SELECT filename, title, COALESCE(doc_type, 'pdf') FROM documents WHERE id = ?1",
        params![doc_id],
        |row| {
            let filename: String = row.get(0)?;
            let title: String = row.get(1)?;
            let doc_type: String = row.get(2)?;
            Ok((filename, title, doc_type))
        },
    );

    let (filename, _title, doc_type) = match doc_res {
        Ok(res) => res,
        Err(rusqlite::Error::QueryReturnedNoRows) => {
            return (
                StatusCode::NOT_FOUND,
                Json(serde_json::json!({"error": format!("Document {} introuvable", doc_id)})),
            )
                .into_response();
        }
        Err(e) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({"error": e.to_string()})),
            )
                .into_response();
        }
    };

    if doc_type == "markdown" || filename.ends_with(".md") || filename.ends_with(".markdown") {
        crate::routes::files::generate_note_zip_response(&state.config.documents_dir, &filename)
    } else {
        use axum::http::header;
        let file_path = match crate::document::trash::resolve_file_path(&state.config.documents_dir, &filename) {
            Some(path) => path,
            None => {
                return (
                    StatusCode::NOT_FOUND,
                    Json(serde_json::json!({"error": format!("Fichier {} introuvable sur le disque", filename)})),
                )
                    .into_response();
            }
        };

        match std::fs::read(&file_path) {
            Ok(bytes) => {
                let download_name = std::path::Path::new(&filename)
                    .file_name()
                    .and_then(|s| s.to_str())
                    .unwrap_or("document.pdf");
                (
                    StatusCode::OK,
                    [
                        (header::CONTENT_TYPE, "application/pdf"),
                        (
                            header::CONTENT_DISPOSITION,
                            &format!("attachment; filename=\"{}\"", download_name),
                        ),
                    ],
                    bytes,
                )
                    .into_response()
            }
            Err(e) => (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({"error": format!("Erreur lecture fichier: {}", e)})),
            )
                .into_response(),
        }
    }
}


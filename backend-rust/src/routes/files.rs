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
    #[serde(default)]
    pub folder_id: Option<i64>,
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

    // Guérison à la volée : les refs `![..](assets/… avec espaces)` créées avant
    // l'encodage URL ne sont pas des destinations CommonMark valides (l'image est
    // affichée comme texte brut dans l'éditeur). On répare au chargement.
    let healed: std::borrow::Cow<'_, [u8]> = if doc_type == "markdown" {
        match std::str::from_utf8(&bytes) {
            Ok(text) => std::borrow::Cow::Owned(heal_asset_references(text).into_bytes()),
            Err(_) => std::borrow::Cow::Borrowed(&bytes),
        }
    } else {
        std::borrow::Cow::Borrowed(&bytes)
    };
    let body_bytes = healed.into_owned();

    (
        StatusCode::OK,
        [
            (header::CONTENT_TYPE, content_type),
            (
                header::CONTENT_DISPOSITION,
                &format!("inline; filename=\"{}\"", file_path.file_name().and_then(|s| s.to_str()).unwrap_or("document")),
            ),
        ],
        body_bytes,
    )
        .into_response()
}

/// Génère la réponse HTTP contenant le dossier complet de la note au format .zip (fichier .md et assets/)
pub fn generate_note_zip_response(documents_dir: &std::path::Path, clean_fname: &str) -> Response {
    let note_dir_opt = crate::document::trash::resolve_note_dir(documents_dir, clean_fname);
    let note_stem = std::path::Path::new(clean_fname)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or(clean_fname)
        .to_string();

    let zip_bytes_res = match note_dir_opt {
        Some(ref dir) if crate::document::markdown::is_markdown_note_dir(dir) => {
            let actual_stem = dir.file_name().and_then(|s| s.to_str()).unwrap_or(&note_stem);
            crate::document::markdown::create_note_dir_zip(dir, actual_stem)
        }
        _ => {
            if let Some(file_path) = resolve_file_path(documents_dir, clean_fname) {
                use std::io::{Cursor, Write};
                use zip::write::SimpleFileOptions;
                use zip::ZipWriter;

                let mut zip = ZipWriter::new(Cursor::new(Vec::new()));
                let dir_opt = SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
                let file_opt = SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);

                let root_entry = format!("{}/", note_stem);
                let _ = zip.add_directory(&root_entry, dir_opt);
                let assets_entry = format!("{}assets/", root_entry);
                let _ = zip.add_directory(&assets_entry, dir_opt);
                if let Ok(data) = fs::read(&file_path) {
                    let _ = zip.start_file(format!("{}{}.md", root_entry, note_stem), file_opt);
                    let _ = zip.write_all(&data);
                }

                // Fallback rétrocompatible pour les assets historiques dans documents/assets/<stem>/
                let legacy_assets_dir = documents_dir.join("assets").join(&note_stem);
                if legacy_assets_dir.is_dir() {
                    if let Ok(entries) = fs::read_dir(&legacy_assets_dir) {
                        for entry in entries.flatten() {
                            let p = entry.path();
                            if p.is_file() {
                                if let Some(fname) = p.file_name().and_then(|s| s.to_str()) {
                                    if let Ok(adata) = fs::read(&p) {
                                        let _ = zip.start_file(format!("{}{}", assets_entry, fname), file_opt);
                                        let _ = zip.write_all(&adata);
                                    }
                                }
                            }
                        }
                    }
                }

                zip.finish()
                    .map(|cursor| cursor.into_inner())
                    .map_err(|e| e.to_string())
            } else {
                return (
                    StatusCode::NOT_FOUND,
                    Json(serde_json::json!({"error": format!("Note introuvable : {}", clean_fname)})),
                )
                    .into_response();
            }
        }
    };

    match zip_bytes_res {
        Ok(zip_bytes) => {
            let zip_filename = format!("{}.zip", note_stem);
            (
                StatusCode::OK,
                [
                    (header::CONTENT_TYPE, "application/zip"),
                    (
                        header::CONTENT_DISPOSITION,
                        &format!("attachment; filename=\"{}\"", zip_filename),
                    ),
                ],
                zip_bytes,
            )
                .into_response()
        }
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"error": format!("Erreur génération archive zip : {}", e)})),
        )
            .into_response(),
    }
}

/// GET /api/files/export-zip/*filename : Télécharge une note sous la forme de son dossier complet (archive .zip) avec son .md et ses assets inclus
pub async fn export_note_zip_handler(
    State(state): State<Arc<AppState>>,
    Path(filename): Path<String>,
) -> Response {
    let clean_fname = filename.trim_start_matches('/');
    if clean_fname.contains("..") {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({"error": "Chemin non sécurisé"})),
        )
            .into_response();
    }

    generate_note_zip_response(&state.config.documents_dir, clean_fname)
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

    let is_markdown = clean_fname.ends_with(".md")
        || clean_fname.ends_with(".markdown")
        || detect_doc_type(&state.config.documents_dir.join(clean_fname)) == "markdown";

    let target_path = if is_markdown {
        crate::document::trash::resolve_file_path(&state.config.documents_dir, clean_fname)
            .unwrap_or_else(|| {
                let path_obj = std::path::Path::new(clean_fname);
                let stem = path_obj.file_stem().and_then(|s| s.to_str()).unwrap_or(clean_fname);
                let parent = path_obj.parent();
                let note_dir = match parent {
                    Some(p) if !p.as_os_str().is_empty() => state.config.documents_dir.join(p).join(stem),
                    _ => state.config.documents_dir.join(stem),
                };
                let _ = fs::create_dir_all(note_dir.join("assets"));
                note_dir.join(format!("{}.md", stem))
            })
    } else {
        state.config.documents_dir.join(clean_fname)
    };

    // Assainir les refs blob: mortes + réparer les refs assets non encodées avant
    // écriture (notes MD uniquement) : le fichier disque converge vers des URLs valides.
    let body_bytes: std::borrow::Cow<'_, [u8]> = if is_markdown {
        match std::str::from_utf8(&body) {
            Ok(text) => {
                let sanitized = sanitize_blob_references(text);
                std::borrow::Cow::Owned(heal_asset_references(&sanitized).into_bytes())
            }
            Err(_) => std::borrow::Cow::Borrowed(&body),
        }
    } else {
        std::borrow::Cow::Borrowed(&body)
    };

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
    if let Err(e) = fs::write(&tmp_path, &body_bytes) {
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

    // Nettoyage immédiat des pièces jointes orphelines (PJ supprimées du texte)
    if is_markdown {
        if let Some(note_dir) = target_path.parent() {
            let _ = fs::create_dir_all(note_dir.join("assets"));
            if let Ok(text) = std::str::from_utf8(&body_bytes) {
                crate::document::markdown::clean_orphan_markdown_assets(note_dir, text);
            }
        }
    }

    // Nettoyer d'éventuels résidus en corbeille (restauration implicite)
    let trash_target = state.config.trash_dir.join(format!("del_{}", clean_fname));
    let trash_meta = state.config.trash_dir.join(format!("del_{}.meta.json", clean_fname));
    let _ = fs::remove_file(&trash_target);
    let _ = fs::remove_file(&trash_meta);

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

            let is_md = doc_type == "markdown" || clean_fname.ends_with(".md") || clean_fname.ends_with(".markdown");
            let doc_id = match existing_id {
                Some(id) => {
                    let initial_status = if is_md { "ready" } else { "pending" };
                    let _ = conn.execute(
                        "UPDATE documents SET status = ?1, deleted_at = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?2",
                        params![initial_status, id],
                    );
                    if !is_md {
                        state.pipeline.enqueue(id);
                    }
                    id
                }
                None => {
                    let stem = target_path
                        .file_stem()
                        .and_then(|s| s.to_str())
                        .unwrap_or(clean_fname)
                        .replace('_', " ");
                    let file_size = body_bytes.len() as i64;
                    let initial_status = if is_md { "ready" } else { "pending" };
                    let insert_res = conn.execute(
                        "INSERT INTO documents (filename, title, file_size, doc_type, status) VALUES (?1, ?2, ?3, ?4, ?5)",
                        params![clean_fname, stem, file_size, doc_type, initial_status],
                    );
                    if insert_res.is_ok() {
                        let new_id = conn.last_insert_rowid();
                        if !is_md {
                            state.pipeline.enqueue(new_id);
                        }
                        new_id
                    } else {
                        0
                    }
                }
            };
            if doc_id > 0 && (clean_fname.ends_with(".md") || clean_fname.ends_with(".markdown")) {
                // Plus de couverture pré-générée : /api/cover rend à la volée.

                // Indexation synchrone immédiate dans SQLite & FTS5
                let _ = crate::document::markdown::index_markdown_file(&conn, &state.config, &target_path, &clean_fname);
                let _ = conn.execute("UPDATE documents SET status = 'ready' WHERE id = ?1", params![doc_id]);
            }
            doc_id
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

    if payload.filename.contains('/') || payload.filename.contains('\\') || fname.contains("..") {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({"error": "Le titre d'une note ne peut pas contenir de barre oblique ('/' ou '\\')"})),
        )
            .into_response();
    }

    let raw_name = PathBuf::from(&fname)
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or(&fname)
        .to_string();

    let stem = PathBuf::from(&raw_name)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or(&raw_name)
        .trim()
        .to_string();

    let (note_dir, target_path, rel_fname, target_folder_id) = match payload.folder_id {
        Some(fid) => {
            let conn_res = state.db.get();
            if let Ok(conn) = conn_res {
                if let Some(folder_rel) = crate::routes::folders::get_folder_relative_path(&conn, fid) {
                    let parent_dir = state.config.documents_dir.join(&folder_rel);
                    let n_dir = parent_dir.join(&stem);
                    let t_path = n_dir.join(format!("{}.md", stem));
                    let full_rel = format!("{}/{}", folder_rel.to_string_lossy(), raw_name);
                    (n_dir, t_path, full_rel, Some(fid))
                } else {
                    let n_dir = state.config.documents_dir.join(&stem);
                    let t_path = n_dir.join(format!("{}.md", stem));
                    (n_dir, t_path, fname.clone(), None)
                }
            } else {
                let n_dir = state.config.documents_dir.join(&stem);
                let t_path = n_dir.join(format!("{}.md", stem));
                (n_dir, t_path, fname.clone(), None)
            }
        }
        None => {
            let n_dir = state.config.documents_dir.join(&stem);
            let t_path = n_dir.join(format!("{}.md", stem));
            (n_dir, t_path, fname.clone(), None)
        }
    };

    if target_path.exists()
        || (note_dir.is_dir() && note_dir.join(format!("{}.md", stem)).exists())
        || (state.config.documents_dir.join(&rel_fname).is_file())
    {
        return (
            StatusCode::CONFLICT,
            Json(serde_json::json!({
                "error": format!("Un fichier portant le nom '{}' existe déjà. Choisissez un autre titre.", rel_fname)
            })),
        )
            .into_response();
    }

    let assets_dir = note_dir.join("assets");
    if let Err(e) = fs::create_dir_all(&assets_dir) {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"error": format!("Impossible de créer le dossier de note : {}", e)})),
        )
            .into_response();
    }

    let content = if payload.content.is_empty() {
        let title = stem.replace('_', " ");
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
            let stem = PathBuf::from(&raw_name)
                .file_stem()
                .and_then(|s| s.to_str())
                .unwrap_or(&raw_name)
                .replace('_', " ");
            let file_size = content.len() as i64;
            let res = conn.execute(
                "INSERT INTO documents (filename, title, file_size, folder_id, doc_type, status) VALUES (?1, ?2, ?3, ?4, 'markdown', 'ready')",
                params![rel_fname, stem, file_size, target_folder_id],
            );
            if res.is_ok() {
                let id = conn.last_insert_rowid();
                // Plus de couverture pré-générée : /api/cover rend à la volée.

                // Indexation synchrone dans FTS5
                let _ = crate::document::markdown::index_markdown_file(&conn, &state.config, &target_path, &rel_fname);
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
            filename: Some(rel_fname),
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
    // Résoudre le dossier de la note ou le préparer dans documents_dir/<clean_stem>
    let note_dir = crate::document::trash::resolve_note_dir(&state.config.documents_dir, &clean_stem)
        .unwrap_or_else(|| state.config.documents_dir.join(&clean_stem));
    let assets_dir = note_dir.join("assets");
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
                // URL 100% encodée (pourcentage) : les refs Markdown `![..](..)`
                // doivent rester des destinations CommonMark valides — des espaces
                // bruts rendent la ligne non parsable (image invisible, texte brut).
                let relative_url = format!(
                    "/api/assets/{}/{}",
                    encode_uri_component(&clean_stem),
                    encode_uri_component(&safe_name),
                );
                saved_files.push(serde_json::json!({
                    "name": safe_name,
                    "url": relative_url,
                }));
            }
        }
    }

    // Plus d'invalidation de vignettes : /api/cover et /api/crop regénèrent
    // toujours à la volée depuis l'état courant de la note et de ses assets.

    (
        StatusCode::OK,
        Json(serde_json::json!({
            "status": "ok",
            "assets": saved_files,
        })),
    )
        .into_response()
}

/// Retrouve l'id du document Markdown correspondant à un stem de dossier d'assets
/// (`assets/<stem>/` ⇔ `documents/<stem>.md`). Tolérant NFC/NFD (macOS/Linux).
#[allow(dead_code)]
fn stem_to_doc_id(conn: &rusqlite::Connection, stem: &str) -> i64 {
    use unicode_normalization::UnicodeNormalization;
    let stem_nfc: String = stem.nfc().collect();

    let lookup = |pattern: &str| -> Option<i64> {
        conn.query_row(
            "SELECT id FROM documents WHERE (filename = ?1 OR filename LIKE ?2) AND COALESCE(doc_type, 'pdf') = 'markdown' LIMIT 1",
            rusqlite::params![pattern, format!("%/{}", pattern)],
            |r| r.get::<_, i64>(0),
        )
        .ok()
    };

    if let Some(id) = lookup(stem) {
        return id;
    }

    // Recherche résiliente NFC/NFD parmi tous les documents Markdown
    if let Ok(mut stmt) = conn.prepare(
        "SELECT id, filename FROM documents WHERE COALESCE(doc_type, 'pdf') = 'markdown'",
    ) {
        if let Ok(rows) = stmt.query_map([], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?))) {
            for row in rows.flatten() {
                let (id, fname) = row;
                let stem_fname = std::path::Path::new(&fname)
                    .file_stem()
                    .and_then(|s| s.to_str())
                    .unwrap_or("");
                let nfc: String = stem_fname.nfc().collect();
                if nfc == stem_nfc {
                    return id;
                }
            }
        }
    }

    0
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

    // 1. Chercher dans le dossier de la note résolu (nom_de_la_note/assets/)
    let note_asset = crate::document::trash::resolve_note_dir(&state.config.documents_dir, &clean_stem)
        .map(|nd| nd.join("assets").join(&safe_asset))
        .filter(|p| p.is_file());

    // 2. Chercher dans documents_dir/<clean_stem>/assets/<safe_asset>
    let direct_note_asset = state.config.documents_dir.join(&clean_stem).join("assets").join(&safe_asset);

    // 3. Fallback sur l'ancien format documents_dir/assets/<clean_stem>/<safe_asset>
    let legacy_asset = state.config.documents_dir.join("assets").join(&clean_stem).join(&safe_asset);

    let asset_path = if let Some(p) = note_asset {
        p
    } else if direct_note_asset.is_file() {
        direct_note_asset
    } else if legacy_asset.is_file() {
        legacy_asset
    } else {
        return (StatusCode::NOT_FOUND, "Asset non trouvé").into_response();
    };

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

/// Encodage pourcentage d'un composant d'URL (équivalent encodeURIComponent JS) :
/// caractères non réservés inchangés, tout le reste encodé en %XX UTF-8. Les URLs
/// insérées dans les refs Markdown `![alt](url)` doivent être sans espaces bruts
/// pour rester des destinations CommonMark valides.
pub fn encode_uri_component(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for byte in s.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'!' | b'~' | b'*'
            | b'\'' | b'(' | b')' => out.push(byte as char),
            other => {
                out.push('%');
                out.push_str(&format!("{:02X}", other));
            }
        }
    }
    out
}

/// Supprime du Markdown les références d'images `blob:` non persistées (résidus
/// d'anciens collages avant le hook onUpload de Crepe). Lignes entières si
/// l'image est seule, inline sinon — idempotent et sans effet sur les URLs
/// `assets/` légitimes.
pub fn sanitize_blob_references(md: &str) -> String {
    const BLOB_PREFIX: &str = "blob:http";

    let mut cleaned_lines: Vec<String> = Vec::with_capacity(md.lines().count());
    for line in md.lines() {
        let trimmed = line.trim();
        if trimmed.contains(BLOB_PREFIX) {
            if trimmed.starts_with("![") {
                continue; // Ligne image dédiée avec blob: → supprimée
            }
            let inline_only_blob = trimmed
                .split("\"")
                .all(|seg| seg.is_empty() || seg.contains(BLOB_PREFIX) || seg.trim() == "!");
            if inline_only_blob {
                continue;
            }
            cleaned_lines.push(line.replace(BLOB_PREFIX, ""));
            continue;
        }
        cleaned_lines.push(line.to_string());
    }

    let mut out = cleaned_lines.join("\n");
    // Conserver le saut de ligne final éventuel (lines() le perd)
    if md.ends_with('\n') {
        out.push('\n');
    }
    // Compacter les triplets+ de lignes vides laissés par les suppressions
    while out.contains("\n\n\n\n") {
        out = out.replace("\n\n\n\n", "\n\n\n");
    }
    out
}

/// Répare les références d'assets créées avant l'encodage URL : pour chaque ref
/// image `![alt](...)` pointant vers /api/assets/… ou assets/… contenant des
/// caractères interdits dans une destination CommonMark (espaces, accents bruts),
/// réécrit l'URL en pourcentage. Sans cela, Milkdown affiche la ligne comme texte
/// brut (l'image est invisible) et le contenu de recherche montre la syntaxe.
pub fn heal_asset_references(md: &str) -> String {
    if !md.contains("](") {
        return md.to_string();
    }
    let mut changed = false;
    let mut out_lines = Vec::with_capacity(md.lines().count() + 1);
    for line in md.lines() {
        let mut out = line.to_string();
        let trimmed = line.trim_start();
        if trimmed.starts_with("![") || trimmed.starts_with("!\\[") {
            if let Some(open) = line.find("](") {
                if let Some(close_rel) = line[open + 2..].find(')') {
                    let close = open + 2 + close_rel;
                    let url = &line[open + 2..close];
                    // Normalisation : `assets/…` (relatif, aucune route HTTP) → `/api/assets/…`.
                    // Encodage si l'URL contient des caractères interdits en destination
                    // CommonMark (espaces, accents bruts) ou reste relative.
                    let normalized = if let Some(rest) = url.strip_prefix("assets/") {
                        format!("/api/assets/{rest}")
                    } else {
                        url.to_string()
                    };
                    let is_asset = normalized.starts_with("/api/assets/");
                    let needs_fix = is_asset
                        && (normalized.bytes().any(|b| b <= 0x20 || b >= 0x7F)
                            || url.starts_with("assets/"));
                    // Alt dégénéré : le bloc image de Crepe insère parfois un alt
                    // numérique (« 1.00 ») — on le remplace par le nom du fichier.
                    let img_start = line.find("![").unwrap_or(0);
                    let alt = &line[img_start + 2..open];
                    let alt_is_numeric = !alt.is_empty()
                        && alt.trim().parse::<f64>().is_ok();
                    if needs_fix || (is_asset && alt_is_numeric) {
                        let (prefix, name) = match normalized.rsplit_once('/') {
                            Some((p, n)) => (format!("{p}/"), n),
                            None => (String::new(), normalized.as_str()),
                        };
                        let mut healed_prefix = String::new();
                        for (i, seg) in prefix.split('/').enumerate() {
                            if i > 0 {
                                healed_prefix.push('/');
                            }
                            healed_prefix.push_str(&encode_uri_segment(seg));
                        }
                        let new_alt = if alt_is_numeric {
                            percent_decode(name)
                        } else {
                            alt.to_string()
                        };
                        out = format!(
                            "{}{}]({}{}{}",
                            &line[..img_start + 2],
                            new_alt,
                            healed_prefix,
                            encode_uri_segment(name),
                            &line[close..]
                        );
                        changed = true;
                    }
                }
            }
        }
        out_lines.push(out);
    }
    if changed {
        let mut res = out_lines.join("\n");
        if md.ends_with('\n') {
            res.push('\n');
        }
        res
    } else {
        md.to_string()
    }
}

/// Décodage pourcentage tolérant (les octets invalides restent tels quels).
fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        let decoded = if bytes[i] == b'%' {
            bytes
                .get(i + 1..i + 3)
                .and_then(|h| std::str::from_utf8(h).ok())
                .and_then(|h| u8::from_str_radix(h, 16).ok())
        } else {
            None
        };
        if let Some(v) = decoded {
            out.push(v);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Encodage d'un segment en préservant les séquences %XX déjà valides (pas de
/// double-encodage `%20` → `%2520`) : les segments mixtes (texte brut + %XX) restent corrects.
fn encode_uri_segment(s: &str) -> String {
    if !s.bytes().any(|b| b <= 0x20 || b >= 0x7F) {
        return s.to_string(); // déjà propre (éventuellement %XX), ne pas retoucher
    }
    let chars: Vec<char> = s.chars().collect();
    let mut out = String::with_capacity(s.len());
    let mut i = 0;
    while i < chars.len() {
        if chars[i] == '%'
            && i + 2 < chars.len()
            && chars[i + 1].is_ascii_hexdigit()
            && chars[i + 2].is_ascii_hexdigit()
        {
            out.push('%');
            out.push(chars[i + 1]);
            out.push(chars[i + 2]);
            i += 3;
        } else {
            out.push_str(&encode_uri_component(&chars[i].to_string()));
            i += 1;
        }
    }
    out
}

#[cfg(test)]
mod heal_tests {
    use super::*;

    #[test]
    fn test_heal_encodes_spaces_in_asset_url() {
        let md = "# T\n\n![image.png](assets/Ma note pref 1/image.png)";
        let out = heal_asset_references(md);
        assert!(
            out.contains("(/api/assets/Ma%20note%20pref%201/image.png)"),
            "{out}"
        );
    }

    #[test]
    fn test_heal_normalizes_relative_to_api_path() {
        let md = "![img](assets/Ma%20note/image.png)";
        let out = heal_asset_references(md);
        assert!(out.contains("(/api/assets/Ma%20note/image.png)"), "{out}");
    }

    #[test]
    fn test_heal_encodes_accents_in_asset_url() {
        let md = "![x](/api/assets/Ma note/Capture d'écran 1.png)";
        let out = heal_asset_references(md);
        assert!(
            out.contains("(/api/assets/Ma%20note/Capture%20d'%C3%A9cran%201.png)"),
            "{out}"
        );
    }

    #[test]
    fn test_heal_replaces_numeric_alt_with_filename() {
        let md = "![1.00](/api/assets/Ma%20note%20pref%201/image.png)";
        let out = heal_asset_references(md);
        assert!(out.starts_with("![image.png]"), "{out}");
    }

    #[test]
    fn test_heal_replaces_numeric_alt_and_relative_url() {
        let md = "![2](assets/Ma note/img 1.png)";
        let out = heal_asset_references(md);
        assert!(out.starts_with("![img 1.png]"), "{out}");
        assert!(out.contains("(/api/assets/Ma%20note/img%201.png)"), "{out}");
    }

    #[test]
    fn test_heal_normalizes_encoded_relative_url() {
        // Déjà encodée mais relative → normalisée vers la route HTTP réelle,
        // sans double-encodage du %20 existant.
        let md = "![img](assets/Ma%20note%20pref%201/image.png)\n";
        let out = heal_asset_references(md);
        assert_eq!(out, "![img](/api/assets/Ma%20note%20pref%201/image.png)\n");
    }

    #[test]
    fn test_heal_keeps_absolute_encoded() {
        let md = "![img](/api/assets/Ma%20note%20pref%201/image.png)\n";
        assert_eq!(heal_asset_references(md), md);
    }

    #[test]
    fn test_heal_keeps_non_asset_urls() {
        let md = "![img](blob:http://localhost/x)\n[Lien](/api/other/a b)\ntexte libre";
        assert_eq!(heal_asset_references(md), md);
    }

    #[test]
    fn test_heal_preserves_trailing_newline() {
        let md = "![a](assets/S/t e.png)\n";
        let out = heal_asset_references(md);
        assert!(out.ends_with('\n'));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_sanitize_removes_dedicated_blob_image_line() {
        let md = "# Titre\n\nUne ligne.\n\n![1.00](blob:http://localhost:8080/d75ac1e2)\n\n![img](assets/N/img.png)";
        let out = sanitize_blob_references(md);
        assert!(!out.contains("blob:"), "blob doit disparaître : {out}");
        assert!(out.contains("assets/N/img.png"));
        assert!(out.contains("Une ligne."));
    }

    #[test]
    fn test_sanitize_keeps_regular_content() {
        let md = "# Titre\n\nVoir ![img](assets/N/img.png) et du texte.\n";
        assert_eq!(sanitize_blob_references(md), md);
    }

    #[test]
    fn test_sanitize_idempotent() {
        let md = "A\n\n![x](blob:http://h/1)\n\nB";
        let once = sanitize_blob_references(md);
        assert_eq!(sanitize_blob_references(&once), once);
    }
}

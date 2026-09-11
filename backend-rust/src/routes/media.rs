use axum::{
    body::Body,
    extract::{Path, Query, State},
    http::{header, HeaderMap, StatusCode},
    response::{IntoResponse, Response},
};
use rusqlite::params;
use serde::Deserialize;
use std::io::SeekFrom;
use std::sync::Arc;
use tokio::io::{AsyncReadExt, AsyncSeekExt};
use tokio_util::io::ReaderStream;

use crate::AppState;
use crate::pdf::crop::{compute_crop_path, generate_crops_for_page};

#[derive(Deserialize)]
pub struct CropQueryParams {
    pub h: Option<String>,
    pub terms: Option<String>,
}

/// Helper pour servir un fichier statique avec ETag et en-têtes de cache immutables
async fn serve_file_cache(
    path: &std::path::Path,
    content_type: &'static str,
    if_none_match: Option<&str>,
) -> Response {
    let meta = match tokio::fs::metadata(path).await {
        Ok(m) => m,
        Err(_) => return (StatusCode::NOT_FOUND, "Fichier introuvable").into_response(),
    };

    let file_len = meta.len();
    let mtime = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0);

    let etag = format!("\"w-{}-{}\"", file_len, mtime);

    if let Some(req_etag) = if_none_match {
        if req_etag == etag {
            return Response::builder()
                .status(StatusCode::NOT_MODIFIED)
                .header(header::ETAG, etag)
                .header(header::CACHE_CONTROL, "public, max-age=604800, immutable")
                .body(Body::empty())
                .unwrap_or_else(|_| (StatusCode::NOT_MODIFIED, "").into_response());
        }
    }

    match tokio::fs::read(path).await {
        Ok(bytes) => (
            StatusCode::OK,
            [
                (header::CONTENT_TYPE, content_type),
                (header::CACHE_CONTROL, "public, max-age=604800, immutable"),
                (header::ETAG, &etag),
            ],
            bytes,
        ).into_response(),
        Err(_) => (StatusCode::NOT_FOUND, "Fichier introuvable").into_response(),
    }
}

/// GET /api/cover/{doc_id}
pub async fn get_cover(
    State(state): State<Arc<AppState>>,
    Path(doc_id): Path<i64>,
    headers: HeaderMap,
) -> Response {
    let cover_webp = state.config.covers_dir.join(format!("{}.webp", doc_id));
    if !cover_webp.exists() {
        let filename: Option<String> = {
            let conn = match state.db.lock() {
                Ok(c) => c,
                Err(_) => return (StatusCode::INTERNAL_SERVER_ERROR, "Erreur DB").into_response(),
            };
            conn.query_row("SELECT filename FROM documents WHERE id = ?1", params![doc_id], |r| r.get(0)).ok()
        };

        let fname = match filename {
            Some(f) => f,
            None => return (StatusCode::NOT_FOUND, "Document introuvable en base").into_response(),
        };

        let file_path = state.config.documents_dir.join(&fname);
        if !file_path.exists() {
            return (StatusCode::NOT_FOUND, "Fichier PDF introuvable sur disque").into_response();
        }

        let state_clone = Arc::clone(&state);
        let cover_path_clone = cover_webp.clone();
        let render_res = tokio::task::spawn_blocking(move || {
            state_clone.pdf_engine.render_cover(&file_path, &cover_path_clone)
        }).await;

        match render_res {
            Ok(Ok(())) => {},
            Ok(Err(e)) => {
                tracing::warn!("[Media] Échec génération couverture doc {}: {}", doc_id, e);
                return (StatusCode::NOT_FOUND, "Échec rendu couverture").into_response();
            },
            Err(e) => {
                tracing::warn!("[Media] Erreur tâche bloquante couverture doc {}: {}", doc_id, e);
                return (StatusCode::INTERNAL_SERVER_ERROR, "Erreur rendu couverture").into_response();
            }
        }
    }

    let if_none_match = headers.get(header::IF_NONE_MATCH).and_then(|v| v.to_str().ok());
    serve_file_cache(&cover_webp, "image/webp", if_none_match).await
}

/// GET /api/crop/{doc_id}/{page}/{occ_id}
pub async fn get_crop(
    State(state): State<Arc<AppState>>,
    Path((doc_id, page, occ_id)): Path<(i64, i64, usize)>,
    Query(params): Query<CropQueryParams>,
    headers: HeaderMap,
) -> Response {
    let query_hash = params.h.unwrap_or_default();
    let terms = params.terms.unwrap_or_default();
    let if_none_match = headers.get(header::IF_NONE_MATCH).and_then(|v| v.to_str().ok());

    // 1. FAST-PATH: Servir immédiatement si déjà sur disque sans toucher SQLite ni le sémaphore
    let webp_path = compute_crop_path(&state.config, doc_id, page, occ_id, &query_hash);
    if webp_path.exists() {
        return serve_file_cache(&webp_path, "image/webp", if_none_match).await;
    }

    // 2. Récupération des données en base avec libération IMMÉDIATE du verrou SQLite
    let (words_json, filename) = {
        let conn = match state.db.lock() {
            Ok(c) => c,
            Err(_) => return (StatusCode::INTERNAL_SERVER_ERROR, "Erreur DB").into_response(),
        };
        let mut stmt = match conn.prepare(
            "SELECT p.words_json, d.filename FROM pages p JOIN documents d ON d.id = p.doc_id WHERE p.doc_id = ?1 AND p.page_number = ?2",
        ) {
            Ok(s) => s,
            Err(_) => return (StatusCode::NOT_FOUND, "Page introuvable").into_response(),
        };

        let row = stmt.query_row(params![doc_id, page], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
        });

        match row {
            Ok(val) => val,
            Err(_) => return (StatusCode::NOT_FOUND, "Document ou page introuvable").into_response(),
        }
    }; // <-- La connexion SQLite est déverrouillée immédiatement ici !

    // 3. Acquisition d'un permis de rendu Pdfium (limite à 2 tâches concurrentes pour préserver la RAM)
    let permit = match state.crop_semaphore.clone().acquire_owned().await {
        Ok(p) => p,
        Err(_) => return (StatusCode::INTERNAL_SERVER_ERROR, "Erreur sémaphore").into_response(),
    };

    // Vérification rapide post-sémaphore : un autre thread a pu générer le lot pour cette page entre temps
    if webp_path.exists() {
        drop(permit);
        return serve_file_cache(&webp_path, "image/webp", if_none_match).await;
    }

    let state_clone = Arc::clone(&state);
    let crop_path = match tokio::task::spawn_blocking(move || {
        let _permit = permit; // Maintient le permis actif pendant l'exécution Pdfium
        generate_crops_for_page(
            &state_clone.pdf_engine,
            &state_clone.config,
            doc_id,
            page,
            occ_id,
            &query_hash,
            &terms,
            &words_json,
            &filename,
        )
    }).await {
        Ok(res) => res,
        Err(_) => return (StatusCode::INTERNAL_SERVER_ERROR, "Erreur génération vignette").into_response(),
    };

    let path = match crop_path {
        Some(p) if p.exists() => p,
        _ => return (StatusCode::NOT_FOUND, "Vignette introuvable").into_response(),
    };

    serve_file_cache(&path, "image/webp", if_none_match).await
}


/// GET /api/pdf/{doc_id} avec support complet HTTP 206 Partial Content (Byte-Range), buffers 64 Ko et ETag
pub async fn get_pdf(
    State(state): State<Arc<AppState>>,
    Path(doc_id): Path<i64>,
    headers: HeaderMap,
) -> Response {
    let filename: Option<String> = {
        let conn = match state.db.lock() {
            Ok(c) => c,
            Err(_) => return (StatusCode::INTERNAL_SERVER_ERROR, "Erreur DB").into_response(),
        };
        conn.query_row("SELECT filename FROM documents WHERE id = ?1", params![doc_id], |r| r.get(0)).ok()
    };

    let fname = match filename {
        Some(f) => f,
        None => return (StatusCode::NOT_FOUND, "Document introuvable en base").into_response(),
    };

    let pdf_path = state.config.documents_dir.join(&fname);
    if !pdf_path.exists() {
        return (StatusCode::NOT_FOUND, "Fichier physique introuvable").into_response();
    }

    let file_size = match tokio::fs::metadata(&pdf_path).await {
        Ok(meta) => meta.len(),
        Err(_) => return (StatusCode::INTERNAL_SERVER_ERROR, "Erreur lecture fichier").into_response(),
    };

    // Génération de l'ETag pour économiser la bande passante (304 Not Modified)
    let etag = format!("\"doc-{}-{}\"", doc_id, file_size);
    if let Some(req_etag) = headers.get(header::IF_NONE_MATCH).and_then(|v| v.to_str().ok()) {
        if req_etag == etag {
            return Response::builder()
                .status(StatusCode::NOT_MODIFIED)
                .header(header::ETAG, etag)
                .header(header::CACHE_CONTROL, "public, max-age=86400")
                .body(Body::empty())
                .unwrap_or_else(|_| (StatusCode::NOT_MODIFIED, "").into_response());
        }
    }

    let range_header = headers.get(header::RANGE).and_then(|v| v.to_str().ok());

    if let Some(range_str) = range_header {
        // Ex: "bytes=0-1024" ou "bytes=500-"
        if let Some(spec) = range_str.strip_prefix("bytes=") {
            let parts: Vec<&str> = spec.split('-').collect();
            let start = parts.first().and_then(|s| s.parse::<u64>().ok()).unwrap_or(0);
            let end = parts
                .get(1)
                .and_then(|s| s.parse::<u64>().ok())
                .unwrap_or(file_size - 1);

            let end = end.min(file_size - 1);
            if start <= end && start < file_size {
                let length = end - start + 1;

                let mut file = match tokio::fs::File::open(&pdf_path).await {
                    Ok(f) => f,
                    Err(_) => return (StatusCode::INTERNAL_SERVER_ERROR, "Impossible d'ouvrir le fichier").into_response(),
                };

                if file.seek(SeekFrom::Start(start)).await.is_err() {
                    return (StatusCode::RANGE_NOT_SATISFIABLE, "Range invalide").into_response();
                }

                // Buffer de streaming 64 Ko pour saturer la bande passante sans fragmentation
                let buf_reader = tokio::io::BufReader::with_capacity(64 * 1024, file.take(length));
                let stream = ReaderStream::new(buf_reader);
                let body = Body::from_stream(stream);

                return Response::builder()
                    .status(StatusCode::PARTIAL_CONTENT)
                    .header(header::CONTENT_TYPE, "application/pdf")
                    .header(header::ACCEPT_RANGES, "bytes")
                    .header(header::CONTENT_RANGE, format!("bytes {}-{}/{}", start, end, file_size))
                    .header(header::CONTENT_LENGTH, length.to_string())
                    .header(header::ETAG, &etag)
                    .header(header::CACHE_CONTROL, "public, max-age=86400")
                    .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
                    .header(header::ACCESS_CONTROL_EXPOSE_HEADERS, "Accept-Ranges, Content-Range, Content-Length, Content-Encoding, ETag")
                    .header(header::HeaderName::from_static("x-accel-buffering"), "no")
                    .body(body)
                    .unwrap_or_else(|_| (StatusCode::INTERNAL_SERVER_ERROR, "Erreur réponse").into_response());
            }
        }
    }

    // Réponse complète (HTTP 200) si pas de Range ou range invalide
    let file = match tokio::fs::File::open(&pdf_path).await {
        Ok(f) => f,
        Err(_) => return (StatusCode::INTERNAL_SERVER_ERROR, "Impossible d'ouvrir le fichier").into_response(),
    };

    let buf_reader = tokio::io::BufReader::with_capacity(64 * 1024, file);
    let stream = ReaderStream::new(buf_reader);
    let body = Body::from_stream(stream);

    let safe_ascii_name: String = fname
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '.' || c == '-' || c == '_' { c } else { '_' })
        .collect();

    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, "application/pdf")
        .header(header::ACCEPT_RANGES, "bytes")
        .header(header::CONTENT_LENGTH, file_size.to_string())
        .header(header::CONTENT_DISPOSITION, format!("inline; filename=\"{}\"", safe_ascii_name))
        .header(header::ETAG, &etag)
        .header(header::CACHE_CONTROL, "public, max-age=86400")
        .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
        .header(header::ACCESS_CONTROL_EXPOSE_HEADERS, "Accept-Ranges, Content-Range, Content-Length, Content-Encoding, ETag")
        .header(header::HeaderName::from_static("x-accel-buffering"), "no")
        .body(body)
        .unwrap_or_else(|_| (StatusCode::INTERNAL_SERVER_ERROR, "Erreur réponse").into_response())
}

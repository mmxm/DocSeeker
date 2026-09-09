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
use crate::pdf::crop::get_or_generate_crop_on_demand;

#[derive(Deserialize)]
pub struct CropQueryParams {
    pub h: Option<String>,
    pub terms: Option<String>,
}

/// GET /api/cover/{doc_id}
pub async fn get_cover(
    State(state): State<Arc<AppState>>,
    Path(doc_id): Path<i64>,
) -> Response {
    let cover_webp = state.config.covers_dir.join(format!("{}.webp", doc_id));
    let cover_jpg = state.config.covers_dir.join(format!("{}.jpg", doc_id));

    let (file_path, content_type) = if cover_webp.exists() {
        (cover_webp, "image/webp")
    } else if cover_jpg.exists() {
        (cover_jpg, "image/jpeg")
    } else {
        // Fallback sur placeholder ou 404
        return (StatusCode::NOT_FOUND, "Couverture introuvable").into_response();
    };

    match tokio::fs::read(&file_path).await {
        Ok(bytes) => (
            StatusCode::OK,
            [
                (header::CONTENT_TYPE, content_type),
                (header::CACHE_CONTROL, "public, max-age=86400"),
            ],
            bytes,
        ).into_response(),
        Err(_) => (StatusCode::NOT_FOUND, "Fichier introuvable").into_response(),
    }
}

/// GET /api/crop/{doc_id}/{page}/{occ_id}
pub async fn get_crop(
    State(state): State<Arc<AppState>>,
    Path((doc_id, page, occ_id)): Path<(i64, i64, usize)>,
    Query(params): Query<CropQueryParams>,
) -> Response {
    let query_hash = params.h.unwrap_or_default();
    let terms = params.terms.unwrap_or_default();

    let crop_path = {
        let conn = match state.db.lock() {
            Ok(c) => c,
            Err(_) => return (StatusCode::INTERNAL_SERVER_ERROR, "Erreur DB").into_response(),
        };

        get_or_generate_crop_on_demand(
            &conn,
            &state.pdf_engine,
            &state.config,
            doc_id,
            page,
            occ_id,
            &query_hash,
            &terms,
        )
    };

    let path = match crop_path {
        Some(p) if p.exists() => p,
        _ => return (StatusCode::NOT_FOUND, "Vignette introuvable").into_response(),
    };

    match tokio::fs::read(&path).await {
        Ok(bytes) => (
            StatusCode::OK,
            [
                (header::CONTENT_TYPE, "image/webp"),
                (header::CACHE_CONTROL, "public, max-age=604800, immutable"),
            ],
            bytes,
        ).into_response(),
        Err(_) => (StatusCode::NOT_FOUND, "Fichier introuvable").into_response(),
    }
}

/// GET /api/pdf/{doc_id} avec support complet HTTP 206 Partial Content (Byte-Range)
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

    let range_header = headers.get(header::RANGE).and_then(|v| v.to_str().ok());

    if let Some(range_str) = range_header {
        // Ex: "bytes=0-1024" ou "bytes=500-"
        if let Some(spec) = range_str.strip_prefix("bytes=") {
            let parts: Vec<&str> = spec.split('-').collect();
            let start = parts.get(0).and_then(|s| s.parse::<u64>().ok()).unwrap_or(0);
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

                if let Err(_) = file.seek(SeekFrom::Start(start)).await {
                    return (StatusCode::RANGE_NOT_SATISFIABLE, "Range invalide").into_response();
                }

                let stream = ReaderStream::new(file.take(length));
                let body = Body::from_stream(stream);

                return Response::builder()
                    .status(StatusCode::PARTIAL_CONTENT)
                    .header(header::CONTENT_TYPE, "application/pdf")
                    .header(header::ACCEPT_RANGES, "bytes")
                    .header(header::CONTENT_RANGE, format!("bytes {}-{}/{}", start, end, file_size))
                    .header(header::CONTENT_LENGTH, length.to_string())
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

    let stream = ReaderStream::new(file);
    let body = Body::from_stream(stream);

    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, "application/pdf")
        .header(header::ACCEPT_RANGES, "bytes")
        .header(header::CONTENT_LENGTH, file_size.to_string())
        .header(header::CONTENT_DISPOSITION, format!("inline; filename=\"{}\"", fname))
        .body(body)
        .unwrap_or_else(|_| (StatusCode::INTERNAL_SERVER_ERROR, "Erreur réponse").into_response())
}

use axum::{
    body::Body,
    http::{header, HeaderValue, Response, StatusCode, Uri},
    response::IntoResponse,
};
use rust_embed::RustEmbed;
use std::path::PathBuf;

#[derive(RustEmbed)]
#[folder = "../frontend/"]
pub struct EmbeddedFrontend;

fn get_cache_control(path: &str) -> &'static str {
    if path == "sw.js" {
        "no-cache, no-store, must-revalidate"
    } else if path.ends_with(".html") || path == "index.html" {
        "no-cache"
    } else if path.starts_with("pdfjs/") {
        // Assets de PDF.js (viewer.mjs, pdf.mjs, pdf.worker.mjs, etc.) : mise en cache avec revalidation
        "public, max-age=86400, must-revalidate"
    } else if path.ends_with(".js")
        || path.ends_with(".mjs")
        || path.ends_with(".css")
        || path.ends_with(".woff2")
        || path.ends_with(".svg")
        || path.ends_with(".png")
        || path.ends_with(".webp")
    {
        "public, max-age=86400"
    } else {
        "public, max-age=3600"
    }
}

fn get_content_type(path: &str) -> &'static str {
    if path.ends_with(".wasm") {
        "application/wasm"
    } else if path.ends_with(".js") || path.ends_with(".mjs") {
        "text/javascript; charset=utf-8"
    } else if path.ends_with(".css") {
        "text/css; charset=utf-8"
    } else if path.ends_with(".json") {
        "application/json; charset=utf-8"
    } else if path.ends_with(".html") {
        "text/html; charset=utf-8"
    } else if path.ends_with(".svg") {
        "image/svg+xml"
    } else if path.ends_with(".png") {
        "image/png"
    } else if path.ends_with(".webp") {
        "image/webp"
    } else if path.ends_with(".ico") {
        "image/x-icon"
    } else {
        "application/octet-stream"
    }
}

pub async fn static_handler(uri: Uri) -> Response<Body> {
    let mut path = uri.path().trim_start_matches('/').to_string();

    if path.is_empty() || path == "index.html" {
        path = "index.html".to_string();
    }

    let cache_control = get_cache_control(&path);
    let content_type = get_content_type(&path);

    // 1. Essayer de servir depuis le disque si le dossier frontend/ existe à proximité
    let local_candidates = [
        PathBuf::from("frontend").join(&path),
        PathBuf::from("../frontend").join(&path),
    ];

    for local_path in &local_candidates {
        if local_path.exists() && local_path.is_file() {
            if let Ok(content) = tokio::fs::read(local_path).await {
                return Response::builder()
                    .status(StatusCode::OK)
                    .header(header::CONTENT_TYPE, HeaderValue::from_static(content_type))
                    .header(header::CACHE_CONTROL, HeaderValue::from_static(cache_control))
                    .body(Body::from(content))
                    .unwrap();
            }
        }
    }

    // 2. Fallback sur les assets embarqués (rust-embed)
    match EmbeddedFrontend::get(&path) {
        Some(content) => {
            Response::builder()
                .status(StatusCode::OK)
                .header(header::CONTENT_TYPE, HeaderValue::from_static(content_type))
                .header(header::CACHE_CONTROL, HeaderValue::from_static(cache_control))
                .body(Body::from(content.data))
                .unwrap()
        }
        None => {
            // Si ressource non trouvée et sans extension, fallback sur index.html (SPA)
            if !path.contains('.') {
                if let Some(index) = EmbeddedFrontend::get("index.html") {
                    return Response::builder()
                        .status(StatusCode::OK)
                        .header(header::CONTENT_TYPE, "text/html; charset=utf-8")
                        .header(header::CACHE_CONTROL, HeaderValue::from_static("no-cache"))
                        .body(Body::from(index.data))
                        .unwrap();
                }
            }
            (StatusCode::NOT_FOUND, "Fichier non trouvé").into_response()
        }
    }
}

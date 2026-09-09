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

pub async fn static_handler(uri: Uri) -> Response<Body> {
    let mut path = uri.path().trim_start_matches('/').to_string();

    if path.is_empty() || path == "index.html" {
        path = "index.html".to_string();
    }

    // 1. Essayer de servir depuis le disque si le dossier frontend/ existe à proximité
    let local_candidates = [
        PathBuf::from("frontend").join(&path),
        PathBuf::from("../frontend").join(&path),
    ];

    for local_path in &local_candidates {
        if local_path.exists() && local_path.is_file() {
            if let Ok(content) = tokio::fs::read(local_path).await {
                let mime = mime_guess::from_path(local_path).first_or_octet_stream();
                return Response::builder()
                    .status(StatusCode::OK)
                    .header(header::CONTENT_TYPE, HeaderValue::from_str(mime.as_ref()).unwrap())
                    .body(Body::from(content))
                    .unwrap();
            }
        }
    }

    // 2. Fallback sur les assets embarqués (rust-embed)
    match EmbeddedFrontend::get(&path) {
        Some(content) => {
            let mime = mime_guess::from_path(&path).first_or_octet_stream();
            Response::builder()
                .status(StatusCode::OK)
                .header(header::CONTENT_TYPE, HeaderValue::from_str(mime.as_ref()).unwrap())
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
                        .body(Body::from(index.data))
                        .unwrap();
                }
            }
            (StatusCode::NOT_FOUND, "Fichier non trouvé").into_response()
        }
    }
}

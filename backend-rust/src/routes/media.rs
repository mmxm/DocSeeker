use axum::{
    body::Body,
    extract::{Path, Query, State},
    http::{header, HeaderMap, StatusCode},
    response::{IntoResponse, Json, Response},
};
use rusqlite::params;
use serde::{Deserialize, Serialize};
use std::io::SeekFrom;
use std::sync::Arc;
use tokio::io::{AsyncReadExt, AsyncSeekExt};
use tokio_util::io::ReaderStream;

use crate::AppState;
use crate::pdf::crop::generate_crops_for_page;

#[derive(Deserialize)]
pub struct CropQueryParams {
    pub h: Option<String>,
    pub terms: Option<String>,
}

/// Helper pour servir des octets d'image WebP générés.
/// Le cache HTTP 7 jours avec ETag et stale-while-revalidate permet au navigateur
/// d'afficher instantanément les vignettes déjà vues sans recharger le serveur NAS.
async fn serve_image_bytes(
    bytes: Vec<u8>,
    etag: String,
    if_none_match: Option<&str>,
) -> Response {
    let cache_control = "public, max-age=604800, stale-while-revalidate=86400";
    if let Some(req_etag) = if_none_match {
        if req_etag == etag {
            return Response::builder()
                .status(StatusCode::NOT_MODIFIED)
                .header(header::ETAG, etag)
                .header(header::CACHE_CONTROL, cache_control)
                .body(Body::empty())
                .unwrap_or_else(|_| (StatusCode::NOT_MODIFIED, "").into_response());
        }
    }

    (
        StatusCode::OK,
        [
            (header::CONTENT_TYPE, "image/webp"),
            (header::CACHE_CONTROL, cache_control),
            (header::ETAG, etag.as_str()),
        ],
        bytes,
    )
        .into_response()
}

/// GET /api/cover/{doc_id} — génération à la volée avec cache.
pub async fn get_cover(
    State(state): State<Arc<AppState>>,
    Path(doc_id): Path<i64>,
    headers: HeaderMap,
) -> Response {
    let if_none_match = headers.get(header::IF_NONE_MATCH).and_then(|v| v.to_str().ok());
    let etag = format!("\"cover-{}\"", doc_id);

    // Vérifier le cache en mémoire pour la couverture sans détenir le verrou à travers await
    let cache_key = format!("cover:{}", doc_id);
    if let Some(cached_bytes) = state.crop_cache.get(&cache_key) {
        return serve_image_bytes(cached_bytes, etag, if_none_match).await;
    }

    // Vérifier le cache persistant sur disque (0ms, sans solliciter Pdfium ni le sémaphore)
    let cover_disk_path = state.config.covers_dir.join(format!("{}.webp", doc_id));
    if let Ok(bytes) = tokio::fs::read(&cover_disk_path).await {
        state.crop_cache.put(cache_key, bytes.clone());
        return serve_image_bytes(bytes, etag, if_none_match).await;
    }

    // 1. Vérification DB : récupérer le nom, l'état et le type du document
    let (filename, status, doc_type): (Option<String>, Option<String>, Option<String>) = {
        let conn = match state.db.get() {
            Ok(c) => c,
            Err(_) => return (StatusCode::INTERNAL_SERVER_ERROR, "Erreur DB").into_response(),
        };
        conn.query_row(
            "SELECT filename, COALESCE(status, 'ready'), COALESCE(doc_type, 'pdf') FROM documents WHERE id = ?1",
            params![doc_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        ).unwrap_or((None, None, None))
    };

    let fname = match filename {
        Some(f) => f,
        None => return (StatusCode::NOT_FOUND, "Document introuvable en base").into_response(),
    };

    let is_markdown = doc_type.as_deref() == Some("markdown") || fname.ends_with(".md") || fname.ends_with(".markdown");

    // Résolution du chemin physique
    let file_path = if is_markdown {
        match crate::document::trash::resolve_file_path(&state.config.documents_dir, &fname) {
            Some(p) => p,
            None => return (StatusCode::NOT_FOUND, "Fichier note introuvable sur disque").into_response(),
        }
    } else {
        match crate::pdf::indexer::resolve_pdf_path(&state.config.documents_dir, &fname) {
            Some(p) => p,
            None => return (StatusCode::NOT_FOUND, "Fichier PDF introuvable sur disque").into_response(),
        }
    };

    // Si le document PDF est en attente ou en cours d'indexation par le pipeline,
    // renvoyer immédiatement 202 Accepted sans bloquer sur Pdfium
    if !is_markdown {
        if let Some(ref st) = status {
            if st == "pending" || st == "indexing" {
                return (StatusCode::ACCEPTED, "Couverture en cours de génération").into_response();
            }
        }
    }

    // 2. Concurrence dédiée via cover_semaphore pour ne JAMAIS être bloqué par les batch crops
    let _permit = match state.cover_semaphore.clone().acquire_owned().await {
        Ok(p) => p,
        Err(_) => return (StatusCode::INTERNAL_SERVER_ERROR, "Erreur sémaphore").into_response(),
    };

    let state_clone = Arc::clone(&state);
    let is_md = is_markdown;
    let render_res = tokio::task::spawn_blocking(move || {
        let _permit = _permit;
        if is_md {
            crate::document::markdown::MarkdownProcessor::generate_cover_bytes(&file_path)
        } else {
            state_clone.pdf_engine.render_cover(&file_path)
        }
    }).await;

    match render_res {
        Ok(Ok(bytes)) => {
            state.crop_cache.put(cache_key, bytes.clone());
            // Persistance asynchrone sur disque pour les prochaines requêtes instantanées (0ms)
            let disk_file = cover_disk_path;
            let bytes_save = bytes.clone();
            tokio::spawn(async move {
                let _ = tokio::fs::write(disk_file, bytes_save).await;
            });
            serve_image_bytes(bytes, etag, if_none_match).await
        },
        Ok(Err(e)) => {
            tracing::warn!("[Media] Échec génération couverture doc {}: {}", doc_id, e);
            (StatusCode::NOT_FOUND, "Échec rendu couverture").into_response()
        },
        Err(e) => {
            tracing::warn!("[Media] Erreur tâche bloquante couverture doc {}: {}", doc_id, e);
            (StatusCode::INTERNAL_SERVER_ERROR, "Erreur rendu couverture").into_response()
        }
    }
}

/// GET /api/crop/{doc_id}/{page}/{occ_id} — génération optimisée avec cache LRU en mémoire et dédoublonnage.
pub async fn get_crop(
    State(state): State<Arc<AppState>>,
    Path((doc_id, page, occ_id)): Path<(i64, i64, usize)>,
    Query(params): Query<CropQueryParams>,
    headers: HeaderMap,
) -> Response {
    let query_hash = params.h.unwrap_or_default();
    let terms = params.terms.unwrap_or_default();
    let if_none_match = headers.get(header::IF_NONE_MATCH).and_then(|v| v.to_str().ok());

    let cache_key = format!("crop:{}:{}:{}:{}:{}", doc_id, page, occ_id, query_hash, terms);
    let etag = format!("\"crop-{}-{}-{}-{}\"", doc_id, page, occ_id, query_hash);

    // 1. Vérification immédiate du cache shardé en mémoire
    if let Some(cached_bytes) = state.crop_cache.get(&cache_key) {
        return serve_image_bytes(cached_bytes, etag, if_none_match).await;
    }

    // 2. Dédoublonnage des requêtes concurrentes identiques en vol
    let my_notify = {
        let mut in_flight = state.crop_in_flight.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(notify) = in_flight.get(&cache_key) {
            Some(Arc::clone(notify))
        } else {
            let notify = Arc::new(tokio::sync::Notify::new());
            in_flight.insert(cache_key.clone(), Arc::clone(&notify));
            None
        }
    };

    if let Some(notify) = my_notify {
        notify.notified().await;
        if let Some(cached_bytes) = state.crop_cache.get(&cache_key) {
            return serve_image_bytes(cached_bytes, etag, if_none_match).await;
        }
    }

    // 3. Récupération des données en base avec libération IMMÉDIATE du verrou SQLite
    let (filename, doc_type) = {
        let conn = match state.db.get() {
            Ok(c) => c,
            Err(_) => {
                let mut in_flight = state.crop_in_flight.lock().unwrap_or_else(|e| e.into_inner());
                if let Some(n) = in_flight.remove(&cache_key) { n.notify_waiters(); }
                return (StatusCode::INTERNAL_SERVER_ERROR, "Erreur DB").into_response();
            }
        };
        let mut stmt = match conn.prepare(
            "SELECT filename, COALESCE(doc_type, 'pdf') FROM documents WHERE id = ?1",
        ) {
            Ok(s) => s,
            Err(_) => {
                let mut in_flight = state.crop_in_flight.lock().unwrap_or_else(|e| e.into_inner());
                if let Some(n) = in_flight.remove(&cache_key) { n.notify_waiters(); }
                return (StatusCode::NOT_FOUND, "Document introuvable").into_response();
            }
        };

        match stmt.query_row(params![doc_id], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))) {
            Ok(val) => val,
            Err(_) => {
                let mut in_flight = state.crop_in_flight.lock().unwrap_or_else(|e| e.into_inner());
                if let Some(n) = in_flight.remove(&cache_key) { n.notify_waiters(); }
                return (StatusCode::NOT_FOUND, "Document introuvable").into_response();
            }
        }
    };

    let is_markdown = doc_type == "markdown" || filename.ends_with(".md") || filename.ends_with(".markdown");
    if is_markdown {
        // Pour les notes Markdown : générer une vignette d'extrait spécifique avec contexte et surbrillance
        let terms_vec: Vec<String> = terms
            .split(',')
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .collect();

        let md_bytes = match crate::document::trash::resolve_file_path(&state.config.documents_dir, &filename) {
            Some(file_path) => tokio::task::spawn_blocking(move || {
                crate::document::markdown::MarkdownProcessor::generate_crop_bytes(&file_path, occ_id, &terms_vec)
            }).await.unwrap_or_else(|_| Err("task join error".to_string())),
            None => Err("Fichier note introuvable sur disque".to_string()),
        };

        let notify_to_trigger = {
            let mut in_flight = state.crop_in_flight.lock().unwrap_or_else(|e| e.into_inner());
            in_flight.remove(&cache_key)
        };

        match md_bytes {
            Ok(bytes) if !bytes.is_empty() => {
                state.crop_cache.put(cache_key, bytes.clone());
                if let Some(notify) = notify_to_trigger {
                    notify.notify_waiters();
                }
                return serve_image_bytes(bytes, etag, if_none_match).await;
            }
            _ => {
                if let Some(notify) = notify_to_trigger {
                    notify.notify_waiters();
                }
                // Fallback sur la couverture du document si l'extrait n'a pas pu aboutir
                let cover_state = Arc::clone(&state);
                let cover_bytes = tokio::task::spawn_blocking(move || {
                    let fname = cover_state
                        .db
                        .get()
                        .ok()
                        .and_then(|c| {
                            c.query_row("SELECT filename FROM documents WHERE id = ?1", params![doc_id], |r| r.get::<_, String>(0)).ok()
                        })
                        .and_then(|f| crate::document::trash::resolve_file_path(&cover_state.config.documents_dir, &f));
                    fname.and_then(|p| crate::document::markdown::MarkdownProcessor::generate_cover_bytes(&p).ok())
                }).await.unwrap_or(None);

                if let Some(bytes) = cover_bytes {
                    let cover_etag = format!("\"cover-{}\"", doc_id);
                    return serve_image_bytes(bytes, cover_etag, if_none_match).await;
                }
                return (StatusCode::NOT_FOUND, "Vignette Markdown introuvable").into_response();
            }
        }
    }

    let words_json = {
        let conn = match state.db.get() {
            Ok(c) => c,
            Err(_) => {
                let mut in_flight = state.crop_in_flight.lock().unwrap_or_else(|e| e.into_inner());
                if let Some(n) = in_flight.remove(&cache_key) { n.notify_waiters(); }
                return (StatusCode::INTERNAL_SERVER_ERROR, "Erreur DB").into_response();
            }
        };
        let mut stmt = match conn.prepare(
            "SELECT words_json FROM pages WHERE doc_id = ?1 AND page_number = ?2",
        ) {
            Ok(s) => s,
            Err(_) => {
                let mut in_flight = state.crop_in_flight.lock().unwrap_or_else(|e| e.into_inner());
                if let Some(n) = in_flight.remove(&cache_key) { n.notify_waiters(); }
                return (StatusCode::NOT_FOUND, "Page introuvable").into_response();
            }
        };

        match stmt.query_row(params![doc_id, page], |r| r.get::<_, Option<String>>(0)) {
            Ok(Some(w)) => w,
            Ok(None) => "[]".to_string(),
            Err(_) => {
                let mut in_flight = state.crop_in_flight.lock().unwrap_or_else(|e| e.into_inner());
                if let Some(n) = in_flight.remove(&cache_key) { n.notify_waiters(); }
                return (StatusCode::NOT_FOUND, "Page introuvable").into_response();
            }
        }
    };

    // 4. Acquisition d'un permis de rendu Pdfium dynamique
    let permit = match state.crop_semaphore.clone().acquire_owned().await {
        Ok(p) => p,
        Err(_) => {
            let mut in_flight = state.crop_in_flight.lock().unwrap_or_else(|e| e.into_inner());
            if let Some(n) = in_flight.remove(&cache_key) { n.notify_waiters(); }
            return (StatusCode::INTERNAL_SERVER_ERROR, "Erreur sémaphore").into_response();
        }
    };

    let state_clone = Arc::clone(&state);
    let crop_bytes = match tokio::task::spawn_blocking(move || {
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
        Err(_) => {
            let mut in_flight = state.crop_in_flight.lock().unwrap_or_else(|e| e.into_inner());
            if let Some(n) = in_flight.remove(&cache_key) { n.notify_waiters(); }
            return (StatusCode::INTERNAL_SERVER_ERROR, "Erreur génération vignette").into_response();
        }
    };

    // 5. Mise en cache LRU et notification des requêtes en attente
    let notify_to_trigger = {
        let mut in_flight = state.crop_in_flight.lock().unwrap_or_else(|e| e.into_inner());
        in_flight.remove(&cache_key)
    };

    if let Some(ref bytes) = crop_bytes {
        state.crop_cache.put(cache_key, bytes.clone());
    }

    if let Some(notify) = notify_to_trigger {
        notify.notify_waiters();
    }

    match crop_bytes {
        Some(bytes) => serve_image_bytes(bytes, etag, if_none_match).await,
        None => (StatusCode::NOT_FOUND, "Vignette introuvable").into_response(),
    }
}


/// GET /api/pdf/{doc_id} avec support complet HTTP 206 Partial Content (Byte-Range), buffers 64 Ko et ETag
pub async fn get_pdf(
    State(state): State<Arc<AppState>>,
    Path(doc_id): Path<i64>,
    headers: HeaderMap,
) -> Response {
    let (filename, doc_type): (Option<String>, Option<String>) = {
        let conn = match state.db.get() {
            Ok(c) => c,
            Err(_) => return (StatusCode::INTERNAL_SERVER_ERROR, "Erreur DB").into_response(),
        };
        conn.query_row(
            "SELECT filename, COALESCE(doc_type, 'pdf') FROM documents WHERE id = ?1",
            params![doc_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        ).ok().unwrap_or((None, None))
    };

    let fname = match filename {
        Some(f) => f,
        None => return (StatusCode::NOT_FOUND, "Document introuvable en base").into_response(),
    };

    if doc_type.as_deref() == Some("markdown") || fname.ends_with(".md") || fname.ends_with(".markdown") {
        return (StatusCode::BAD_REQUEST, "Ce document est une note Markdown, non un fichier PDF").into_response();
    }

    let pdf_path = match crate::pdf::indexer::resolve_pdf_path(&state.config.documents_dir, &fname) {
        Some(p) => p,
        None => return (StatusCode::NOT_FOUND, "Fichier physique introuvable").into_response(),
    };

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
        // Ex: "bytes=0-1024", "bytes=500-" ou "bytes=-1024" (suffix byte range)
        if let Some(spec) = range_str.strip_prefix("bytes=") {
            let spec = spec.trim();
            let (start, end) = if let Some(suffix_str) = spec.strip_prefix('-') {
                // Suffix byte range: "bytes=-500" => derniers 500 octets du fichier (XRef/Trailer PDF.js)
                if let Ok(suffix_len) = suffix_str.parse::<u64>() {
                    let len = suffix_len.min(file_size);
                    (file_size.saturating_sub(len), file_size.saturating_sub(1))
                } else {
                    (0, file_size.saturating_sub(1))
                }
            } else if let Some(dash_idx) = spec.find('-') {
                let start_part = &spec[..dash_idx];
                let end_part = &spec[dash_idx + 1..];
                let start = start_part.parse::<u64>().unwrap_or(0);
                let end = if end_part.is_empty() {
                    file_size.saturating_sub(1)
                } else {
                    end_part.parse::<u64>().unwrap_or(file_size.saturating_sub(1))
                };
                (start, end)
            } else {
                (0, file_size.saturating_sub(1))
            };

            let end = end.min(file_size.saturating_sub(1));
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
                    .header(header::CONTENT_ENCODING, "identity")
                    .header(header::ETAG, &etag)
                    .header(header::CACHE_CONTROL, "public, max-age=86400, no-transform")
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
        .header(header::CONTENT_ENCODING, "identity")
        .header(header::CONTENT_DISPOSITION, format!("inline; filename=\"{}\"", safe_ascii_name))
        .header(header::ETAG, &etag)
        .header(header::CACHE_CONTROL, "public, max-age=86400, no-transform")
        .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
        .header(header::ACCESS_CONTROL_EXPOSE_HEADERS, "Accept-Ranges, Content-Range, Content-Length, Content-Encoding, ETag")
        .header(header::HeaderName::from_static("x-accel-buffering"), "no")
        .body(body)
        .unwrap_or_else(|_| (StatusCode::INTERNAL_SERVER_ERROR, "Erreur réponse").into_response())
}

// =========================================================================
// POST /api/crops/batch — Batch de vignettes pour un document
// Réduit N×M requêtes HTTP individuelles à M requêtes (une par document).
// =========================================================================

#[derive(Deserialize)]
pub struct BatchCropItem {
    pub doc_id: i64,
    pub page: i64,
    pub occ_id: usize,
    pub h: Option<String>,
    pub terms: Option<String>,
}

#[derive(Deserialize)]
pub struct BatchCropPayload {
    pub crops: Vec<BatchCropItem>,
}

#[derive(Serialize)]
pub struct BatchCropResult {
    /// Clé = "doc_id:page:occ_id" — valeur = data URL WebP ou null si échec
    pub results: std::collections::HashMap<String, Option<String>>,
}

/// POST /api/crops/batch
/// Accepte une liste de { doc_id, page, occ_id, h, terms } et retourne une
/// map occ_key → "data:image/webp;base64,..." pour chaque vignette générée.
pub async fn get_crops_batch(
    State(state): State<Arc<AppState>>,
    Json(payload): Json<BatchCropPayload>,
) -> Result<Json<BatchCropResult>, Response> {
    use std::collections::HashMap;

    let mut results: HashMap<String, Option<String>> = HashMap::new();
    let mut missing_items = Vec::new();

    // 1. Filtrer immédiatement les vignettes en cache mémoire (0ms, sans verrou ni sémaphore)
    for item in payload.crops {
        let key = format!("{}:{}:{}", item.doc_id, item.page, item.occ_id);
        let cache_key = format!(
            "crop:{}:{}:{}:{}:{}",
            item.doc_id,
            item.page,
            item.occ_id,
            item.h.as_deref().unwrap_or(""),
            item.terms.as_deref().unwrap_or("")
        );

        if let Some(cached_bytes) = state.crop_cache.get(&cache_key) {
            use base64::Engine;
            let data_url = format!(
                "data:image/webp;base64,{}",
                base64::engine::general_purpose::STANDARD.encode(&cached_bytes)
            );
            results.insert(key, Some(data_url));
        } else {
            missing_items.push((key, cache_key, item));
        }
    }

    if missing_items.is_empty() {
        return Ok(Json(BatchCropResult { results }));
    }

    // 2. Charger les métadonnées SQLite par doc_id / page de façon groupée
    let mut doc_filenames: HashMap<i64, Option<String>> = HashMap::new();
    let mut page_words: HashMap<(i64, i64), String> = HashMap::new();

    {
        if let Ok(conn) = state.db.get() {
            for (_, _, item) in &missing_items {
                if !doc_filenames.contains_key(&item.doc_id) {
                    let fname: Option<String> = conn.query_row(
                        "SELECT filename FROM documents WHERE id = ?1",
                        params![item.doc_id],
                        |r| r.get(0),
                    ).ok().flatten();
                    doc_filenames.insert(item.doc_id, fname);
                }
                let page_key = (item.doc_id, item.page);
                if !page_words.contains_key(&page_key) {
                    let wj: Option<String> = conn.query_row(
                        "SELECT words_json FROM pages WHERE doc_id = ?1 AND page_number = ?2",
                        params![item.doc_id, item.page],
                        |r| r.get(0),
                    ).ok().flatten();
                    page_words.insert(page_key, wj.unwrap_or_else(|| "[]".to_string()));
                }
            }
        }
    }

    // 3. Regrouper les vignettes par page pour mutualiser le rendu Pdfium et le parsing words_json
    let mut page_groups: HashMap<(i64, i64), Vec<(String, String, usize, String)>> = HashMap::new();
    for (key, cache_key, item) in missing_items {
        let terms = item.terms.unwrap_or_default();
        page_groups.entry((item.doc_id, item.page)).or_default().push((key, cache_key, item.occ_id, terms));
    }

    let futures = page_groups.into_iter().map(|((doc_id, page), group)| {
        let state = Arc::clone(&state);
        let fname_opt = doc_filenames.get(&doc_id).cloned().flatten();
        let words_json = page_words.get(&(doc_id, page)).cloned().unwrap_or_else(|| "[]".to_string());

        async move {
            let mut group_results = Vec::with_capacity(group.len());
            let fname = match fname_opt {
                Some(f) => f,
                None => {
                    for (k, _, _, _) in group {
                        group_results.push((k, None));
                    }
                    return group_results;
                }
            };

            let occ_ids: Vec<usize> = group.iter().map(|(_, _, occ_id, _)| *occ_id).collect();
            let terms_str = group.first().map(|(_, _, _, t)| t.as_str()).unwrap_or_default().to_string();

            let permit = match state.crop_semaphore.clone().acquire_owned().await {
                Ok(p) => p,
                Err(_) => {
                    for (k, _, _, _) in group {
                        group_results.push((k, None));
                    }
                    return group_results;
                }
            };

            let state_clone = Arc::clone(&state);
            let rendered_crops = tokio::task::spawn_blocking(move || {
                let _permit = permit;
                crate::pdf::crop::generate_crops_for_page_multi(
                    &state_clone.pdf_engine,
                    &state_clone.config,
                    doc_id,
                    page,
                    &occ_ids,
                    &terms_str,
                    &words_json,
                    &fname,
                )
            }).await.unwrap_or_default();

            use base64::Engine;
            let crop_map: HashMap<usize, Vec<u8>> = rendered_crops.into_iter().collect();

            for (key, cache_key, occ_id, _) in group {
                if let Some(bytes) = crop_map.get(&occ_id) {
                    state.crop_cache.put(cache_key, bytes.clone());
                    let data_url = format!(
                        "data:image/webp;base64,{}",
                        base64::engine::general_purpose::STANDARD.encode(bytes)
                    );
                    group_results.push((key, Some(data_url)));
                } else {
                    group_results.push((key, None));
                }
            }

            group_results
        }
    });

    let rendered_groups = futures_util::future::join_all(futures).await;
    for group_res in rendered_groups {
        for (key, data_url) in group_res {
            results.insert(key, data_url);
        }
    }

    Ok(Json(BatchCropResult { results }))
}

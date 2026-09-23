use axum::{
    body::Body,
    http::{header, HeaderValue, Response, StatusCode, Uri},
    response::IntoResponse,
};
use rust_embed::RustEmbed;
use sha2::{Digest, Sha256};
use std::path::PathBuf;
use std::sync::Mutex;

#[derive(RustEmbed)]
#[folder = "../frontend/"]
pub struct EmbeddedFrontend;

// =============================================================================
// Versionnement automatique des assets
// =============================================================================
// La version est dérivée du hash de contenu des fichiers applicatifs frontend
// (app.js, sw.js, index.html, style.css, workers, pdf-cache…). Elle est
// injectée dans index.html (?v=…, meta app-version) et sw.js (APP_VERSION)
// au moment du service : plus aucun bump manuel, donc plus de dérive entre
// fichiers (ex. meta « 10.5 » vs sw.js « 10.6 ») ni de code périmé resservi
// par le service worker après une modification frontend oubliée dans le bump.

/// Fichiers dont le contenu détermine la version. Un octet modifié dans l'un
/// d'eux change la version et déclenche le cycle de mise à jour du SW.
const VERSIONED_FILES: &[&str] = &[
    "index.html",
    "app.js",
    "sw.js",
    "style.css",
    "pdf-cache.js",
    "download-queue-manager.js",
    "offline-search-worker.js",
    "worker-setup.js",
    "crop-worker.js",
];

/// Version en cache mémoire, recalculée quand un fichier versionné change
/// (invalidation par mtime : coût nul en régime stable, réactif en dev).
static ASSET_VERSION_CACHE: Mutex<Option<(Option<std::time::SystemTime>, String)>> =
    Mutex::new(None);

fn max_mtime_of_versioned_files() -> Option<std::time::SystemTime> {
    let mut max: Option<std::time::SystemTime> = None;
    for file in VERSIONED_FILES {
        for base in [PathBuf::from("frontend"), PathBuf::from("../frontend")] {
            if let Ok(meta) = std::fs::metadata(base.join(file)) {
                if let Ok(mtime) = meta.modified() {
                    if max.map_or(true, |m| mtime > m) {
                        max = Some(mtime);
                    }
                }
            }
        }
    }
    max
}

fn compute_asset_version() -> String {
    let mut hasher = Sha256::new();
    let mut found_any = false;
    for file in VERSIONED_FILES {
        // Lire depuis le disque (source de vérité en dev comme en prod : le
        // static_handler sert déjà le disque en priorité) puis retomber sur
        // l'asset embarqué si le fichier est absent du disque.
        let content: Option<Vec<u8>> = {
            let candidates = [
                PathBuf::from("frontend").join(file),
                PathBuf::from("../frontend").join(file),
            ];
            let mut from_disk = None;
            for p in &candidates {
                if p.exists() {
                    if let Ok(bytes) = std::fs::read(p) {
                        from_disk = Some(bytes);
                        break;
                    }
                }
            }
            from_disk
        };
        let bytes = match content {
            Some(b) => b,
            None => match EmbeddedFrontend::get(file) {
                Some(f) => f.data.to_vec(),
                None => continue,
            },
        };
        found_any = true;
        hasher.update(file.as_bytes());
        hasher.update(&bytes);
    }

    if !found_any {
        return "dev".to_string();
    }
    let digest = hasher.finalize();
    // 12 caractères hexadécimaux : largement assez pour détecter un changement
    // (48 bits) tout en restant lisible dans les URLs et les logs.
    format!("h{}", &hex_encode(&digest[..6]))
}

fn hex_encode(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{:02x}", b)).collect()
}

/// Renvoie la version courante (recalculée si un fichier versionné a changé).
pub fn asset_version() -> String {
    let mtime = max_mtime_of_versioned_files();
    let mut guard = ASSET_VERSION_CACHE
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    match &*guard {
        Some((cached_mtime, v)) if *cached_mtime == mtime => v.clone(),
        _ => {
            let v = compute_asset_version();
            *guard = Some((mtime, v.clone()));
            v
        }
    }
}

/// Injecte la version dans un fichier texte au moment du service.
/// Tout littéral `__ASSET_VERSION__` est remplacé par la version réelle.
fn inject_version(bytes: Vec<u8>) -> Vec<u8> {
    let version = asset_version();
    // Remplacement octet par octet : sûr sur UTF-8 (le sentinel ne contient
    // que des ASCII) et ne réserve le coût d'une conversion String que si le
    // sentinel est présent.
    const SENTINEL: &[u8] = b"__ASSET_VERSION__";
    if bytes.windows(SENTINEL.len()).any(|w| w == SENTINEL) {
        String::from_utf8(bytes)
            .map(|s| s.replace("__ASSET_VERSION__", &version).into_bytes())
            .unwrap_or_else(|e| e.into_bytes())
    } else {
        bytes
    }
}

fn get_cache_control(path: &str) -> &'static str {
    if path == "sw.js" {
        "no-cache, no-store, must-revalidate"
    } else if path.ends_with(".html") || path == "index.html" {
        "no-cache"
    } else if path.ends_with(".js")
        || path.ends_with(".mjs")
        || path.ends_with(".css")
    {
        // Scripts et styles applicatifs — Y COMPRIS ceux de pdfjs/ (viewer.mjs,
        // pdf.mjs…) : revalidation systématique. Un max-age long ici laisse le
        // HTTP cache du navigateur servir du code périmé sous une URL ?v= fixe
        // (blocages « boutons morts », correctifs invisibles très difficiles à
        // diagnostiquer). Les binaires pdfjs (polices, images) restent en cache long.
        "no-cache"
    } else if path.starts_with("pdfjs/") {
        "public, max-age=86400, must-revalidate"
    } else if path.ends_with(".woff2")
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

fn respond(path: &str, content: Vec<u8>) -> Response<Body> {
    let cache_control = get_cache_control(path);
    let content_type = get_content_type(path);
    let content = inject_version(content);
    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, HeaderValue::from_static(content_type))
        .header(header::CACHE_CONTROL, HeaderValue::from_static(cache_control))
        .body(Body::from(content))
        .unwrap()
}

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
                return respond(&path, content);
            }
        }
    }

    // 2. Fallback sur les assets embarqués (rust-embed)
    match EmbeddedFrontend::get(&path) {
        Some(content) => respond(&path, content.data.to_vec()),
        None => {
            // Si ressource non trouvée et sans extension, fallback sur index.html (SPA)
            if !path.contains('.') {
                if let Some(index) = EmbeddedFrontend::get("index.html") {
                    return respond("index.html", index.data.to_vec());
                }
            }
            (StatusCode::NOT_FOUND, "Fichier non trouvé").into_response()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn version_est_stable_et_non_vide() {
        let v1 = compute_asset_version();
        let v2 = compute_asset_version();
        assert!(!v1.is_empty());
        assert_eq!(v1, v2, "le hash doit être déterministe");
        assert!(v1.starts_with('h'), "format attendu : h<12 hex>");
        assert_eq!(v1.len(), 13);
    }

    #[test]
    fn injection_remplace_le_sentinel() {
        let content = b"const APP_VERSION = '__ASSET_VERSION__';".to_vec();
        let out = inject_version(content);
        let out_str = String::from_utf8(out).unwrap();
        assert!(!out_str.contains("__ASSET_VERSION__"));
        assert!(out_str.contains("APP_VERSION = 'h"));
    }

    #[test]
    fn injection_est_sans_effet_sans_sentinel() {
        let content = b"console.log('aucun sentinel ici');".to_vec();
        let out = inject_version(content.clone());
        assert_eq!(out, content);
    }
}

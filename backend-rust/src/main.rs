mod auth;
mod config;
mod db;
mod pdf;
mod pipeline;
mod routes;
mod search;
mod static_files;

use std::sync::{Arc, Mutex};
use axum::{
    http::{header, HeaderValue, Request},
    middleware::{self, Next},
    response::Response,
    Router,
};
use rusqlite::Connection;
use tower_http::cors::{Any, CorsLayer};
use tracing::{info, warn};

use crate::auth::password::{hash_password, verify_password};
use crate::auth::rate_limit::LoginRateLimiter;
use crate::config::Config;
use crate::pdf::engine::PdfEngine;
use crate::pdf::indexer::scan_and_sync_documents;
use crate::pipeline::IndexingPipeline;
use crate::routes::create_api_router;
use crate::static_files::static_handler;

use std::num::NonZeroUsize;
use lru::LruCache;
use crate::search::types::SearchResponse;

pub struct AppState {
    pub config: Config,
    pub db: Arc<Mutex<Connection>>,
    pub pdf_engine: Arc<PdfEngine>,
    pub pipeline: Arc<IndexingPipeline>,
    pub rate_limiter: Arc<LoginRateLimiter>,
    pub crop_semaphore: Arc<tokio::sync::Semaphore>,
    pub search_cache: Arc<Mutex<LruCache<String, SearchResponse>>>,
}

fn setup_panic_hook(data_dir: std::path::PathBuf) {
    let crash_file = data_dir.join("crash.log");
    std::panic::set_hook(Box::new(move |info| {
        let timestamp = chrono::Local::now().to_rfc3339();
        let payload = if let Some(s) = info.payload().downcast_ref::<&str>() {
            *s
        } else if let Some(s) = info.payload().downcast_ref::<String>() {
            s.as_str()
        } else {
            "Payload de panic inconnu"
        };

        let location = info
            .location()
            .map(|l| format!("{}:{}:{}", l.file(), l.line(), l.column()))
            .unwrap_or_else(|| "Emplacement inconnu".to_string());

        let backtrace = std::backtrace::Backtrace::capture();

        let crash_report = format!(
            "\n==================== [FATAL CRASH / PANIC] ====================\n\
             Horodatage : {}\n\
             Message    : {}\n\
             Fichier    : {}\n\
             Pile d'appel (Backtrace) :\n{:?}\n\
             ===============================================================\n",
            timestamp, payload, location, backtrace
        );

        eprintln!("{}", crash_report);

        // Écriture persistante dans crash.log
        if let Ok(mut file) = std::fs::OpenOptions::new().create(true).append(true).open(&crash_file) {
            use std::io::Write;
            let _ = file.write_all(crash_report.as_bytes());
            let _ = file.flush();
        }
    }));
}

async fn shutdown_signal() {
    let ctrl_c = async {
        tokio::signal::ctrl_c()
            .await
            .expect("Échec d'écoute de l'événement Ctrl+C");
    };

    #[cfg(unix)]
    let terminate = async {
        if let Ok(mut stream) = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
            stream.recv().await;
        } else {
            std::future::pending::<()>().await;
        }
    };

    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();

    tokio::select! {
        _ = ctrl_c => {
            tracing::info!("[DocSeeker] Signal d'arrêt reçu (SIGINT / Ctrl+C). Fermeture ordonnée du serveur...");
        },
        _ = terminate => {
            tracing::info!("[DocSeeker] Signal d'arrêt système reçu (SIGTERM / Docker stop). Fermeture ordonnée du serveur...");
        },
    }
}

fn spawn_memory_watchdog() {
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(tokio::time::Duration::from_secs(30)).await;
            #[cfg(target_os = "linux")]
            {
                if let Ok(content) = tokio::fs::read_to_string("/proc/self/status").await {
                    let mut vmrss_kb = 0u64;
                    let mut vmpeak_kb = 0u64;
                    for line in content.lines() {
                        if line.starts_with("VmRSS:") {
                            if let Some(val) = line.split_whitespace().nth(1) {
                                vmrss_kb = val.parse().unwrap_or(0);
                            }
                        } else if line.starts_with("VmPeak:") {
                            if let Some(val) = line.split_whitespace().nth(1) {
                                vmpeak_kb = val.parse().unwrap_or(0);
                            }
                        }
                    }
                    let rss_mb = vmrss_kb / 1024;
                    let peak_mb = vmpeak_kb / 1024;
                    if rss_mb > 1500 {
                        tracing::warn!(
                            "[Memory Watchdog] Utilisation RAM TRÈS ÉLEVÉE : {} Mo (Pic : {} Mo). Risque de crash OOM Docker !",
                            rss_mb, peak_mb
                        );
                    } else if rss_mb > 800 {
                        tracing::info!(
                            "[Memory Watchdog] Utilisation RAM : {} Mo (Pic : {} Mo)",
                            rss_mb, peak_mb
                        );
                    }
                }
            }
        }
    });
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    // Support du healthcheck autonome pour conteneurs sans curl (Distroless)
    let args: Vec<String> = std::env::args().collect();
    if args.len() > 1 && args[1] == "--healthcheck" {
        let port: u16 = std::env::var("PORT")
            .ok()
            .and_then(|p| p.parse().ok())
            .unwrap_or(8080);
        let addr = std::net::SocketAddr::from(([127, 0, 0, 1], port));
        match std::net::TcpStream::connect_timeout(&addr, std::time::Duration::from_secs(2)) {
            Ok(_) => std::process::exit(0),
            Err(_) => std::process::exit(1),
        }
    }

    // Initialisation des logs structurés
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "docseeker_backend=info,tower_http=info".into()),
        )
        .init();

    info!("Démarrage de DocSeeker v2.0 (Moteur Rust & Sécurité Native)...");

    let config = Config::from_env();
    config.ensure_directories()?;

    // Installation du hook de panics et capture de crash log
    setup_panic_hook(config.data_dir.clone());

    // Vérification de présence d'un rapport de crash antérieur
    let crash_log_path = config.data_dir.join("crash.log");
    if crash_log_path.exists() {
        if let Ok(metadata) = std::fs::metadata(&crash_log_path) {
            if metadata.len() > 0 {
                tracing::warn!(
                    "[Diagnostic] Un journal de crash antérieur a été détecté : {:?} ({} octets). Consultez ce fichier si le conteneur a redémarré de manière inattendue.",
                    crash_log_path, metadata.len()
                );
            }
        }
    }

    // Démarrage du moniteur de mémoire
    spawn_memory_watchdog();

    // Initialisation Base de Données SQLite
    info!("Étape 1 : Initialisation des tables SQLite...");
    if let Err(e) = db::init_db(&config.db_path) {
        tracing::error!("Erreur lors de db::init_db : {:?}", e);
        return Err(e.into());
    }
    info!("Étape 2 : Ouverture de la connexion SQLite...");
    let conn = match db::open_connection(&config.db_path) {
        Ok(c) => c,
        Err(e) => {
            tracing::error!("Erreur lors de db::open_connection : {:?}", e);
            return Err(e.into());
        }
    };
    let _ = crate::auth::session::SessionManager::purge_expired_sessions(&conn);
    let db = Arc::new(Mutex::new(conn));

    // Initialisation ou synchronisation automatique du compte administrateur
    {
        let conn = db.lock().unwrap();
        let current_hash: Option<String> = conn
            .query_row("SELECT password_hash FROM admin_credentials WHERE id = 1", [], |r| r.get(0))
            .ok();

        let initial_password = config
            .default_admin_password
            .clone()
            .unwrap_or_else(|| "admin1234".to_string());

        let needs_update = match current_hash {
            None => true,
            Some(ref hash) => {
                // Si le mot de passe dans l'environnement ne correspond plus au hash en base
                !verify_password(&initial_password, hash)
            }
        };

        if needs_update {
            let hashed = hash_password(&initial_password).expect("Échec hachage mot de passe");
            conn.execute(
                "INSERT INTO admin_credentials (id, password_hash) VALUES (1, ?1) \
                 ON CONFLICT(id) DO UPDATE SET password_hash = excluded.password_hash, updated_at = CURRENT_TIMESTAMP",
                [&hashed],
            )?;
            info!("============================================================");
            info!("[Sécurité] Mot de passe administrateur synchronisé avec succès !");
            info!("============================================================");
        }
    }

    // Initialisation du moteur PDF (Pdfium)
    let pdf_engine = Arc::new(PdfEngine::new().expect("Échec initialisation PdfEngine"));

    // Initialisation du pipeline d'indexation asynchrone
    let pipeline = Arc::new(IndexingPipeline::new(
        Arc::clone(&db),
        Arc::clone(&pdf_engine),
        config.clone(),
    ));

    let rate_limiter = Arc::new(LoginRateLimiter::new());
    let crop_semaphore = Arc::new(tokio::sync::Semaphore::new(2));
    let search_cache = Arc::new(Mutex::new(LruCache::new(NonZeroUsize::new(100).unwrap())));

    let state = Arc::new(AppState {
        config: config.clone(),
        db,
        pdf_engine,
        pipeline,
        rate_limiter,
        crop_semaphore,
        search_cache,
    });

    // Synchronisation initiale des fichiers PDF en tâche de fond (démarrage serveur immédiat sans bloquer le healthcheck)
    {
        let bg_db = Arc::clone(&state.db);
        let bg_engine = Arc::clone(&state.pdf_engine);
        let bg_config = state.config.clone();
        let bg_cache = Arc::clone(&state.search_cache);
        tokio::task::spawn_blocking(move || {
            if let Ok(conn) = bg_db.lock() {
                let (added, files) = scan_and_sync_documents(&conn, &bg_engine, &bg_config);
                if added > 0 {
                    info!("[DocSeeker] {} document(s) synchronisé(s) en tâche de fond : {:?}", added, files);
                    if let Ok(mut cache) = bg_cache.lock() {
                        cache.clear();
                    }
                }

                // Vérification et génération en arrière-plan des couvertures manquantes
                if let Ok(mut stmt) = conn.prepare("SELECT id, filename FROM documents WHERE total_pages > 0") {
                    if let Ok(rows) = stmt.query_map([], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?))) {
                        let missing: Vec<(i64, String)> = rows.flatten()
                            .filter(|(id, _)| !bg_config.covers_dir.join(format!("{}.webp", id)).exists())
                            .collect();
                        if !missing.is_empty() {
                            info!("[Couvertures] {} couverture(s) manquante(s) détectée(s), génération en tâche de fond...", missing.len());
                            for (id, fname) in missing {
                                let pdf_path = bg_config.documents_dir.join(&fname);
                                let cover_path = bg_config.covers_dir.join(format!("{}.webp", id));
                                if pdf_path.exists() {
                                    if let Err(e) = bg_engine.render_cover(&pdf_path, &cover_path) {
                                        warn!("[Couvertures] Échec génération couverture doc {} : {}", id, e);
                                    }
                                }
                            }
                            info!("[Couvertures] Toutes les couvertures manquantes ont été générées avec succès !");
                        }
                    }
                }
            }
        });
    }

    // En-têtes HTTP de sécurité stricts (OWASP Top 10 - remplace Caddyfile)
    async fn security_headers_middleware(request: Request<axum::body::Body>, next: Next) -> Response {
        let mut response = next.run(request).await;
        let headers = response.headers_mut();

        headers.insert(header::X_CONTENT_TYPE_OPTIONS, HeaderValue::from_static("nosniff"));
        headers.insert(header::REFERRER_POLICY, HeaderValue::from_static("strict-origin-when-cross-origin"));
        headers.insert(
            header::HeaderName::from_static("permissions-policy"),
            HeaderValue::from_static("camera=(), microphone=(), geolocation=()"),
        );
        // Retrait de la signature serveur
        headers.remove(header::SERVER);
        response
    }

    // Configuration CORS et Compression
    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods(Any)
        .allow_headers(Any);

    let api_router = create_api_router(Arc::clone(&state));

    let app = Router::new()
        .merge(api_router)
        .fallback(static_handler)
        .layer(tower_http::compression::CompressionLayer::new())
        .layer(middleware::from_fn(security_headers_middleware))
        .layer(cors)
        .with_state(state);

    let addr = format!("{}:{}", config.host, config.port);
    info!("DocSeeker à l'écoute sur http://{}", addr);

    let listener = tokio::net::TcpListener::bind(&addr).await?;
    axum::serve(listener, app.into_make_service_with_connect_info::<std::net::SocketAddr>())
        .with_graceful_shutdown(shutdown_signal())
        .await?;

    Ok(())
}

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
use tracing::info;

use crate::auth::password::{hash_password, verify_password};
use crate::auth::rate_limit::LoginRateLimiter;
use crate::config::Config;
use crate::pdf::engine::PdfEngine;
use crate::pdf::indexer::scan_and_sync_documents;
use crate::pipeline::IndexingPipeline;
use crate::routes::create_api_router;
use crate::static_files::static_handler;

pub struct AppState {
    pub config: Config,
    pub db: Arc<Mutex<Connection>>,
    pub pdf_engine: Arc<PdfEngine>,
    pub pipeline: Arc<IndexingPipeline>,
    pub rate_limiter: Arc<LoginRateLimiter>,
    pub crop_semaphore: Arc<tokio::sync::Semaphore>,
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

    // Synchronisation initiale des fichiers PDF dans data/documents/
    {
        let conn = db.lock().unwrap();
        let (added, files) = scan_and_sync_documents(&conn, &pdf_engine, &config);
        if added > 0 {
            info!("[DocSeeker] {} document(s) synchronisé(s) au démarrage : {:?}", added, files);
        }
    }

    // Initialisation du pipeline d'indexation asynchrone
    let pipeline = Arc::new(IndexingPipeline::new(
        Arc::clone(&db),
        Arc::clone(&pdf_engine),
        config.clone(),
    ));

    let rate_limiter = Arc::new(LoginRateLimiter::new());
    let crop_semaphore = Arc::new(tokio::sync::Semaphore::new(2));

    let state = Arc::new(AppState {
        config: config.clone(),
        db,
        pdf_engine,
        pipeline,
        rate_limiter,
        crop_semaphore,
    });

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
        .layer(middleware::from_fn(security_headers_middleware))
        .layer(cors)
        .with_state(state);

    let addr = format!("{}:{}", config.host, config.port);
    info!("DocSeeker à l'écoute sur http://{}", addr);

    let listener = tokio::net::TcpListener::bind(&addr).await?;
    axum::serve(listener, app.into_make_service_with_connect_info::<std::net::SocketAddr>()).await?;

    Ok(())
}

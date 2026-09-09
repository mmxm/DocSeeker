pub mod annotations;
pub mod documents;
pub mod folders;
pub mod media;
pub mod search;

use axum::{
    middleware,
    routing::{get, patch, post},
    Router,
};
use std::sync::Arc;

use crate::auth::require_auth_middleware;
use crate::auth::routes::{change_password_handler, login_handler, logout_handler, setup_handler, status_handler};
use crate::AppState;

pub fn create_api_router(state: Arc<AppState>) -> Router<Arc<AppState>> {
    // Routes publiques (sans authentification préalable requise)
    let public_routes = Router::new()
        .route("/health", get(health_handler))
        .route("/version", get(version_handler))
        .route("/auth/status", get(status_handler))
        .route("/auth/login", post(login_handler))
        .route("/auth/setup", post(setup_handler));

    // Routes protégées par l'authentification native
    let protected_routes = Router::new()
        .route("/auth/logout", post(logout_handler))
        .route("/auth/change-password", post(change_password_handler))
        // Dossiers
        .route("/folders", get(folders::list_folders).post(folders::create_folder))
        .route("/folders/:id", patch(folders::update_folder).delete(folders::delete_folder))
        // Documents
        .route("/documents", get(documents::list_documents))
        .route("/documents/:id/status", get(documents::get_document_status))
        .route("/documents/:id", patch(documents::update_document).delete(documents::delete_document_handler))
        .route("/documents/:id/move", patch(documents::move_document))
        .route("/documents/batch-move", post(documents::batch_move_documents))
        .route("/documents/:id/reindex", post(documents::reindex_document))
        .route("/check-hash/:file_hash", get(documents::check_hash))
        .route("/upload", post(documents::upload_document))
        .route("/sync", post(documents::sync_documents_handler))
        // Pipeline
        .route("/pipeline/status", get(documents::get_pipeline_status))
        .route("/pipeline/retry-failed", post(documents::retry_failed_pipeline))
        // Recherche
        .route("/search", get(search::search_handler))
        .route("/doc-search", get(search::doc_search_handler))
        // Média & Streaming
        .route("/cover/:doc_id", get(media::get_cover))
        .route("/crop/:doc_id/:page/:occ_id", get(media::get_crop))
        .route("/pdf/:doc_id", get(media::get_pdf))
        // Annotations
        .route("/documents/:id/annotations", get(annotations::get_annotations).post(annotations::save_annotations))
        .route("/documents/:id/save-pdf", post(annotations::save_pdf))
        .layer(middleware::from_fn_with_state(
            Arc::clone(&state),
            require_auth_middleware,
        ));

    Router::new()
        .nest("/api", public_routes.merge(protected_routes))
}

async fn health_handler(
    axum::extract::State(state): axum::extract::State<Arc<AppState>>,
) -> axum::response::Response {
    use axum::http::StatusCode;
    use axum::response::IntoResponse;

    let is_db_ok = match state.db.lock() {
        Ok(conn) => conn.query_row("SELECT 1", [], |_| Ok(())).is_ok(),
        Err(_) => false,
    };

    if is_db_ok {
        axum::Json(serde_json::json!({
            "status": "ok",
            "service": "DocSeeker-Rust",
            "version": env!("CARGO_PKG_VERSION"),
        })).into_response()
    } else {
        (
            StatusCode::SERVICE_UNAVAILABLE,
            axum::Json(serde_json::json!({"status": "error", "message": "Base de données inaccessible"})),
        ).into_response()
    }
}

async fn version_handler() -> axum::Json<serde_json::Value> {
    axum::Json(serde_json::json!({
        "version": env!("CARGO_PKG_VERSION"),
        "backend": "Rust (Axum + Rusqlite + Pdfium)",
    }))
}

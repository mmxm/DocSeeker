pub mod password;
pub mod rate_limit;
pub mod routes;
pub mod session;
pub mod user_agent;

use axum::{
    extract::{Request, State},
    http::StatusCode,
    middleware::Next,
    response::{IntoResponse, Json, Response},
};
use std::sync::Arc;
use crate::AppState;
use self::routes::extract_session_token_with_query;
use self::session::SessionManager;

/// Middleware d'authentification vérifiant la validité de la session administrateur.
pub async fn require_auth_middleware(
    State(state): State<Arc<AppState>>,
    request: Request,
    next: Next,
) -> Response {
    let query_str = request.uri().query();
    let token = match extract_session_token_with_query(request.headers(), query_str) {
        Some(t) => t,
        None => {
            return (
                StatusCode::UNAUTHORIZED,
                Json(serde_json::json!({
                    "error": "Authentification requise",
                    "authenticated": false
                })),
            ).into_response();
        }
    };

    let conn = match state.db.get() {
        Ok(c) => c,
        Err(e) => {
            eprintln!("[Auth] Erreur acquisition connexion DB: {:?}", e);
            return (
                StatusCode::SERVICE_UNAVAILABLE,
                Json(serde_json::json!({
                    "error": "Service temporairement indisponible, veuillez réessayer",
                    "authenticated": false
                })),
            ).into_response();
        }
    };

    let is_valid = match SessionManager::validate_session(&conn, &token) {
        Ok(valid) => valid,
        Err(e) => {
            eprintln!("[Auth] Erreur validation session: {:?}", e);
            false
        }
    };

    if !is_valid {
        return (
            StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({
                "error": "Session expirée ou invalide",
                "authenticated": false
            })),
        ).into_response();
    }

    next.run(request).await
}

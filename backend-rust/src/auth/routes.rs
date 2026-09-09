use axum::{
    extract::{ConnectInfo, State},
    http::{header, HeaderMap, StatusCode},
    response::{IntoResponse, Json, Response},
};
use axum_extra::extract::cookie::{Cookie, SameSite};
use serde::{Deserialize, Serialize};
use std::net::SocketAddr;
use std::sync::Arc;
use tracing::{info, warn};

use super::password::{hash_password, verify_password};
use super::session::SessionManager;
use crate::AppState;

pub const COOKIE_NAME_SECURE: &str = "__Host-docseeker_session";
pub const COOKIE_NAME_FALLBACK: &str = "docseeker_session";

#[derive(Serialize)]
pub struct AuthStatusResponse {
    pub authenticated: bool,
    pub initialized: bool,
}

#[derive(Deserialize)]
pub struct LoginPayload {
    pub password: String,
}

#[derive(Deserialize)]
pub struct ChangePasswordPayload {
    pub current_password: String,
    pub new_password: String,
}

#[derive(Deserialize)]
pub struct SetupPayload {
    pub password: String,
}

/// Helper pour extraire l'adresse IP du client (depuis ConnectInfo ou X-Forwarded-For).
pub fn extract_client_ip(headers: &HeaderMap, connect_info: Option<&ConnectInfo<SocketAddr>>) -> String {
    if let Some(forwarded) = headers.get("x-forwarded-for").and_then(|v| v.to_str().ok()) {
        if let Some(first_ip) = forwarded.split(',').next() {
            return first_ip.trim().to_string();
        }
    }
    if let Some(real_ip) = headers.get("x-real-ip").and_then(|v| v.to_str().ok()) {
        return real_ip.trim().to_string();
    }
    if let Some(ci) = connect_info {
        return ci.0.ip().to_string();
    }
    "127.0.0.1".to_string()
}

/// Helper pour extraire le nom du cookie (Host prefix si HTTPS ou fallback si HTTP).
pub fn get_cookie_name(headers: &HeaderMap) -> &'static str {
    let is_https = headers
        .get("x-forwarded-proto")
        .and_then(|v| v.to_str().ok())
        .map(|v| v.eq_ignore_ascii_case("https"))
        .unwrap_or(false);

    if is_https {
        COOKIE_NAME_SECURE
    } else {
        COOKIE_NAME_FALLBACK
    }
}

pub fn extract_session_token(headers: &HeaderMap) -> Option<String> {
    if let Some(cookie_header) = headers.get(header::COOKIE).and_then(|v| v.to_str().ok()) {
        for cookie_str in cookie_header.split(';') {
            let cookie_str = cookie_str.trim();
            if let Some(stripped) = cookie_str.strip_prefix(COOKIE_NAME_SECURE) {
                if let Some(val) = stripped.strip_prefix('=') {
                    return Some(val.to_string());
                }
            }
            if let Some(stripped) = cookie_str.strip_prefix(COOKIE_NAME_FALLBACK) {
                if let Some(val) = stripped.strip_prefix('=') {
                    return Some(val.to_string());
                }
            }
        }
    }
    None
}

/// GET /api/auth/status
pub async fn status_handler(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> Json<AuthStatusResponse> {
    let conn = match state.db.lock() {
        Ok(c) => c,
        Err(_) => {
            return Json(AuthStatusResponse {
                authenticated: false,
                initialized: false,
            })
        }
    };

    // Vérifier si un mot de passe a été défini
    let has_credentials: bool = conn
        .query_row(
            "SELECT COUNT(*) FROM admin_credentials WHERE id = 1",
            [],
            |row| row.get::<_, i64>(0),
        )
        .map(|count| count > 0)
        .unwrap_or(false);

    let authenticated = if let Some(token) = extract_session_token(&headers) {
        SessionManager::validate_session(&conn, &token).unwrap_or(false)
    } else {
        false
    };

    Json(AuthStatusResponse {
        authenticated,
        initialized: has_credentials,
    })
}

/// POST /api/auth/login
pub async fn login_handler(
    State(state): State<Arc<AppState>>,
    connect_info: Option<ConnectInfo<SocketAddr>>,
    headers: HeaderMap,
    Json(payload): Json<LoginPayload>,
) -> Response {
    let ip = extract_client_ip(&headers, connect_info.as_ref());

    // Vérification du Rate Limiting
    if let Err(remaining) = state.rate_limiter.check_allowed(&ip) {
        warn!("[Auth] Tentative de connexion bloquée pour {} (lockout {}s restant)", ip, remaining.as_secs());
        return (
            StatusCode::TOO_MANY_REQUESTS,
            Json(serde_json::json!({
                "error": format!("Trop de tentatives infructueuses. Veuillez patienter {} secondes.", remaining.as_secs())
            })),
        ).into_response();
    }

    let conn = match state.db.lock() {
        Ok(c) => c,
        Err(_) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({"error": "Erreur interne de base de données"})),
            ).into_response()
        }
    };

    // Récupérer le hash du mot de passe
    let stored_hash: Result<String, _> = conn.query_row(
        "SELECT password_hash FROM admin_credentials WHERE id = 1",
        [],
        |row| row.get(0),
    );

    let is_valid = match stored_hash {
        Ok(hash) => verify_password(&payload.password, &hash),
        Err(_) => false,
    };

    if !is_valid {
        state.rate_limiter.record_failure(&ip);
        warn!("[Auth] Échec d'authentification pour l'IP {}", ip);
        return (
            StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({"error": "Mot de passe incorrect"})),
        ).into_response();
    }

    // Succès : réinitialiser le compteur d'échecs
    state.rate_limiter.record_success(&ip);

    let user_agent = headers.get(header::USER_AGENT).and_then(|v| v.to_str().ok());
    let token = match SessionManager::create_session(&conn, state.config.session_duration_days, user_agent, Some(&ip)) {
        Ok(t) => t,
        Err(e) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({"error": format!("Impossible de créer la session : {}", e)})),
            ).into_response()
        }
    };

    info!("[Auth] Connexion réussie pour l'IP {}", ip);

    // Construction du cookie sécurisé
    let cookie_name = get_cookie_name(&headers);
    let is_secure = cookie_name.starts_with("__Host-");

    let mut cookie = Cookie::build((cookie_name, token))
        .path("/")
        .http_only(true)
        .same_site(SameSite::Lax)
        .max_age(time::Duration::days(state.config.session_duration_days));

    if is_secure {
        cookie = cookie.secure(true);
    }

    let mut response = Json(serde_json::json!({
        "status": "ok",
        "message": "Authentification réussie"
    })).into_response();

    response.headers_mut().insert(
        header::SET_COOKIE,
        cookie.build().to_string().parse().unwrap(),
    );

    response
}

/// POST /api/auth/logout
pub async fn logout_handler(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> Response {
    if let Some(token) = extract_session_token(&headers) {
        if let Ok(conn) = state.db.lock() {
            let _ = SessionManager::revoke_session(&conn, &token);
        }
    }

    let cookie_name = get_cookie_name(&headers);
    let expired_cookie = Cookie::build((cookie_name, ""))
        .path("/")
        .http_only(true)
        .same_site(SameSite::Lax)
        .max_age(time::Duration::seconds(0))
        .build();

    let mut response = Json(serde_json::json!({
        "status": "ok",
        "message": "Déconnexion réussie"
    })).into_response();

    response.headers_mut().insert(
        header::SET_COOKIE,
        expired_cookie.to_string().parse().unwrap(),
    );

    response
}

/// POST /api/auth/change-password
pub async fn change_password_handler(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(payload): Json<ChangePasswordPayload>,
) -> Response {
    // Vérifier d'abord la session
    let token = match extract_session_token(&headers) {
        Some(t) => t,
        None => return (StatusCode::UNAUTHORIZED, Json(serde_json::json!({"error": "Non authentifié"}))).into_response(),
    };

    let conn = match state.db.lock() {
        Ok(c) => c,
        Err(_) => return (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": "Erreur DB"}))).into_response(),
    };

    if !SessionManager::validate_session(&conn, &token).unwrap_or(false) {
        return (StatusCode::UNAUTHORIZED, Json(serde_json::json!({"error": "Session invalide"}))).into_response();
    }

    // Vérifier l'ancien mot de passe
    let stored_hash: Result<String, _> = conn.query_row(
        "SELECT password_hash FROM admin_credentials WHERE id = 1",
        [],
        |row| row.get(0),
    );

    let is_valid = match stored_hash {
        Ok(hash) => verify_password(&payload.current_password, &hash),
        Err(_) => false,
    };

    if !is_valid {
        return (StatusCode::BAD_REQUEST, Json(serde_json::json!({"error": "Mot de passe actuel incorrect"}))).into_response();
    }

    if payload.new_password.trim().len() < 6 {
        return (StatusCode::BAD_REQUEST, Json(serde_json::json!({"error": "Le nouveau mot de passe doit comporter au moins 6 caractères"}))).into_response();
    }

    let new_hash = match hash_password(&payload.new_password) {
        Ok(h) => h,
        Err(e) => return (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": e}))).into_response(),
    };

    let update_res = conn.execute(
        "UPDATE admin_credentials SET password_hash = ?1, updated_at = CURRENT_TIMESTAMP WHERE id = 1",
        [&new_hash],
    );

    if let Err(e) = update_res {
        return (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": format!("Erreur de mise à jour : {}", e)}))).into_response();
    }

    info!("[Auth] Mot de passe administrateur modifié avec succès");
    Json(serde_json::json!({
        "status": "ok",
        "message": "Mot de passe modifié avec succès"
    })).into_response()
}

/// POST /api/auth/setup (Configuration initiale si jamais configuré)
pub async fn setup_handler(
    State(state): State<Arc<AppState>>,
    Json(payload): Json<SetupPayload>,
) -> Response {
    let conn = match state.db.lock() {
        Ok(c) => c,
        Err(_) => return (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": "Erreur DB"}))).into_response(),
    };

    let count: i64 = conn
        .query_row("SELECT COUNT(*) FROM admin_credentials WHERE id = 1", [], |r| r.get(0))
        .unwrap_or(0);

    if count > 0 {
        return (StatusCode::CONFLICT, Json(serde_json::json!({"error": "L'administrateur est déjà initialisé"}))).into_response();
    }

    if payload.password.trim().len() < 6 {
        return (StatusCode::BAD_REQUEST, Json(serde_json::json!({"error": "Le mot de passe doit comporter au moins 6 caractères"}))).into_response();
    }

    let new_hash = match hash_password(&payload.password) {
        Ok(h) => h,
        Err(e) => return (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": e}))).into_response(),
    };

    conn.execute(
        "INSERT INTO admin_credentials (id, password_hash) VALUES (1, ?1)",
        [&new_hash],
    ).ok();

    info!("[Auth] Initialisation initiale du mot de passe administrateur réussie");
    Json(serde_json::json!({
        "status": "ok",
        "message": "Mot de passe administrateur configuré avec succès"
    })).into_response()
}

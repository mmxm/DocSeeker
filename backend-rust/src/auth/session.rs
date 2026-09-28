use chrono::{Duration, Utc};
use rand::RngCore;
use rusqlite::{params, Connection, Result};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration as StdDuration, Instant};

use super::user_agent::ParsedUserAgent;

lazy_static::lazy_static! {
    static ref VALIDATED_SESSIONS_CACHE: Mutex<HashMap<String, Instant>> = Mutex::new(HashMap::new());
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct SessionInfo {
    pub id: String, // Identifiant public (hash SHA-256 tronqué pour masquer le cookie brut)
    pub created_at: String,
    pub last_seen: String,
    pub ip_address: Option<String>,
    pub os: String,
    pub browser: String,
    pub device_type: String,
    pub is_current: bool,
}

pub struct SessionManager;

impl SessionManager {
    /// Vérifie si le token a été validé récemment en mémoire (< 30 secondes).
    pub fn is_token_cached_valid(token: &str) -> bool {
        if let Ok(cache) = VALIDATED_SESSIONS_CACHE.lock() {
            if let Some(last_validated) = cache.get(token) {
                if last_validated.elapsed() < StdDuration::from_secs(30) {
                    return true;
                }
            }
        }
        false
    }

    /// Enregistre un token valide dans le cache mémoire.
    pub fn mark_token_valid(token: &str) {
        if let Ok(mut cache) = VALIDATED_SESSIONS_CACHE.lock() {
            cache.insert(token.to_string(), Instant::now());
        }
    }

    /// Invalide le cache mémoire pour un token spécifique ou pour toutes les sessions.
    pub fn invalidate_token_cache(token: Option<&str>) {
        if let Ok(mut cache) = VALIDATED_SESSIONS_CACHE.lock() {
            if let Some(t) = token {
                cache.remove(t);
            } else {
                cache.clear();
            }
        }
    }

    /// Génère un identifiant de session aléatoire de 256 bits (64 caractères hexadécimaux).
    pub fn generate_token() -> String {
        let mut bytes = [0u8; 32];
        rand::rngs::OsRng.fill_bytes(&mut bytes);
        hex::encode(bytes)
    }

    /// Calcule l'empreinte publique SHA-256 d'un token pour l'exposer sans divulguer le cookie brut.
    pub fn hash_token(token: &str) -> String {
        let mut hasher = Sha256::new();
        hasher.update(token.as_bytes());
        hex::encode(hasher.finalize())
    }

    /// Crée une nouvelle session persistante en base de données SQLite.
    pub fn create_session(
        conn: &Connection,
        duration_days: i64,
        user_agent: Option<&str>,
        ip_address: Option<&str>,
    ) -> Result<String> {
        let token = Self::generate_token();
        let expires_at = Utc::now() + Duration::days(duration_days);
        let expires_str = expires_at.to_rfc3339();

        conn.execute(
            "INSERT INTO sessions (id, expires_at, user_agent, ip_address) VALUES (?1, ?2, ?3, ?4)",
            params![token, expires_str, user_agent, ip_address],
        )?;

        Self::mark_token_valid(&token);
        Ok(token)
    }

    /// Valide une session existante et rafraîchit son horodatage `last_seen` (throttlé et non-fatal).
    pub fn validate_session(conn: &Connection, token: &str) -> Result<bool> {
        let now_str = Utc::now().to_rfc3339();

        let mut stmt = conn.prepare(
            "SELECT id FROM sessions WHERE id = ?1 AND expires_at > ?2",
        )?;

        let exists = stmt.query_row(params![token, now_str], |_| Ok(())).is_ok();
        if exists {
            // Mettre à jour last_seen de manière non-bloquante et throttlée (au max une fois toutes les 60s)
            // Ne doit JAMAIS invalider la session si SQLite est sous forte charge de lecture/écriture
            let _ = conn.execute(
                "UPDATE sessions SET last_seen = CURRENT_TIMESTAMP WHERE id = ?1 AND (last_seen IS NULL OR (strftime('%s', 'now') - strftime('%s', last_seen)) > 60)",
                params![token],
            );
            Ok(true)
        } else {
            Ok(false)
        }
    }

    /// Liste toutes les sessions actives (non expirées), triées par dernière activité.
    pub fn list_active_sessions(conn: &Connection, current_token: &str) -> Result<Vec<SessionInfo>> {
        let now_str = Utc::now().to_rfc3339();
        let mut stmt = conn.prepare(
            "SELECT id, created_at, last_seen, user_agent, ip_address 
             FROM sessions 
             WHERE expires_at > ?1 
             ORDER BY last_seen DESC",
        )?;

        let rows = stmt.query_map(params![now_str], |row| {
            let token: String = row.get(0)?;
            let created_at: String = row.get(1)?;
            let last_seen: String = row.get(2)?;
            let user_agent: Option<String> = row.get(3)?;
            let ip_address: Option<String> = row.get(4)?;
            Ok((token, created_at, last_seen, user_agent, ip_address))
        })?;

        let mut sessions = Vec::new();
        for item in rows {
            let (token, created_at, last_seen, user_agent, ip_address) = item?;
            let is_current = token == current_token;
            let ua_str = user_agent.as_deref().unwrap_or("");
            let parsed_ua = ParsedUserAgent::parse(ua_str);
            let public_id = Self::hash_token(&token);

            sessions.push(SessionInfo {
                id: public_id,
                created_at,
                last_seen,
                ip_address,
                os: parsed_ua.os,
                browser: parsed_ua.browser,
                device_type: parsed_ua.device_type,
                is_current,
            });
        }

        Ok(sessions)
    }

    /// Détruit immédiatement une session par son token brut (déconnexion réelle).
    pub fn revoke_session(conn: &Connection, token: &str) -> Result<()> {
        Self::invalidate_token_cache(Some(token));
        conn.execute("DELETE FROM sessions WHERE id = ?1", params![token])?;
        Ok(())
    }

    /// Révoque une session à partir de son hash public ou de son id brut.
    pub fn revoke_session_by_id_or_hash(conn: &Connection, target_id_or_hash: &str) -> Result<bool> {
        Self::invalidate_token_cache(None);
        // 1. Essai direct par token brut
        let affected = conn.execute("DELETE FROM sessions WHERE id = ?1", params![target_id_or_hash])?;
        if affected > 0 {
            return Ok(true);
        }

        // 2. Recherche par hash public
        let mut stmt = conn.prepare("SELECT id FROM sessions")?;
        let rows = stmt.query_map([], |row| row.get::<_, String>(0))?;
        for row in rows {
            let token = row?;
            if Self::hash_token(&token) == target_id_or_hash {
                conn.execute("DELETE FROM sessions WHERE id = ?1", params![token])?;
                return Ok(true);
            }
        }

        Ok(false)
    }

    /// Révoque toutes les sessions, avec option d'exclure la session courante.
    pub fn revoke_all_sessions(conn: &Connection, except_token: Option<&str>) -> Result<usize> {
        Self::invalidate_token_cache(None);
        if let Some(token) = except_token {
            let affected = conn.execute("DELETE FROM sessions WHERE id != ?1", params![token])?;
            Self::mark_token_valid(token);
            Ok(affected)
        } else {
            let affected = conn.execute("DELETE FROM sessions", [])?;
            Ok(affected)
        }
    }

    /// Supprime toutes les sessions expirées pour maintenir la table légère.
    pub fn purge_expired_sessions(conn: &Connection) -> Result<usize> {
        let now_str = Utc::now().to_rfc3339();
        conn.execute("DELETE FROM sessions WHERE expires_at <= ?1", params![now_str])
    }
}


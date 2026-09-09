use chrono::{Duration, Utc};
use rand::RngCore;
use rusqlite::{params, Connection, Result};

pub struct SessionManager;

impl SessionManager {
    /// Génère un identifiant de session aléatoire de 256 bits (64 caractères hexadécimaux).
    pub fn generate_token() -> String {
        let mut bytes = [0u8; 32];
        rand::rngs::OsRng.fill_bytes(&mut bytes);
        hex::encode(bytes)
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

        Ok(token)
    }

    /// Valide une session existante et rafraîchit son horodatage `last_seen`.
    pub fn validate_session(conn: &Connection, token: &str) -> Result<bool> {
        let now_str = Utc::now().to_rfc3339();

        let mut stmt = conn.prepare(
            "SELECT id, expires_at FROM sessions WHERE id = ?1 AND expires_at > ?2",
        )?;

        let mut rows = stmt.query(params![token, now_str])?;
        if rows.next()?.is_some() {
            // Mettre à jour last_seen
            conn.execute(
                "UPDATE sessions SET last_seen = CURRENT_TIMESTAMP WHERE id = ?1",
                params![token],
            )?;
            Ok(true)
        } else {
            Ok(false)
        }
    }

    /// Détruit immédiatement une session (déconnexion réelle).
    pub fn revoke_session(conn: &Connection, token: &str) -> Result<()> {
        conn.execute("DELETE FROM sessions WHERE id = ?1", params![token])?;
        Ok(())
    }

    /// Supprime toutes les sessions expirées pour maintenir la table légère.
    pub fn purge_expired_sessions(conn: &Connection) -> Result<usize> {
        let now_str = Utc::now().to_rfc3339();
        conn.execute("DELETE FROM sessions WHERE expires_at <= ?1", params![now_str])
    }
}

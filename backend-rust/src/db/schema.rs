// Re-export des schémas mutualisés depuis search_core (source unique de vérité)
pub use search_core::schema::{
    CREATE_ANNOTATIONS_TABLE, CREATE_DOCUMENTS_TABLE, CREATE_FOLDERS_TABLE, CREATE_FTS5_TABLE,
    CREATE_PAGES_TABLE,
};

pub const CREATE_AUTH_TABLES: &str = r#"

CREATE TABLE IF NOT EXISTS admin_credentials (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    password_hash TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    expires_at DATETIME NOT NULL,
    last_seen DATETIME DEFAULT CURRENT_TIMESTAMP,
    user_agent TEXT,
    ip_address TEXT
);
CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions(expires_at);
"#;

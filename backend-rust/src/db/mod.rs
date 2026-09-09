pub mod schema;
pub mod text_norm;

use std::path::Path;
use rusqlite::{Connection, Result};
use tracing::info;

pub fn open_connection(db_path: &Path) -> Result<Connection> {
    if let Some(parent) = db_path.parent() {
        std::fs::create_dir_all(parent).ok();
    }

    let conn = Connection::open(db_path)?;

    // Optimisations SQLite haute performance & zéro-copie
    let _: String = conn.query_row("PRAGMA foreign_keys = ON;", [], |r| r.get(0)).unwrap_or_default();
    let _: String = conn.query_row("PRAGMA journal_mode = WAL;", [], |r| r.get(0)).unwrap_or_default();
    let _: String = conn.query_row("PRAGMA synchronous = NORMAL;", [], |r| r.get(0)).unwrap_or_default();
    let _: i64 = conn.query_row("PRAGMA mmap_size = 268435456;", [], |r| r.get(0)).unwrap_or(0);
    let _: i64 = conn.query_row("PRAGMA temp_store = MEMORY;", [], |r| r.get(0)).unwrap_or(0);
    let _: i64 = conn.query_row("PRAGMA cache_size = -16000;", [], |r| r.get(0)).unwrap_or(0);

    Ok(conn)
}

pub fn init_db(db_path: &Path) -> Result<()> {
    let conn = open_connection(db_path)?;

    info!("Init table folders...");
    conn.execute_batch(schema::CREATE_FOLDERS_TABLE)?;
    info!("Init table documents...");
    conn.execute_batch(schema::CREATE_DOCUMENTS_TABLE)?;
    info!("Init table pages...");
    conn.execute_batch(schema::CREATE_PAGES_TABLE)?;
    info!("Init table pages_fts...");
    conn.execute_batch(schema::CREATE_FTS5_TABLE)?;
    info!("Init table annotations...");
    conn.execute_batch(schema::CREATE_ANNOTATIONS_TABLE)?;
    info!("Init table auth...");
    conn.execute_batch(schema::CREATE_AUTH_TABLES)?;

    // Migrations idempotentes si colonnes manquantes (rétrocompatibilité avec bases v1 existantes)
    info!("Verification des colonnes documents...");
    ensure_column(&conn, "documents", "file_hash", "TEXT")?;
    ensure_column(&conn, "documents", "folder_id", "INTEGER REFERENCES folders(id) ON DELETE SET NULL")?;
    ensure_column(&conn, "documents", "updated_at", "DATETIME")?;
    ensure_column(&conn, "documents", "status", "TEXT DEFAULT 'ready'")?;
    ensure_column(&conn, "documents", "error_message", "TEXT")?;

    info!("Base de données SQLite initialisée avec succès : {:?}", db_path);
    Ok(())
}

fn ensure_column(conn: &Connection, table: &str, column: &str, col_type: &str) -> Result<()> {
    let mut stmt = conn.prepare(&format!("PRAGMA table_info({})", table))?;
    let cols = stmt.query_map([], |row| row.get::<_, String>(1))?;
    let mut exists = false;
    for c in cols.flatten() {
        if c == column {
            exists = true;
            break;
        }
    }
    if !exists {
        conn.execute(&format!("ALTER TABLE {} ADD COLUMN {} {}", table, column, col_type), [])?;
    }
    Ok(())
}

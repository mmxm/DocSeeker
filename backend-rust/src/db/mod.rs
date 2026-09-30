pub mod schema;
pub mod text_norm;

use std::path::Path;
use rusqlite::{Connection, Result};
use tracing::info;

/// Type alias pour le pool de connexions SQLite r2d2
pub type DbPool = r2d2::Pool<r2d2_sqlite::SqliteConnectionManager>;

/// Initialisation des PRAGMAs de performance sur chaque connexion du pool
#[derive(Debug)]
struct SqlitePragmaCustomizer;

impl r2d2::CustomizeConnection<Connection, rusqlite::Error> for SqlitePragmaCustomizer {
    fn on_acquire(&self, conn: &mut Connection) -> std::result::Result<(), rusqlite::Error> {
        conn.execute_batch(
            "PRAGMA foreign_keys = ON;
             PRAGMA journal_mode = WAL;
             PRAGMA synchronous = NORMAL;
             PRAGMA busy_timeout = 60000;
             PRAGMA mmap_size = 268435456;
             PRAGMA temp_store = MEMORY;
             PRAGMA cache_size = -16000;"
        )?;
        Ok(())
    }
}

/// Crée un pool de connexions SQLite (max 16 connections concurrentes)
pub fn create_pool(db_path: &Path) -> std::result::Result<DbPool, Box<dyn std::error::Error>> {
    let manager = r2d2_sqlite::SqliteConnectionManager::file(db_path);
    let pool = r2d2::Pool::builder()
        .max_size(16)
        .min_idle(Some(4))
        .connection_timeout(std::time::Duration::from_secs(10))
        .connection_customizer(Box::new(SqlitePragmaCustomizer))
        .build(manager)?;
    Ok(pool)
}

pub fn open_connection(db_path: &Path) -> Result<Connection> {
    if let Some(parent) = db_path.parent() {
        std::fs::create_dir_all(parent).ok();
    }

    let conn = Connection::open(db_path)?;

    // Optimisations SQLite haute performance & zéro-copie
    conn.execute_batch(
        "PRAGMA foreign_keys = ON;
         PRAGMA journal_mode = WAL;
         PRAGMA synchronous = NORMAL;
         PRAGMA busy_timeout = 60000;
         PRAGMA mmap_size = 268435456;
         PRAGMA temp_store = MEMORY;
         PRAGMA cache_size = -16000;"
    )?;

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

    // Migration FTS5 idempotente : vérifie si pages_fts utilise déjà le mode external content
    let fts_sql: Option<String> = conn
        .query_row(
            "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'pages_fts'",
            [],
            |r| r.get(0),
        )
        .ok();

    let needs_fts_migration = match fts_sql {
        Some(sql) => !sql.contains("content='pages'") || !sql.contains("prefix='2 3 4'"),
        None => false,
    };

    if needs_fts_migration {
        info!("Migration de la table pages_fts vers FTS5 External Content & Préfixes 2,3,4...");
        let _ = conn.execute_batch("
            DROP TRIGGER IF EXISTS pages_ai;
            DROP TRIGGER IF EXISTS pages_ad;
            DROP TRIGGER IF EXISTS pages_au;
            DROP TABLE IF EXISTS pages_fts;
        ");
    }

    info!("Init table pages_fts & triggers...");
    conn.execute_batch(schema::CREATE_FTS5_TABLE)?;

    if needs_fts_migration {
        info!("Reconstruction de l'index inversé FTS5 depuis la table pages...");
        let count: i64 = conn.query_row("SELECT count(*) FROM pages", [], |r| r.get(0)).unwrap_or(0);
        if count > 0 {
            conn.execute_batch("INSERT INTO pages_fts(rowid, text_content) SELECT id, text_content FROM pages;")?;
            info!("Index FTS5 reconstruit avec succès pour {} pages.", count);
        }
    }
    let _ = conn.execute("DROP TABLE IF EXISTS document_annotations", []);

    // Migration idempotente : les notes Markdown ne doivent plus fournir de words_json
    // (coordonnées synthétiques). Leurs occurrences passent désormais par le chemin
    // "par lignes" qui produit des extraits texte enrichis rendus nativement en HTML
    // par le client (plus de crops image pour les MD).
    let cleared_md_words = conn
        .execute(
            "UPDATE pages SET words_json = '' WHERE words_json IS NOT NULL AND words_json != '' \n             AND doc_id IN (SELECT id FROM documents WHERE doc_type = 'markdown')",
            [],
        )
        .unwrap_or(0);
    if cleared_md_words > 0 {
        info!("[Migration] words_json vidé pour {} page(s) markdown (extraits texte natifs).", cleared_md_words);
    }

    info!("Init table auth...");
    conn.execute_batch(schema::CREATE_AUTH_TABLES)?;

    // Backfill idempotent de l'index documents_fts (recherche titres) : l'index
    // est « external content » sur documents, donc sauf reconstruction totale,
    // les lignes antérieures à sa création doivent être injectées une fois.
    let docs_fts_count: i64 = conn
        .query_row(
            "SELECT count(*) FROM documents_fts JOIN documents d ON d.id = documents_fts.rowid",
            [],
            |r| r.get(0),
        )
        .unwrap_or(0);
    let docs_count: i64 = conn.query_row("SELECT count(*) FROM documents", [], |r| r.get(0)).unwrap_or(0);
    if docs_count > 0 && docs_fts_count != docs_count {
        info!(
            "Reconstruction documents_fts : {} documents indexés / {} au total",
            docs_fts_count, docs_count
        );
        // 'rebuild' vide puis reconstruit l'index en rescannant la table de
        // contenu (documents) — pas besoin d'INSERT explicite (qui doublerait).
        conn.execute_batch("INSERT INTO documents_fts(documents_fts) VALUES('rebuild');")?;
    }

    // Migrations idempotentes si colonnes manquantes (rétrocompatibilité avec bases v1 existantes)
    info!("Verification des colonnes documents...");
    ensure_column(&conn, "documents", "file_hash", "TEXT")?;
    ensure_column(&conn, "documents", "folder_id", "INTEGER REFERENCES folders(id) ON DELETE SET NULL")?;
    ensure_column(&conn, "documents", "updated_at", "DATETIME")?;
    ensure_column(&conn, "documents", "status", "TEXT DEFAULT 'ready'")?;
    ensure_column(&conn, "documents", "error_message", "TEXT")?;
    ensure_column(&conn, "documents", "doc_type", "TEXT DEFAULT 'pdf'")?;
    ensure_column(&conn, "documents", "deleted_at", "DATETIME")?;

    // Création des index sur les colonnes migrées (après s'être assuré de leur existence)
    conn.execute_batch("
        CREATE INDEX IF NOT EXISTS idx_documents_doc_type ON documents(doc_type);
        CREATE INDEX IF NOT EXISTS idx_documents_deleted_at ON documents(deleted_at);
    ")?;

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

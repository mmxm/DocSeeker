/// Schéma SQL unifié de la base DocSeeker (exécuté sur SQLite distant et SQLite-Wasm local)

pub const CREATE_FOLDERS_TABLE: &str = r#"
CREATE TABLE IF NOT EXISTS folders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    parent_id INTEGER,
    color TEXT DEFAULT '#3b82f6',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(parent_id) REFERENCES folders(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_folders_parent_id ON folders(parent_id);
"#;

pub const CREATE_DOCUMENTS_TABLE: &str = r#"
CREATE TABLE IF NOT EXISTS documents (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    filename TEXT NOT NULL UNIQUE,
    title TEXT,
    file_hash TEXT,
    folder_id INTEGER,
    status TEXT DEFAULT 'ready',
    error_message TEXT,
    total_pages INTEGER DEFAULT 0,
    file_size INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(folder_id) REFERENCES folders(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_documents_file_hash ON documents(file_hash);
CREATE INDEX IF NOT EXISTS idx_documents_folder_id ON documents(folder_id);
CREATE INDEX IF NOT EXISTS idx_documents_status ON documents(status);
"#;

pub const CREATE_PAGES_TABLE: &str = r#"
CREATE TABLE IF NOT EXISTS pages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    doc_id INTEGER NOT NULL,
    page_number INTEGER NOT NULL,
    text_content TEXT,
    words_json TEXT,
    FOREIGN KEY(doc_id) REFERENCES documents(id) ON DELETE CASCADE,
    UNIQUE(doc_id, page_number)
);
"#;

pub const CREATE_FTS5_TABLE: &str = r#"
CREATE VIRTUAL TABLE IF NOT EXISTS pages_fts USING fts5(
    text_content,
    content='pages',
    content_rowid='id',
    tokenize='unicode61 remove_diacritics 2',
    prefix='2 3 4'
);

CREATE TRIGGER IF NOT EXISTS pages_ai AFTER INSERT ON pages BEGIN
    INSERT INTO pages_fts(rowid, text_content) VALUES (new.id, new.text_content);
END;

CREATE TRIGGER IF NOT EXISTS pages_ad AFTER DELETE ON pages BEGIN
    INSERT INTO pages_fts(pages_fts, rowid, text_content) VALUES('delete', old.id, old.text_content);
END;

CREATE TRIGGER IF NOT EXISTS pages_au AFTER UPDATE ON pages BEGIN
    INSERT INTO pages_fts(pages_fts, rowid, text_content) VALUES('delete', old.id, old.text_content);
    INSERT INTO pages_fts(rowid, text_content) VALUES (new.id, new.text_content);
END;
"#;

pub const CREATE_ANNOTATIONS_TABLE: &str = r#"
CREATE TABLE IF NOT EXISTS document_annotations (
    doc_id INTEGER PRIMARY KEY,
    annotations_json TEXT NOT NULL,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(doc_id) REFERENCES documents(id) ON DELETE CASCADE
);
"#;

pub fn get_full_schema_sql() -> String {
    format!(
        "{}\n{}\n{}\n{}\n{}",
        CREATE_FOLDERS_TABLE,
        CREATE_DOCUMENTS_TABLE,
        CREATE_PAGES_TABLE,
        CREATE_FTS5_TABLE,
        CREATE_ANNOTATIONS_TABLE
    )
}


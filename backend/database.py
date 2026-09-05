import sqlite3
import os
import unicodedata
from typing import List, Dict, Any, Optional

DB_PATH = os.path.join(os.path.dirname(os.path.dirname(__file__)), "data", "db.sqlite")

def normalize_text(text: str) -> str:
    """Supprime les accents et convertit en minuscules pour comparaison uniforme."""
    if not text:
        return ""
    nfkd = unicodedata.normalize("NFD", text)
    return "".join(c for c in nfkd if unicodedata.category(c) != "Mn").lower()

def get_db_connection() -> sqlite3.Connection:
    os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON;")
    return conn

def init_db():
    conn = get_db_connection()
    cursor = conn.cursor()

    # Table des documents
    cursor.execute("""
    CREATE TABLE IF NOT EXISTS documents (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        filename TEXT NOT NULL UNIQUE,
        title TEXT,
        total_pages INTEGER DEFAULT 0,
        file_size INTEGER DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    """)

    # Table des pages
    cursor.execute("""
    CREATE TABLE IF NOT EXISTS pages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        doc_id INTEGER NOT NULL,
        page_number INTEGER NOT NULL,
        text_content TEXT,
        words_json TEXT,
        FOREIGN KEY(doc_id) REFERENCES documents(id) ON DELETE CASCADE,
        UNIQUE(doc_id, page_number)
    );
    """)

    # Table FTS5 pour la recherche plein texte rapide & insensible aux accents
    cursor.execute("""
    CREATE VIRTUAL TABLE IF NOT EXISTS pages_fts USING fts5(
        doc_id UNINDEXED,
        page_number UNINDEXED,
        text_content,
        tokenize='unicode61 remove_diacritics 2'
    );
    """)

    conn.commit()
    conn.close()

if __name__ == "__main__":
    init_db()
    print("Database initialized successfully at", DB_PATH)

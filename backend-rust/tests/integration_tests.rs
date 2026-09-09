use rusqlite::Connection;

#[test]
fn test_session_lifecycle() {
    let conn = Connection::open_in_memory().unwrap();
    conn.execute_batch(r#"
        CREATE TABLE sessions (
            id TEXT PRIMARY KEY,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            expires_at DATETIME NOT NULL,
            last_seen DATETIME DEFAULT CURRENT_TIMESTAMP,
            user_agent TEXT,
            ip_address TEXT
        );
    "#).unwrap();

    // Création session valide 30 jours
    let token = "test_token_1234567890abcdef";
    let expires = (chrono::Utc::now() + chrono::Duration::days(30)).to_rfc3339();
    conn.execute(
        "INSERT INTO sessions (id, expires_at) VALUES (?1, ?2)",
        rusqlite::params![token, expires],
    ).unwrap();

    let count: i64 = conn.query_row(
        "SELECT COUNT(*) FROM sessions WHERE id = ?1 AND expires_at > ?2",
        rusqlite::params![token, chrono::Utc::now().to_rfc3339()],
        |r| r.get(0),
    ).unwrap();
    assert_eq!(count, 1);

    // Révocation
    conn.execute("DELETE FROM sessions WHERE id = ?1", rusqlite::params![token]).unwrap();
    let count_after: i64 = conn.query_row(
        "SELECT COUNT(*) FROM sessions WHERE id = ?1",
        rusqlite::params![token],
        |r| r.get(0),
    ).unwrap();
    assert_eq!(count_after, 0);
}

#[test]
fn test_fts5_bm25_search() {
    let conn = Connection::open_in_memory().unwrap();
    conn.execute_batch(r#"
        CREATE TABLE documents (
            id INTEGER PRIMARY KEY,
            title TEXT,
            filename TEXT
        );
        CREATE VIRTUAL TABLE pages_fts USING fts5(
            doc_id UNINDEXED,
            page_number UNINDEXED,
            text_content,
            tokenize='unicode61 remove_diacritics 2'
        );
    "#).unwrap();

    conn.execute(
        "INSERT INTO pages_fts (doc_id, page_number, text_content) VALUES (1, 1, 'Hémorragie de la délivrance et complications obstétricales')",
        [],
    ).unwrap();
    conn.execute(
        "INSERT INTO pages_fts (doc_id, page_number, text_content) VALUES (2, 1, 'Examen pédiatrique standard du nourrisson')",
        [],
    ).unwrap();

    // Recherche insensible aux accents
    let mut stmt = conn.prepare(
        "SELECT doc_id, bm25(pages_fts) as score FROM pages_fts WHERE pages_fts MATCH ?1 ORDER BY score ASC",
    ).unwrap();

    let results: Vec<i64> = stmt
        .query_map(["hemorragie*"], |r| r.get(0))
        .unwrap()
        .flatten()
        .collect();

    assert_eq!(results, vec![1]);
}

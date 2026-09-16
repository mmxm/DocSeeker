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

#[test]
fn test_offline_bundle_extraction() {
    let conn = Connection::open_in_memory().unwrap();
    conn.execute_batch(r#"
        CREATE TABLE documents (
            id INTEGER PRIMARY KEY,
            filename TEXT NOT NULL,
            title TEXT,
            file_hash TEXT,
            folder_id INTEGER,
            status TEXT DEFAULT 'ready',
            total_pages INTEGER DEFAULT 0,
            file_size INTEGER DEFAULT 0,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE pages (
            id INTEGER PRIMARY KEY,
            doc_id INTEGER NOT NULL,
            page_number INTEGER NOT NULL,
            text_content TEXT,
            words_json TEXT
        );
    "#).unwrap();

    let words_json = r#"[[10.0, 20.0, 50.0, 35.0, "Cardiologie", 0, 0], [55.0, 20.0, 80.0, 35.0, "clinique", 0, 0]]"#;
    conn.execute(
        "INSERT INTO documents (id, filename, title, file_hash, total_pages, file_size) VALUES (42, 'cardio.pdf', 'Cardiologie', 'hash123', 1, 1024)",
        [],
    ).unwrap();
    conn.execute(
        "INSERT INTO pages (doc_id, page_number, text_content, words_json) VALUES (42, 1, 'Cardiologie clinique', ?1)",
        rusqlite::params![words_json],
    ).unwrap();

    // Vérification de la lecture et désérialisation
    let mut stmt = conn.prepare("SELECT page_number, text_content, words_json FROM pages WHERE doc_id = 42").unwrap();
    let row = stmt.query_row([], |r| {
        let pnum: i64 = r.get(0)?;
        let text: String = r.get(1)?;
        let raw_words: String = r.get(2)?;
        Ok((pnum, text, raw_words))
    }).unwrap();

    assert_eq!(row.0, 1);
    assert_eq!(row.1, "Cardiologie clinique");
    let parsed: Vec<serde_json::Value> = serde_json::from_str(&row.2).unwrap();
    assert_eq!(parsed.len(), 2);
    assert_eq!(parsed[0][4], "Cardiologie");
}

#[test]
fn test_sync_check_logic() {
    let conn = Connection::open_in_memory().unwrap();
    conn.execute_batch(r#"
        CREATE TABLE documents (
            id INTEGER PRIMARY KEY,
            file_hash TEXT,
            status TEXT DEFAULT 'ready',
            created_at DATETIME DEFAULT '2026-09-10T12:00:00Z',
            updated_at DATETIME DEFAULT '2026-09-12T14:30:00Z'
        );
    "#).unwrap();

    // Doc 1 : identique
    conn.execute("INSERT INTO documents (id, file_hash, updated_at) VALUES (1, 'hash_ok', '2026-09-12T14:30:00Z')", []).unwrap();
    // Doc 2 : modifié (nouveau hash)
    conn.execute("INSERT INTO documents (id, file_hash, updated_at) VALUES (2, 'hash_new', '2026-09-15T10:00:00Z')", []).unwrap();
    // Doc 3 : marqué deleted / error
    conn.execute("INSERT INTO documents (id, file_hash, status) VALUES (3, 'hash3', 'error')", []).unwrap();
    // Doc 4 : supprimé de la base

    let client_cached = vec![
        (1, "hash_ok", "2026-09-12T14:30:00Z"),
        (2, "hash_old", "2026-09-10T08:00:00Z"),
        (3, "hash3", "2026-09-10T08:00:00Z"),
        (4, "hash4", "2026-09-10T08:00:00Z"),
    ];

    let mut outdated_ids = Vec::new();
    let mut deleted_ids = Vec::new();

    let mut stmt = conn.prepare("SELECT file_hash, COALESCE(updated_at, created_at), COALESCE(status, 'ready') FROM documents WHERE id = ?1").unwrap();

    for (id, cached_hash, cached_time) in client_cached {
        let row_res = stmt.query_row(rusqlite::params![id], |r| {
            Ok((r.get::<_, Option<String>>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?))
        });

        match row_res {
            Ok((server_hash, server_updated_at, status)) => {
                if status != "ready" {
                    deleted_ids.push(id);
                } else if server_hash.as_deref() != Some(cached_hash) || server_updated_at.as_str() > cached_time {
                    outdated_ids.push(id);
                }
            }
            Err(rusqlite::Error::QueryReturnedNoRows) => {
                deleted_ids.push(id);
            }
            Err(_) => {}
        }
    }

    assert_eq!(outdated_ids, vec![2]);
    assert_eq!(deleted_ids, vec![3, 4]);
}


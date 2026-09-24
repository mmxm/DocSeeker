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

#[test]
fn test_session_management_and_revocation() {
    use docseeker_backend::auth::session::SessionManager;

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

    // 1. Créer 3 sessions (Mac, iPhone, Windows)
    let ua_mac = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15";
    let ua_iphone = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";
    let ua_win = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

    let token_mac = SessionManager::create_session(&conn, 30, Some(ua_mac), Some("192.168.1.10")).unwrap();
    let token_iphone = SessionManager::create_session(&conn, 30, Some(ua_iphone), Some("192.168.1.11")).unwrap();
    let _token_win = SessionManager::create_session(&conn, 30, Some(ua_win), Some("192.168.1.12")).unwrap();

    // 2. Lister les sessions avec token_mac comme session courante
    let sessions = SessionManager::list_active_sessions(&conn, &token_mac).unwrap();
    assert_eq!(sessions.len(), 3);

    // Vérifier les détails de la session Mac courante
    let mac_info = sessions.iter().find(|s| s.os == "macOS").unwrap();
    assert!(mac_info.is_current);
    assert_eq!(mac_info.browser, "Safari");
    assert_eq!(mac_info.device_type, "desktop");
    assert_eq!(mac_info.ip_address.as_deref(), Some("192.168.1.10"));
    assert_eq!(mac_info.id, SessionManager::hash_token(&token_mac));

    // Vérifier la session iPhone (non courante)
    let iphone_info = sessions.iter().find(|s| s.os == "iOS").unwrap();
    assert!(!iphone_info.is_current);
    assert_eq!(iphone_info.device_type, "mobile");
    assert_eq!(iphone_info.id, SessionManager::hash_token(&token_iphone));

    // 3. Révocation individuelle de la session Windows par son hash public
    let win_info = sessions.iter().find(|s| s.os == "Windows").unwrap();
    let revoked = SessionManager::revoke_session_by_id_or_hash(&conn, &win_info.id).unwrap();
    assert!(revoked);

    let sessions_after_single = SessionManager::list_active_sessions(&conn, &token_mac).unwrap();
    assert_eq!(sessions_after_single.len(), 2);
    assert!(!sessions_after_single.iter().any(|s| s.os == "Windows"));

    // 4. Révocation de toutes les autres sessions (sauf token_mac)
    let count_revoked = SessionManager::revoke_all_sessions(&conn, Some(&token_mac)).unwrap();
    assert_eq!(count_revoked, 1); // Seul l'iPhone restait à révoquer

    let sessions_after_others = SessionManager::list_active_sessions(&conn, &token_mac).unwrap();
    assert_eq!(sessions_after_others.len(), 1);
    assert_eq!(sessions_after_others[0].os, "macOS");
    assert!(sessions_after_others[0].is_current);

    // 5. Révocation absolue de toutes les sessions
    let count_all = SessionManager::revoke_all_sessions(&conn, None).unwrap();
    assert_eq!(count_all, 1);

    let sessions_empty = SessionManager::list_active_sessions(&conn, &token_mac).unwrap();
    assert_eq!(sessions_empty.len(), 0);
}



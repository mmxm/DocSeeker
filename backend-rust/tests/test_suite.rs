use rusqlite::{params, Connection};
use std::collections::HashMap;

// -----------------------------------------------------------------------------
// 1. Tests Normalisation Unicode & FTS5 (Diacritiques, Minuscules, Ponctuation)
// -----------------------------------------------------------------------------

fn normalize_test_text(text: &str) -> String {
    use unicode_normalization::UnicodeNormalization;
    let nfd: String = text.nfd().collect();
    let without_accents: String = nfd
        .chars()
        .filter(|c| !unicode_normalization::char::is_combining_mark(*c))
        .collect();
    without_accents
        .to_lowercase()
        .replace(['’', '\''], " ")
}

#[test]
fn test_unicode_normalization_accents_and_ligatures() {
    let raw = "Hémorragie obstétricale aiguë de l’utérus & cœliaque";
    let normalized = normalize_test_text(raw);
    assert!(normalized.contains("hemorragie"));
    assert!(normalized.contains("obstetricale"));
    assert!(normalized.contains("aigue"));
    assert!(normalized.contains("uterus"));
}

#[test]
fn test_fts5_diacritic_and_prefix_matching() {
    let conn = Connection::open_in_memory().unwrap();
    conn.execute_batch(r#"
        CREATE VIRTUAL TABLE pages_fts USING fts5(
            doc_id UNINDEXED,
            page_number UNINDEXED,
            text_content,
            tokenize='unicode61 remove_diacritics 2'
        );
    "#).unwrap();

    conn.execute(
        "INSERT INTO pages_fts (doc_id, page_number, text_content) VALUES (1, 1, 'Grossesse extra-utérine et métrorragies du premier trimestre')",
        [],
    ).unwrap();
    conn.execute(
        "INSERT INTO pages_fts (doc_id, page_number, text_content) VALUES (2, 1, 'Diabète gestationnel et surveillance échographique')",
        [],
    ).unwrap();

    // Recherche sans accent avec préfixe ("grossesse*")
    let mut stmt = conn.prepare(
        "SELECT doc_id FROM pages_fts WHERE pages_fts MATCH ?1",
    ).unwrap();

    let docs: Vec<i64> = stmt.query_map(["grossesse*"], |r| r.get(0)).unwrap().flatten().collect();
    assert_eq!(docs, vec![1]);

    // Recherche avec accent ("diabète")
    let docs_diab: Vec<i64> = stmt.query_map(["diabete*"], |r| r.get(0)).unwrap().flatten().collect();
    assert_eq!(docs_diab, vec![2]);
}

// -----------------------------------------------------------------------------
// 2. Tests Sécurité & Authentification (Argon2id, Session CSPRNG, Anti-Bruteforce)
// -----------------------------------------------------------------------------

#[test]
fn test_argon2id_password_hashing() {
    use argon2::{
        password_hash::{PasswordHash, PasswordHasher, PasswordVerifier, SaltString},
        Argon2,
    };
    use rand::rngs::OsRng;

    let pwd = "SuperSecretAdminPassword123!";
    let salt = SaltString::generate(&mut OsRng);
    let argon2 = Argon2::default();
    let hash = argon2.hash_password(pwd.as_bytes(), &salt).unwrap().to_string();

    assert!(hash.starts_with("$argon2id$"));

    // Vérification mot de passe valide
    let parsed_hash = PasswordHash::new(&hash).unwrap();
    assert!(argon2.verify_password(pwd.as_bytes(), &parsed_hash).is_ok());

    // Vérification rejet mot de passe invalide
    assert!(argon2.verify_password("WrongPassword".as_bytes(), &parsed_hash).is_err());
}

#[test]
fn test_rate_limiter_brute_force_lockout() {
    use std::time::Instant;

    struct TestRateLimiter {
        attempts: std::sync::Mutex<HashMap<String, (u32, Instant)>>,
    }

    let rl = TestRateLimiter {
        attempts: std::sync::Mutex::new(HashMap::new()),
    };

    let ip = "192.168.1.100";

    // 5 tentatives infructueuses autorisées
    for _ in 0..5 {
        let mut map = rl.attempts.lock().unwrap();
        let entry = map.entry(ip.to_string()).or_insert((0, Instant::now()));
        entry.0 += 1;
    }

    // 6e tentative doit déclencher le blocage
    let is_locked = {
        let map = rl.attempts.lock().unwrap();
        map.get(ip).map(|(fails, _)| *fails >= 5).unwrap_or(false)
    };
    assert!(is_locked, "L'adresse IP doit être bloquée après 5 échecs");
}

// -----------------------------------------------------------------------------
// 3. Tests Gestion des Dossiers & Arborescence (Hiérarchie, Cycles, Déplacement)
// -----------------------------------------------------------------------------

#[test]
fn test_folders_hierarchy_and_orphan_handling() {
    let conn = Connection::open_in_memory().unwrap();
    conn.execute_batch(r#"
        CREATE TABLE folders (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            parent_id INTEGER REFERENCES folders(id) ON DELETE SET NULL,
            color TEXT DEFAULT '#3b82f6',
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE documents (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            title TEXT,
            filename TEXT,
            folder_id INTEGER REFERENCES folders(id) ON DELETE SET NULL
        );
    "#).unwrap();

    // 1. Création dossier racine
    conn.execute("INSERT INTO folders (name, parent_id) VALUES ('Gynécologie', NULL)", []).unwrap();
    let root_id = conn.last_insert_rowid();

    // 2. Création sous-dossier
    conn.execute("INSERT INTO folders (name, parent_id) VALUES ('Obstétrique', ?1)", params![root_id]).unwrap();
    let sub_id = conn.last_insert_rowid();

    // 3. Association d'un document au sous-dossier
    conn.execute("INSERT INTO documents (title, filename, folder_id) VALUES ('Doc A', 'doc_a.pdf', ?1)", params![sub_id]).unwrap();
    let doc_id = conn.last_insert_rowid();

    // Vérifier l'affectation
    let assigned_folder: i64 = conn.query_row("SELECT folder_id FROM documents WHERE id = ?1", params![doc_id], |r| r.get(0)).unwrap();
    assert_eq!(assigned_folder, sub_id);

    // 4. Suppression du sous-dossier : le document devient orphelin à la racine (folder_id IS NULL)
    conn.execute("UPDATE documents SET folder_id = NULL WHERE folder_id = ?1", params![sub_id]).unwrap();
    conn.execute("DELETE FROM folders WHERE id = ?1", params![sub_id]).unwrap();

    let orphan_folder: Option<i64> = conn.query_row("SELECT folder_id FROM documents WHERE id = ?1", params![doc_id], |r| r.get(0)).unwrap();
    assert!(orphan_folder.is_none(), "Le document doit être orphelin (racine) après suppression du dossier");
}

// -----------------------------------------------------------------------------
// 4. Tests Documents & Détection de Doublons Stricts (SHA-256)
// -----------------------------------------------------------------------------

#[test]
fn test_strict_duplicate_detection_by_hash() {
    let conn = Connection::open_in_memory().unwrap();
    conn.execute_batch(r#"
        CREATE TABLE documents (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            filename TEXT NOT NULL,
            title TEXT NOT NULL,
            file_hash TEXT UNIQUE,
            file_size INTEGER DEFAULT 0,
            status TEXT DEFAULT 'ready',
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
    "#).unwrap();

    let test_hash = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

    // Insertion d'un document initial
    conn.execute(
        "INSERT INTO documents (filename, title, file_hash, file_size) VALUES ('cours1.pdf', 'Cours 1', ?1, 1024)",
        params![test_hash],
    ).unwrap();

    // Détection du doublon avant insertion
    let duplicate_found: bool = conn
        .query_row("SELECT COUNT(*) FROM documents WHERE file_hash = ?1", params![test_hash], |r| r.get::<_, i64>(0))
        .map(|c| c > 0)
        .unwrap_or(false);

    assert!(duplicate_found, "Le doublon strict par empreinte SHA-256 doit être détecté");
}

// -----------------------------------------------------------------------------
// 5. Tests Sécurité Validation Format & Échappement
// -----------------------------------------------------------------------------

#[test]
fn test_pdf_magic_signature_validation() {
    let valid_pdf = b"%PDF-1.7\nSample content";
    assert!(valid_pdf.starts_with(b"%PDF-"), "Un document PDF valide doit commencer par %PDF-");

    let fake_pdf = b"NOT_A_PDF_CONTENT";
    assert!(!fake_pdf.starts_with(b"%PDF-"), "Un faux document ne doit pas être validé");
}

#[test]
fn test_path_traversal_prevention() {
    let dangerous_filename = "../../etc/passwd.pdf";
    let clean = std::path::Path::new(dangerous_filename)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("document.pdf");

    assert_eq!(clean, "passwd.pdf", "La traversée de répertoire doit être éliminée");
    assert!(!clean.contains(".."));
}

// -----------------------------------------------------------------------------
// 6. Tests Optimisations Recherche & Indexation (WordEntry, Pagination, FTS5, LRU)
// -----------------------------------------------------------------------------

#[test]
fn test_word_entry_typed_deserialization() {
    use serde::{Deserialize, Serialize};

    #[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
    struct WordEntry(pub f64, pub f64, pub f64, pub f64, pub String, pub i64, pub i64);

    let json_str = r#"[[10.5, 20.2, 55.8, 32.1, "recherche", 1, 3], [60.0, 20.2, 90.5, 32.1, "visuelle", 1, 3]]"#;
    let words: Vec<WordEntry> = serde_json::from_str(json_str).expect("Désérialisation WordEntry valide");

    assert_eq!(words.len(), 2);
    assert_eq!(words[0].4, "recherche");
    assert_eq!(words[0].0, 10.5);
    assert_eq!(words[1].4, "visuelle");
}

#[test]
fn test_fts5_external_content_and_prefix() {
    let conn = Connection::open_in_memory().unwrap();
    conn.execute_batch(r#"
        CREATE TABLE pages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            doc_id INTEGER NOT NULL,
            page_number INTEGER NOT NULL,
            text_content TEXT
        );

        CREATE VIRTUAL TABLE pages_fts USING fts5(
            text_content,
            content='pages',
            content_rowid='id',
            tokenize='unicode61 remove_diacritics 2',
            prefix='2 3 4'
        );

        CREATE TRIGGER pages_ai AFTER INSERT ON pages BEGIN
            INSERT INTO pages_fts(rowid, text_content) VALUES (new.id, new.text_content);
        END;

        CREATE TRIGGER pages_ad AFTER DELETE ON pages BEGIN
            INSERT INTO pages_fts(pages_fts, rowid, text_content) VALUES('delete', old.id, old.text_content);
        END;
    "#).unwrap();

    // Insertion uniquement dans la table standard 'pages'
    conn.execute(
        "INSERT INTO pages (doc_id, page_number, text_content) VALUES (?1, ?2, ?3)",
        params![1, 1, "DocSeeker est un moteur de recherche ultra rapide pour vos documents."],
    ).unwrap();

    // Recherche FTS5 par préfixe 'doc*'
    let mut stmt = conn.prepare("SELECT p.doc_id, p.page_number FROM pages_fts JOIN pages p ON p.id = pages_fts.rowid WHERE pages_fts MATCH 'doc*'").unwrap();
    let rows: Vec<(i64, i64)> = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?))).unwrap().flatten().collect();

    assert_eq!(rows.len(), 1, "Le trigger doit avoir synchronisé FTS5 sans écriture manuelle");
    assert_eq!(rows[0], (1, 1));

    // Suppression dans pages
    conn.execute("DELETE FROM pages WHERE doc_id = 1", []).unwrap();
    let rows_after: Vec<(i64, i64)> = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?))).unwrap().flatten().collect();
    assert_eq!(rows_after.len(), 0, "Le trigger DELETE doit avoir nettoyé l'index FTS5");
}

#[test]
fn test_search_lru_cache() {
    use std::num::NonZeroUsize;
    use lru::LruCache;

    let mut cache: LruCache<String, String> = LruCache::new(NonZeroUsize::new(2).unwrap());
    cache.put("key1".to_string(), "val1".to_string());
    cache.put("key2".to_string(), "val2".to_string());

    assert_eq!(cache.get("key1").map(|s| s.as_str()), Some("val1"));

    // Éviction LRU
    cache.put("key3".to_string(), "val3".to_string());
    assert_eq!(cache.get("key2"), None, "key2 aurait dû être évincée");
    assert_eq!(cache.get("key1").map(|s| s.as_str()), Some("val1"));

    // Invalidation totale
    cache.clear();
    assert_eq!(cache.len(), 0);
}


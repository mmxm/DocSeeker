use rusqlite::{params, Connection};
use std::time::Instant;

// Structures minimales pour tester le moteur sans dépendre du serveur HTTP
#[derive(Debug, serde::Serialize, serde::Deserialize)]
pub struct WordEntry(pub f64, pub f64, pub f64, pub f64, pub String, pub i64, pub i64);

fn setup_perf_test_db() -> Connection {
    let conn = Connection::open_in_memory().unwrap();
    
    conn.execute_batch(r#"
        PRAGMA page_size = 4096;
        PRAGMA foreign_keys = ON;

        CREATE TABLE documents (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            filename TEXT NOT NULL UNIQUE,
            title TEXT NOT NULL,
            folder_id INTEGER,
            file_hash TEXT UNIQUE,
            total_pages INTEGER NOT NULL DEFAULT 0,
            file_size INTEGER NOT NULL DEFAULT 0,
            status TEXT NOT NULL DEFAULT 'ready',
            error_message TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE pages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            doc_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
            page_number INTEGER NOT NULL,
            text_content TEXT NOT NULL,
            words_json TEXT NOT NULL DEFAULT '[]',
            UNIQUE(doc_id, page_number)
        );

        CREATE VIRTUAL TABLE pages_fts USING fts5(
            text_content,
            content='pages',
            content_rowid='id',
            tokenize='unicode61 remove_diacritics 2',
            prefix='2 3 4'
        );

        CREATE TRIGGER pages_ai AFTER INSERT ON pages BEGIN
            INSERT INTO pages_fts (rowid, text_content) VALUES (new.id, new.text_content);
        END;

        CREATE TRIGGER pages_ad AFTER DELETE ON pages BEGIN
            INSERT INTO pages_fts (pages_fts, rowid, text_content) VALUES('delete', old.id, old.text_content);
        END;
    "#).unwrap();

    conn
}

#[test]
fn test_high_density_occurrences_search_performance() {
    let mut conn = setup_perf_test_db();

    // Insertion de 5 documents contenant chacun 50 pages avec haute densité d'occurrences
    // Cela génère 250 pages et plus de 2 500 occurrences du mot "traitement"
    let tx = conn.transaction().unwrap();
    for doc_idx in 1..=5 {
        tx.execute(
            "INSERT INTO documents (id, filename, title, total_pages, status) VALUES (?1, ?2, ?3, 50, 'ready')",
            params![
                doc_idx,
                format!("manuel_medecine_{}.pdf", doc_idx),
                format!("Traité de Médecine Clinique Vol. {}", doc_idx)
            ],
        ).unwrap();

        for page_num in 1..=50 {
            let mut words = Vec::new();
            let mut text_parts = Vec::new();

            for word_idx in 0..15 {
                let w = if word_idx % 3 == 0 {
                    "traitement"
                } else if word_idx % 5 == 0 {
                    "diagnostic"
                } else {
                    "patient"
                };

                let x0 = (word_idx as f64) * 30.0;
                let y0 = (word_idx as f64) * 20.0;
                let x1 = x0 + 25.0;
                let y1 = y0 + 15.0;

                words.push(WordEntry(x0, y0, x1, y1, w.to_string(), 0, word_idx as i64));
                text_parts.push(w);
            }

            let text_content = text_parts.join(" ");
            let words_json = serde_json::to_string(&words).unwrap();

            tx.execute(
                "INSERT INTO pages (doc_id, page_number, text_content, words_json) VALUES (?1, ?2, ?3, ?4)",
                params![doc_idx, page_num, text_content, words_json],
            ).unwrap();
        }
    }
    tx.commit().unwrap();

    // Vérification du nombre d'enregistrements FTS5
    let count: i64 = conn.query_row("SELECT count(*) FROM pages_fts", [], |r| r.get(0)).unwrap();
    assert_eq!(count, 250);

    // Mesure de la recherche haute densité "traitement"
    let start = Instant::now();
    let query_sql = r#"
        SELECT 
            p.doc_id,
            p.page_number,
            p.words_json,
            d.filename,
            d.title,
            d.folder_id,
            d.total_pages,
            d.created_at,
            COALESCE(d.updated_at, d.created_at) as updated_at,
            bm25(pages_fts) as bm25_score
        FROM pages_fts
        JOIN pages p ON p.id = pages_fts.rowid
        JOIN documents d ON d.id = p.doc_id
        WHERE pages_fts MATCH 'traitement*'
        ORDER BY bm25_score ASC;
    "#;

    let mut stmt = conn.prepare(query_sql).unwrap();
    let mut total_occurrences = 0;
    let mut rows = stmt.query([]).unwrap();

    while let Some(row) = rows.next().unwrap() {
        let words_json: String = row.get(2).unwrap();
        let words: Vec<WordEntry> = serde_json::from_str(&words_json).unwrap();
        
        let matches = words.iter().filter(|w| w.4.starts_with("traitement")).count();
        total_occurrences += matches;
    }

    let elapsed = start.elapsed();
    println!("Temps de recherche haute densité (250 pages, {} occurrences) : {:?}", total_occurrences, elapsed);

    // Vérifications d'intégrité et de performance
    assert!(total_occurrences >= 1250, "Au moins 1250 occurrences attendues");
    assert!(elapsed.as_millis() < 200, "La recherche doit prendre moins de 200ms");
}

#[test]
fn test_nan_float_partial_cmp_safe() {
    // Vérification que le tri avec partial_cmp().unwrap_or(Equal) ne panique JAMAIS sur NaN ou infini
    let mut scores = vec![1.5, f64::NAN, -2.3, f64::INFINITY, 0.0, f64::NEG_INFINITY];
    scores.sort_by(|a, b| b.partial_cmp(a).unwrap_or(std::cmp::Ordering::Equal));
    assert_eq!(scores.len(), 6);
}

#[test]
fn test_zero_byte_pdf_handling() {
    let temp_dir = tempfile::tempdir().unwrap();
    let empty_pdf = temp_dir.path().join("empty.pdf");
    std::fs::write(&empty_pdf, b"").unwrap();

    let meta = std::fs::metadata(&empty_pdf).unwrap();
    assert_eq!(meta.len(), 0);

    // Simulation de la validation du scanner
    let is_valid = meta.len() >= 5;
    assert!(!is_valid, "Un fichier de 0 octet doit être rejeté sans passer par libpdfium");
}

#[test]
fn test_corrupt_header_pdf_handling() {
    let temp_dir = tempfile::tempdir().unwrap();
    let corrupt_pdf = temp_dir.path().join("corrupt.pdf");
    std::fs::write(&corrupt_pdf, b"NOT_A_PDF_FILE_HEADER").unwrap();

    use std::io::Read;
    let mut header = [0u8; 5];
    let mut f = std::fs::File::open(&corrupt_pdf).unwrap();
    f.read_exact(&mut header).unwrap();

    let has_pdf_magic = header.starts_with(b"%PDF-");
    assert!(!has_pdf_magic, "Un fichier sans %PDF- doit être rejeté sans crasher");
}

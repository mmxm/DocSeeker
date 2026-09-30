use docseeker_backend::search::engine::{search_documents, search_within_document};
use rusqlite::params;

#[test]
fn test_markdown_global_and_in_document_search() {
    let conn = rusqlite::Connection::open_in_memory().unwrap();
    conn.execute_batch(&search_core::schema::get_full_schema_sql()).unwrap();

    // 1. Insérer un document Markdown
    conn.execute(
        "INSERT INTO documents (id, filename, title, file_size, status, doc_type) \
         VALUES (42, 'Notes Cliniques.md', 'Notes Cliniques', 2048, 'ready', 'markdown')",
        [],
    ).unwrap();

    // 2. Insérer une page avec du texte mais words_json NULL (cas typique Markdown)
    let content = "# Examen Clinique\n\nLe patient présente un signe de Homans positif et une suspicion de thrombose veineuse profonde (TVP) aiguë.\nRecommandation : echo-doppler en urgence.";
    conn.execute(
        "INSERT INTO pages (doc_id, page_number, text_content, words_json) VALUES (42, 1, ?1, NULL)",
        params![content],
    ).unwrap();

    // 3. Test de la recherche globale FTS5 avec words_json NULL : NE DOIT PAS CRASHER (erreur 500)
    let search_res = search_documents(&conn, "Homans", false, None, Some(10), Some(0))
        .expect("La recherche globale ne doit pas crasher");
    assert_eq!(search_res.total_documents, 1);
    assert_eq!(search_res.results.len(), 1);
    assert_eq!(search_res.results[0].id, 42);
    assert_eq!(search_res.results[0].filename, "Notes Cliniques.md");

    // 4. Test de la recherche in-document sur le document Markdown
    let doc_res = search_within_document(&conn, 42, "thrombose", None, None)
        .expect("La recherche in-document ne doit pas crasher");
    assert_eq!(doc_res.total_occurrences, 1);
    assert_eq!(doc_res.occurrences.len(), 1);
    assert!(doc_res.occurrences[0].text_snippet.contains("thrombose"));
    assert_eq!(doc_res.occurrences[0].page_number, 1);

    // 5. Test avec terme accentué ou non
    let doc_res2 = search_within_document(&conn, 42, "echo doppler", None, None)
        .expect("Recherche sans accent");
    assert_eq!(doc_res2.total_occurrences, 1);
    assert!(doc_res2.occurrences[0].text_snippet.contains("echo-doppler"));
}

#[test]
fn test_markdown_global_search_total_occurrences_count() {
    let conn = rusqlite::Connection::open_in_memory().unwrap();
    conn.execute_batch(&search_core::schema::get_full_schema_sql()).unwrap();

    // Note avec 8 occurrences de "MotX" sur 2 lignes
    conn.execute(
        "INSERT INTO documents (id, filename, title, file_size, status, doc_type) \
         VALUES (99, 'MultiOcc.md', 'MultiOcc', 2048, 'ready', 'markdown')",
        [],
    ).unwrap();

    let content = "# Multi\n\nMotX MotX MotX\nMotX MotX MotX MotX MotX\n";
    conn.execute(
        "INSERT INTO pages (doc_id, page_number, text_content, words_json) VALUES (99, 1, ?1, NULL)",
        params![content],
    ).unwrap();

    let search_res = search_documents(&conn, "MotX", false, None, Some(10), Some(0))
        .expect("La recherche globale doit réussir");
    assert_eq!(search_res.total_documents, 1);
    assert_eq!(search_res.results.len(), 1);
    assert_eq!(search_res.results[0].total_occurrences, 2);
    assert_eq!(search_res.total_occurrences, 2, "Le total global d'occurrences doit valoir 2 (somme des docs) et non pas 1 (nombre de pages)");
}

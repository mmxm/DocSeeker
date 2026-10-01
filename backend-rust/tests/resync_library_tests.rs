use axum::{
    body::{to_bytes, Body},
    http::{header, Request, StatusCode},
};
use rusqlite::Connection;
use std::sync::{Arc, Mutex};
use tower::ServiceExt;

use docseeker_backend::auth::rate_limit::LoginRateLimiter;
use docseeker_backend::config::Config;
use docseeker_backend::document::markdown::index_markdown_file;
use docseeker_backend::pdf::engine::PdfEngine;
use docseeker_backend::pipeline::IndexingPipeline;
use docseeker_backend::routes::create_api_router;
use docseeker_backend::AppState;

lazy_static::lazy_static! {
    static ref GLOBAL_PDF_ENGINE: Arc<PdfEngine> = Arc::new(PdfEngine::new().expect("PdfEngine requis"));
}

fn setup_test_app() -> (Arc<AppState>, String, tempfile::TempDir) {
    let tmp_dir = tempfile::tempdir().expect("Impossible de créer le répertoire temporaire");
    let docs_dir = tmp_dir.path().join("documents");
    let trash_dir = tmp_dir.path().join("trash");
    let cache_dir = tmp_dir.path().join("cache");
    let covers_dir = cache_dir.join("covers");
    let db_path = tmp_dir.path().join("db.sqlite");

    std::fs::create_dir_all(&docs_dir).unwrap();
    std::fs::create_dir_all(&trash_dir).unwrap();
    std::fs::create_dir_all(&covers_dir).unwrap();

    docseeker_backend::db::init_db(&db_path).unwrap();

    let init_conn = Connection::open(&db_path).unwrap();
    let session_token = "valid_session_token_resync_test";
    let expires = (chrono::Utc::now() + chrono::Duration::days(7)).to_rfc3339();
    init_conn.execute(
        "INSERT INTO sessions (id, expires_at) VALUES (?1, ?2)",
        rusqlite::params![session_token, expires],
    ).unwrap();

    let pool = docseeker_backend::db::create_pool(&db_path).unwrap();
    let pipeline_conn = Connection::open(&db_path).unwrap();
    let pipeline_db = Arc::new(Mutex::new(pipeline_conn));
    let pdf_engine = Arc::clone(&GLOBAL_PDF_ENGINE);

    let config = Config {
        host: "127.0.0.1".to_string(),
        port: 8080,
        data_dir: tmp_dir.path().to_path_buf(),
        documents_dir: docs_dir,
        trash_dir,
        cache_dir,
        covers_dir,
        db_path,
        max_upload_size: 10 * 1024 * 1024,
        max_md_upload_size: 10 * 1024 * 1024,
        session_duration_days: 30,
        default_admin_password: Some("adminpass".to_string()),
    };

    let pipeline = Arc::new(IndexingPipeline::new(
        pipeline_db,
        Arc::clone(&pdf_engine),
        config.clone(),
    ));

    let state = Arc::new(AppState {
        config,
        db: pool,
        pdf_engine,
        pipeline,
        rate_limiter: Arc::new(LoginRateLimiter::new()),
        crop_semaphore: Arc::new(tokio::sync::Semaphore::new(2)),
        crop_in_flight: Arc::new(Mutex::new(std::collections::HashMap::new())),
        crop_cache: Arc::new(Mutex::new(lru::LruCache::new(std::num::NonZeroUsize::new(100).unwrap()))),
    });

    (state, session_token.to_string(), tmp_dir)
}

#[tokio::test]
async fn test_resync_library_preserves_indexed_pages_and_syncs_changes() {
    let (state, token, _tmp) = setup_test_app();
    let app = create_api_router(Arc::clone(&state)).with_state(Arc::clone(&state));

    let cours_dir = state.config.documents_dir.join("Cours");
    let notes_dir = state.config.documents_dir.join("Notes");
    std::fs::create_dir_all(&cours_dir).unwrap();
    std::fs::create_dir_all(&notes_dir).unwrap();

    // 1. Initialiser la structure en base
    {
        let conn = state.db.get().unwrap();
        conn.execute("INSERT INTO folders (name, parent_id) VALUES ('Cours', NULL)", []).unwrap();
        let cours_id = conn.last_insert_rowid();

        conn.execute("INSERT INTO folders (name, parent_id) VALUES ('Notes', NULL)", []).unwrap();
        let notes_id = conn.last_insert_rowid();

        // Créer et indexer 2 documents Markdown
        let doc1_path = cours_dir.join("anatomie.md");
        std::fs::write(&doc1_path, "# Anatomie\nLe coeur et les poumons.").unwrap();
        index_markdown_file(&conn, &state.config, &doc1_path, "Cours/anatomie.md").unwrap();
        // Lier folder_id
        conn.execute("UPDATE documents SET folder_id = ?1 WHERE filename = 'Cours/anatomie.md'", rusqlite::params![cours_id]).unwrap();

        let doc2_path = notes_dir.join("memo.md");
        std::fs::write(&doc2_path, "# Mémo\nAcheter du café.").unwrap();
        index_markdown_file(&conn, &state.config, &doc2_path, "Notes/memo.md").unwrap();
        conn.execute("UPDATE documents SET folder_id = ?1 WHERE filename = 'Notes/memo.md'", rusqlite::params![notes_id]).unwrap();
    }

    // Récupérer les identifiants et vérifier l'indexation initiale
    let (doc1_id, doc2_id) = {
        let conn = state.db.get().unwrap();
        let d1: i64 = conn.query_row("SELECT id FROM documents WHERE filename = 'Cours/anatomie.md'", [], |r| r.get(0)).unwrap();
        let d2: i64 = conn.query_row("SELECT id FROM documents WHERE filename = 'Notes/memo.md'", [], |r| r.get(0)).unwrap();

        let pages_count: i64 = conn.query_row("SELECT COUNT(*) FROM pages WHERE doc_id = ?1", rusqlite::params![d1], |r| r.get(0)).unwrap();
        assert!(pages_count > 0, "Le document 1 doit avoir des pages indexées");

        let pages_text: String = conn.query_row("SELECT text_content FROM pages WHERE doc_id = ?1", rusqlite::params![d1], |r| r.get(0)).unwrap();
        assert!(pages_text.contains("Le coeur"), "Le texte du doc 1 doit être présent");

        (d1, d2)
    };

    // 2. Simuler des modifications directes sur le filesystem (Finder / OS) :
    // - Créer un sous-dossier Cours/Cardio
    let cardio_dir = cours_dir.join("Cardio");
    std::fs::create_dir_all(&cardio_dir).unwrap();

    // - Déplacer anatomie.md dans Cours/Cardio/anatomie.md
    let doc1_new_path = cardio_dir.join("anatomie.md");
    std::fs::rename(cours_dir.join("anatomie.md"), &doc1_new_path).unwrap();

    // - Supprimer memo.md directement sur disque
    std::fs::remove_file(notes_dir.join("memo.md")).unwrap();

    // - Ajouter un tout nouveau fichier sur disque
    let doc3_new_path = cours_dir.join("nouveau.md");
    std::fs::write(&doc3_new_path, "# Nouveau\nContenu tout neuf.").unwrap();

    // - Ajouter un nouveau dossier sur disque
    let archives_dir = state.config.documents_dir.join("Archives");
    std::fs::create_dir_all(&archives_dir).unwrap();

    // 3. Déclencher la réconciliation non-destructive via POST /api/maintenance/resync-library
    let cookie = format!("docseeker_session={}", token);
    let req = Request::builder()
        .method("POST")
        .uri("/api/maintenance/resync-library")
        .header(header::COOKIE, &cookie)
        .body(Body::empty())
        .unwrap();

    let res = app.oneshot(req).await.unwrap();
    assert_eq!(res.status(), StatusCode::OK);

    let body = to_bytes(res.into_body(), 1024 * 1024).await.unwrap();
    let json: serde_json::Value = serde_json::from_slice(&body).unwrap();

    assert_eq!(json["status"], "ok");
    assert_eq!(json["docs_moved"], 1, "Un document déplacé attendu");
    assert_eq!(json["docs_removed"], 1, "Un document supprimé attendu");
    assert_eq!(json["docs_new_queued"], 1, "Un nouveau document en file attendu");
    assert!(json["folders_created"].as_u64().unwrap() >= 2, "Au moins 2 dossiers créés (Cardio, Archives)");

    // 4. Vérifications en base de données SQLite :
    {
        let conn = state.db.get().unwrap();

        // Vérification A : Le document déplacé conserve son ID et son index de texte intact !
        let updated_filename: String = conn.query_row(
            "SELECT filename FROM documents WHERE id = ?1",
            rusqlite::params![doc1_id],
            |r| r.get(0),
        ).expect("Le doc1 doit toujours exister avec le même ID");
        assert_eq!(updated_filename, "Cours/Cardio/anatomie.md");

        let pages_count: i64 = conn.query_row(
            "SELECT COUNT(*) FROM pages WHERE doc_id = ?1",
            rusqlite::params![doc1_id],
            |r| r.get(0),
        ).unwrap();
        assert_eq!(pages_count, 1, "L'indexation de pages du doc déplacé doit être scrupuleusement conservée");

        let pages_text: String = conn.query_row(
            "SELECT text_content FROM pages WHERE doc_id = ?1",
            rusqlite::params![doc1_id],
            |r| r.get(0),
        ).unwrap();
        assert!(pages_text.contains("Le coeur"), "Le contenu FTS/texte doit rester intact sans réindexation");

        // Vérification B : Le document supprimé de la machine a été retiré de la base
        let doc2_exists: bool = conn.query_row(
            "SELECT COUNT(*) FROM documents WHERE id = ?1",
            rusqlite::params![doc2_id],
            |r| r.get::<_, i64>(0),
        ).unwrap() > 0;
        assert!(!doc2_exists, "Le doc2 supprimé sur disque doit être retiré de la base");

        // Vérification C : Le nouveau document est inséré avec statut pending
        let doc3_status: String = conn.query_row(
            "SELECT status FROM documents WHERE filename = 'Cours/nouveau.md'",
            [],
            |r| r.get(0),
        ).expect("Le nouveau document doit être inséré en base");
        assert_eq!(doc3_status, "pending");

        // Vérification D : Les dossiers existent dans la table folders
        let cardio_folder: bool = conn.query_row(
            "SELECT COUNT(*) FROM folders WHERE name = 'Cardio'",
            [],
            |r| r.get::<_, i64>(0),
        ).unwrap() > 0;
        assert!(cardio_folder, "Le dossier Cardio doit être créé");

        let archives_folder: bool = conn.query_row(
            "SELECT COUNT(*) FROM folders WHERE name = 'Archives'",
            [],
            |r| r.get::<_, i64>(0),
        ).unwrap() > 0;
        assert!(archives_folder, "Le dossier Archives doit être créé");
    }
}

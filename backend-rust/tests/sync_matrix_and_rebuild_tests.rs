use axum::{
    body::{to_bytes, Body},
    http::{header, Request, StatusCode},
};
use rusqlite::Connection;
use std::sync::{Arc, Mutex};
use tower::ServiceExt;

use docseeker_backend::auth::rate_limit::LoginRateLimiter;
use docseeker_backend::config::Config;
use docseeker_backend::document::processor::DocumentProcessor;
use docseeker_backend::document::markdown::MarkdownProcessor;
use docseeker_backend::document::sync::{ClientFileEntry, SyncManifestRequest, SyncPlan};
use docseeker_backend::document::trash::soft_delete;
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
    let session_token = "valid_session_token_matrix_test";
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
    });

    (state, session_token.to_string(), tmp_dir)
}

#[tokio::test]
async fn test_sync_manifest_10_files_concurrency_matrix() {
    let (state, token, _tmp) = setup_test_app();
    let router = create_api_router(Arc::clone(&state)).with_state(Arc::clone(&state));
    let cookie = format!("docseeker_session={}", token);
    let now = chrono::Utc::now().timestamp();

    // Configuration des 10 fichiers pour tester toute la combinatoire :
    // Fichier 1 & 2 : Modifiés côté client plus récemment -> PUSH
    let path_f1 = state.config.documents_dir.join("note_1.md");
    let path_f2 = state.config.documents_dir.join("note_2.md");
    std::fs::write(&path_f1, b"# Note 1 Server Old").unwrap();
    std::fs::write(&path_f2, b"# Note 2 Server Old").unwrap();
    filetime::set_file_mtime(&path_f1, filetime::FileTime::from_unix_time(now - 100, 0)).unwrap();
    filetime::set_file_mtime(&path_f2, filetime::FileTime::from_unix_time(now - 100, 0)).unwrap();

    // Fichier 3 & 4 : Modifiés côté serveur plus récemment (client B) -> PULL
    let path_f3 = state.config.documents_dir.join("note_3.md");
    let path_f4 = state.config.documents_dir.join("note_4.md");
    std::fs::write(&path_f3, b"# Note 3 Server Newer").unwrap();
    std::fs::write(&path_f4, b"# Note 4 Server Newer").unwrap();
    filetime::set_file_mtime(&path_f3, filetime::FileTime::from_unix_time(now + 100, 0)).unwrap();
    filetime::set_file_mtime(&path_f4, filetime::FileTime::from_unix_time(now + 100, 0)).unwrap();

    // Fichier 5 : Supprimé côté client offline (status = deleted, mtime > server) -> PUSH (déclenchera soft delete serveur)
    let path_f5 = state.config.documents_dir.join("note_5.md");
    std::fs::write(&path_f5, b"# Note 5 To Delete").unwrap();
    filetime::set_file_mtime(&path_f5, filetime::FileTime::from_unix_time(now - 100, 0)).unwrap();

    // Fichier 6 : Supprimé côté serveur (se trouve déjà dans trash_dir) -> DELETE_LOCAL
    let path_f6 = state.config.documents_dir.join("note_6.md");
    std::fs::write(&path_f6, b"# Note 6 Server Deleted").unwrap();
    {
        let conn = state.db.get().unwrap();
        conn.execute("INSERT INTO documents (filename, title, doc_type, status) VALUES ('note_6.md', 'note_6', 'markdown', 'ready')", []).unwrap();
        soft_delete(&conn, &state.config, "note_6.md").unwrap();
    }

    // Fichier 7 : Créé neuf côté client (n'existe pas sur le serveur) -> PUSH
    // (rien sur le serveur)

    // Fichier 8 : Créé neuf côté serveur -> PULL
    let path_f8 = state.config.documents_dir.join("note_8.md");
    std::fs::write(&path_f8, b"# Note 8 Server Brand New").unwrap();
    filetime::set_file_mtime(&path_f8, filetime::FileTime::from_unix_time(now, 0)).unwrap();

    // Fichier 9 : En corbeille serveur mais ré-édité par client offline (mtime client > deleted_at) -> PUSH (restauration implicite)
    let path_f9 = state.config.documents_dir.join("note_9.md");
    std::fs::write(&path_f9, b"# Note 9 In Trash").unwrap();
    {
        let conn = state.db.get().unwrap();
        conn.execute("INSERT INTO documents (filename, title, doc_type, status) VALUES ('note_9.md', 'note_9', 'markdown', 'ready')", []).unwrap();
        soft_delete(&conn, &state.config, "note_9.md").unwrap();
    }

    // Fichier 10 : Identique des deux côtés -> NOOP (ni push ni pull)
    let path_f10 = state.config.documents_dir.join("note_10.md");
    std::fs::write(&path_f10, b"# Note 10 In Sync").unwrap();
    filetime::set_file_mtime(&path_f10, filetime::FileTime::from_unix_time(now, 0)).unwrap();

    // Préparation du Manifest Client
    let client_manifest = SyncManifestRequest {
        files: vec![
            ClientFileEntry { filename: "note_1.md".to_string(), hash: None, mtime: now, status: Some("ready".to_string()) },
            ClientFileEntry { filename: "note_2.md".to_string(), hash: None, mtime: now, status: Some("ready".to_string()) },
            ClientFileEntry { filename: "note_3.md".to_string(), hash: None, mtime: now - 50, status: Some("ready".to_string()) },
            ClientFileEntry { filename: "note_4.md".to_string(), hash: None, mtime: now - 50, status: Some("ready".to_string()) },
            ClientFileEntry { filename: "note_5.md".to_string(), hash: None, mtime: now, status: Some("deleted".to_string()) },
            ClientFileEntry { filename: "note_6.md".to_string(), hash: None, mtime: now - 500, status: Some("ready".to_string()) },
            ClientFileEntry { filename: "note_7.md".to_string(), hash: None, mtime: now, status: Some("created".to_string()) },
            ClientFileEntry { filename: "note_9.md".to_string(), hash: None, mtime: now + 500, status: Some("modified".to_string()) },
            ClientFileEntry { filename: "note_10.md".to_string(), hash: None, mtime: now, status: Some("ready".to_string()) },
        ],
        trash: vec![],
    };

    // 1. Envoyer le manifeste au serveur : POST /api/sync/manifest
    let req = Request::builder()
        .method("POST")
        .uri("/api/sync/manifest")
        .header(header::COOKIE, &cookie)
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(serde_json::to_string(&client_manifest).unwrap()))
        .unwrap();

    let res = router.clone().oneshot(req).await.unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    let body = to_bytes(res.into_body(), usize::MAX).await.unwrap();
    let plan: SyncPlan = serde_json::from_slice(&body).unwrap();

    // 2. Validation exhaustive du SyncPlan généré
    println!("=== SyncPlan Reçu ===");
    println!("PUSH: {:?}", plan.push);
    println!("PULL: {:?}", plan.pull.iter().map(|p| &p.filename).collect::<Vec<_>>());
    println!("DELETE_LOCAL: {:?}", plan.delete_local);

    // Vérifier les PUSH attendus : note_1, note_2, note_5 (suppression), note_7 (nouveau), note_9 (restauration)
    assert!(plan.push.contains(&"note_1.md".to_string()), "note_1.md doit être pushée");
    assert!(plan.push.contains(&"note_2.md".to_string()), "note_2.md doit être pushée");
    assert!(plan.push.contains(&"note_5.md".to_string()), "note_5.md doit être pushée pour suppression");
    assert!(plan.push.contains(&"note_7.md".to_string()), "note_7.md doit être pushée car nouveau");
    assert!(plan.push.contains(&"note_9.md".to_string()), "note_9.md doit être pushée pour restauration implicite");

    // Vérifier les PULL attendus : note_3, note_4, note_8 (nouveau sur serveur)
    let pull_files: Vec<String> = plan.pull.iter().map(|p| p.filename.clone()).collect();
    assert!(pull_files.contains(&"note_3.md".to_string()), "note_3.md doit être pullée");
    assert!(pull_files.contains(&"note_4.md".to_string()), "note_4.md doit être pullée");
    assert!(pull_files.contains(&"note_8.md".to_string()), "note_8.md doit être pullée car nouveau serveur");

    // Vérifier DELETE_LOCAL attendu : note_6 (supprimé sur le serveur)
    assert!(plan.delete_local.contains(&"note_6.md".to_string()), "note_6.md doit être supprimée localement");

    // Vérifier que note_10 (en phase) n'est ni pushée ni pullée
    assert!(!plan.push.contains(&"note_10.md".to_string()));
    assert!(!pull_files.contains(&"note_10.md".to_string()));

    // 3. Exécution de la synchronisation par le client :
    // Push note_1 et note_2 avec nouveau contenu
    for f in &["note_1.md", "note_2.md", "note_7.md", "note_9.md"] {
        let req = Request::builder()
            .method("PUT")
            .uri(format!("/api/files/{}", f))
            .header(header::COOKIE, &cookie)
            .header(header::CONTENT_TYPE, "text/markdown")
            .body(Body::from(format!("# {} Synchronized Client Content", f)))
            .unwrap();
        let res = router.clone().oneshot(req).await.unwrap();
        assert_eq!(res.status(), StatusCode::OK, "PUT {} doit réussir", f);
    }

    // Push suppression de note_5
    let req = Request::builder()
        .method("DELETE")
        .uri("/api/files/note_5.md")
        .header(header::COOKIE, &cookie)
        .body(Body::empty())
        .unwrap();
    let res = router.clone().oneshot(req).await.unwrap();
    assert_eq!(res.status(), StatusCode::OK);

    // 4. Vérification finale de l'état du serveur
    assert!(docseeker_backend::document::trash::resolve_file_path(&state.config.documents_dir, "note_1.md").is_some());
    assert!(docseeker_backend::document::trash::resolve_file_path(&state.config.documents_dir, "note_7.md").is_some());
    assert!(docseeker_backend::document::trash::resolve_file_path(&state.config.documents_dir, "note_9.md").is_some(), "note_9.md doit être restaurée dans documents/");
    assert!(!state.config.trash_dir.join("del_note_9.md").exists(), "del_note_9.md doit être retiré de trash/");
    assert!(docseeker_backend::document::trash::resolve_file_path(&state.config.documents_dir, "note_5.md").is_none(), "note_5.md doit être retiré de documents/");
    assert!(state.config.trash_dir.join("del_note_5.md").exists(), "del_note_5.md doit être en corbeille");
}

#[tokio::test]
async fn test_server_database_destruction_and_rebuild_recovery() {
    let (state, token, _tmp) = setup_test_app();
    let router = create_api_router(Arc::clone(&state)).with_state(Arc::clone(&state));
    let cookie = format!("docseeker_session={}", token);

    // 1. Créer une arborescence complète avec des fichiers et de la corbeille
    let cardiodir = state.config.documents_dir.join("Cardiologie");
    let pneumodir = state.config.documents_dir.join("Pneumologie");
    std::fs::create_dir_all(&cardiodir).unwrap();
    std::fs::create_dir_all(&pneumodir).unwrap();

    // Fichiers physiques
    std::fs::write(cardiodir.join("infarctus.md"), b"# Infarctus du myocarde\n\nSymptomes et prise en charge.").unwrap();
    std::fs::write(pneumodir.join("embolie.md"), b"# Embolie pulmonaire\n\nDiagnostic et traitement urgent.").unwrap();
    std::fs::write(state.config.documents_dir.join("todo.md"), b"# Todo List\n\n1. Relire les cours").unwrap();

    // Pièce jointe dans assets/ (doit être ignorée par le scanner de documents)
    let assets_dir = state.config.documents_dir.join("assets").join("infarctus");
    std::fs::create_dir_all(&assets_dir).unwrap();
    std::fs::write(assets_dir.join("ecg.png"), b"FAKE_PNG_BYTES").unwrap();

    // Fichier en corbeille avec .meta.json
    let trash_doc = state.config.trash_dir.join("del_ancien_cours.md");
    let trash_meta = state.config.trash_dir.join("del_ancien_cours.md.meta.json");
    std::fs::write(&trash_doc, b"# Ancien cours obsolete").unwrap();
    let meta_json = serde_json::json!({
        "original_path": "Cardiologie/ancien_cours.md",
        "deleted_at": chrono::Utc::now().to_rfc3339(),
        "expires_at": (chrono::Utc::now() + chrono::Duration::days(30)).to_rfc3339()
    });
    std::fs::write(&trash_meta, serde_json::to_string_pretty(&meta_json).unwrap()).unwrap();

    // 2. Déclencher la reconstruction totale via POST /api/rebuild-db
    let req = Request::builder()
        .method("POST")
        .uri("/api/rebuild-db")
        .header(header::COOKIE, &cookie)
        .body(Body::empty())
        .unwrap();

    let res = router.clone().oneshot(req).await.unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    let body = to_bytes(res.into_body(), usize::MAX).await.unwrap();
    let resp: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(resp["status"], "rebuilding");
    assert_eq!(resp["queued_count"], 3, "3 documents actifs doivent être indexés");

    // 3. Vérifier les tables de la DB reconstruite
    let conn = state.db.get().unwrap();

    // Vérifier les folders
    let cardio_count: i64 = conn.query_row("SELECT COUNT(*) FROM folders WHERE name = 'Cardiologie'", [], |r| r.get(0)).unwrap();
    let pneumo_count: i64 = conn.query_row("SELECT COUNT(*) FROM folders WHERE name = 'Pneumologie'", [], |r| r.get(0)).unwrap();
    assert_eq!(cardio_count, 1);
    assert_eq!(pneumo_count, 1);

    // Vérifier les documents actifs
    let docs_count: i64 = conn.query_row("SELECT COUNT(*) FROM documents WHERE status != 'trashed'", [], |r| r.get(0)).unwrap();
    assert_eq!(docs_count, 3, "Il doit y avoir 3 documents actifs");

    // Vérifier que le dossier assets/ n'a pas été indexé comme document
    let asset_doc_count: i64 = conn.query_row("SELECT COUNT(*) FROM documents WHERE filename LIKE '%ecg.png%' OR filename LIKE '%assets%'", [], |r| r.get(0)).unwrap();
    assert_eq!(asset_doc_count, 0, "Les assets ne doivent jamais être indexés comme documents");

    // Vérifier le document restauré en corbeille
    let trashed_count: i64 = conn.query_row("SELECT COUNT(*) FROM documents WHERE status = 'trashed'", [], |r| r.get(0)).unwrap();
    assert_eq!(trashed_count, 1, "Le document del_ancien_cours.md doit être répertorié comme trashed");

    // Vérifier le doc_type 'markdown'
    let md_count: i64 = conn.query_row("SELECT COUNT(*) FROM documents WHERE doc_type = 'markdown'", [], |r| r.get(0)).unwrap();
    assert_eq!(md_count, 4, "Les 3 documents actifs + 1 corbeille sont de type markdown");
}

#[tokio::test]
async fn test_markdown_cover_generation_visual_verification() {
    let tmp = tempfile::tempdir().unwrap();
    let note_path = tmp.path().join("cours_sémiologie.md");
    let cover_path = tmp.path().join("cover_sémiologie.webp");

    let content = r#"# Sémiologie Cardiovasculaire

La sémiologie cardiaque repose sur :
- L'interrogatoire minutieux (douleur thoracique, dyspnée)
- L'auscultation cardiaque aux 4 foyers
- La prise de pression artérielle bilatérale
- La recherche de signes d'insuffisance cardiaque droite

> Tout symptôme aigu impose un ECG 12 dérivations dans les 10 minutes.
"#;
    std::fs::write(&note_path, content).unwrap();

    let processor = MarkdownProcessor::new();
    let res = processor.generate_cover(&note_path, &cover_path, 42);
    assert!(res.is_ok(), "La génération de la vignette WebP doit réussir : {:?}", res.err());

    // Vérification du fichier physique généré
    assert!(cover_path.exists(), "Le fichier cover WebP doit exister");
    let bytes = std::fs::read(&cover_path).unwrap();
    assert!(!bytes.is_empty(), "La vignette ne doit pas être vide");

    // Validation du format WebP (signature RIFF ... WEBP)
    assert!(bytes.len() >= 12, "Le fichier doit comporter au moins 12 octets");
    assert_eq!(&bytes[0..4], b"RIFF", "Signature WebP : en-tête RIFF attendu");
    assert_eq!(&bytes[8..12], b"WEBP", "Signature WebP : identifiant WEBP attendu");

    println!("Vignette WebP générée avec succès : {} octets", bytes.len());
}

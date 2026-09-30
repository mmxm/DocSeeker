use axum::{
    body::{to_bytes, Body},
    http::{header, Request, StatusCode},
};
use rusqlite::Connection;
use std::sync::{Arc, Mutex};
use tower::ServiceExt;

use docseeker_backend::auth::rate_limit::LoginRateLimiter;
use docseeker_backend::config::Config;
use docseeker_backend::document::sync::{ClientFileEntry, SyncManifestRequest};
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
    let session_token = "valid_session_token_xyz_123";
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
async fn test_markdown_file_crud_and_trash_lifecycle() {
    let (state, token, _tmp) = setup_test_app();
    let router = create_api_router(Arc::clone(&state)).with_state(Arc::clone(&state));

    let cookie = format!("docseeker_session={}", token);

    // 1. Créer une nouvelle note Markdown
    let req = Request::builder()
        .method("POST")
        .uri("/api/files")
        .header(header::COOKIE, &cookie)
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(serde_json::json!({
            "filename": "Sémiologie Cardiaque.md",
            "content": "# Sémiologie Cardiaque\n\nNotes cliniques sur les souffles au cœur."
        }).to_string()))
        .unwrap();

    let res = router.clone().oneshot(req).await.unwrap();
    assert_eq!(res.status(), StatusCode::CREATED);
    let body = to_bytes(res.into_body(), usize::MAX).await.unwrap();
    let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(json["status"], "created");
    assert_eq!(json["filename"], "Sémiologie Cardiaque.md");

    // Vérifier présence physique sur le disque du dossier de la note, du fichier markdown et de assets/
    let note_dir = state.config.documents_dir.join("Sémiologie Cardiaque");
    let physical_file = note_dir.join("Sémiologie Cardiaque.md");
    let assets_dir = note_dir.join("assets");
    assert!(note_dir.exists(), "Le dossier de la note doit exister");
    assert!(physical_file.exists(), "Le fichier markdown dans le dossier de note doit exister");
    assert!(assets_dir.exists(), "Le sous-dossier assets/ dans le dossier de note doit exister");

    // 2. Tenter de créer une note avec le même nom -> 409 CONFLICT (Règle Absolue : Pas de doublon)
    let req_dup = Request::builder()
        .method("POST")
        .uri("/api/files")
        .header(header::COOKIE, &cookie)
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(serde_json::json!({
            "filename": "Sémiologie Cardiaque.md",
            "content": "Doublon interdit"
        }).to_string()))
        .unwrap();

    let res_dup = router.clone().oneshot(req_dup).await.unwrap();
    assert_eq!(res_dup.status(), StatusCode::CONFLICT);

    // 2b. Tenter de créer une note avec '/' ou '\' dans le titre -> 400 BAD_REQUEST
    let req_slash = Request::builder()
        .method("POST")
        .uri("/api/files")
        .header(header::COOKIE, &cookie)
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(serde_json::json!({
            "filename": "QA imbric/deux/note.md",
            "content": "# Test"
        }).to_string()))
        .unwrap();
    let res_slash = router.clone().oneshot(req_slash).await.unwrap();
    assert_eq!(res_slash.status(), StatusCode::BAD_REQUEST);

    // 3. Lire le contenu brut du fichier via GET /api/files/*filename
    let req_get = Request::builder()
        .uri("/api/files/Sémiologie%20Cardiaque.md")
        .header(header::COOKIE, &cookie)
        .body(Body::empty())
        .unwrap();

    let res_get = router.clone().oneshot(req_get).await.unwrap();
    assert_eq!(res_get.status(), StatusCode::OK);
    let bytes = to_bytes(res_get.into_body(), usize::MAX).await.unwrap();
    let text = String::from_utf8(bytes.to_vec()).unwrap();
    assert!(text.contains("Sémiologie Cardiaque"));
    assert!(text.contains("souffles au cœur"));

    // 4. Mettre à jour la note via PUT /api/files/*filename
    let req_put = Request::builder()
        .method("PUT")
        .uri("/api/files/Sémiologie%20Cardiaque.md")
        .header(header::COOKIE, &cookie)
        .header(header::CONTENT_TYPE, "text/markdown")
        .body(Body::from("# Sémiologie Cardiaque\n\nVersion mise à jour avec de nouveaux signes cliniques."))
        .unwrap();

    let res_put = router.clone().oneshot(req_put).await.unwrap();
    assert_eq!(res_put.status(), StatusCode::OK);

    // Vérifier mise à jour physique
    let updated_text = std::fs::read_to_string(&physical_file).unwrap();
    assert!(updated_text.contains("Version mise à jour"));

    // 5. Soft-Delete vers la corbeille via DELETE /api/files/*filename
    let req_del = Request::builder()
        .method("DELETE")
        .uri("/api/files/Sémiologie%20Cardiaque.md")
        .header(header::COOKIE, &cookie)
        .body(Body::empty())
        .unwrap();

    let res_del = router.clone().oneshot(req_del).await.unwrap();
    assert_eq!(res_del.status(), StatusCode::OK);

    // Le fichier et le dossier de note ne doivent plus être dans documents_dir
    assert!(!physical_file.exists());
    assert!(!note_dir.exists());

    // Le fichier physique doit être dans trash_dir avec del_ et son .meta.json
    let trash_file = state.config.trash_dir.join("del_Sémiologie Cardiaque.md");
    let meta_file = state.config.trash_dir.join("del_Sémiologie Cardiaque.md.meta.json");
    assert!(trash_file.exists());
    assert!(meta_file.exists());

    // 6. Lister les éléments de la corbeille via GET /api/trash
    let req_trash = Request::builder()
        .uri("/api/trash")
        .header(header::COOKIE, &cookie)
        .body(Body::empty())
        .unwrap();

    let res_trash = router.clone().oneshot(req_trash).await.unwrap();
    assert_eq!(res_trash.status(), StatusCode::OK);
    let body_trash = to_bytes(res_trash.into_body(), usize::MAX).await.unwrap();
    let json_trash: serde_json::Value = serde_json::from_slice(&body_trash).unwrap();
    let items = json_trash["items"].as_array().unwrap();
    assert_eq!(items.len(), 1);
    assert_eq!(items[0]["original_path"], "Sémiologie Cardiaque.md");

    // 7. Restaurer le fichier via POST /api/trash/restore
    let req_restore = Request::builder()
        .method("POST")
        .uri("/api/trash/restore")
        .header(header::COOKIE, &cookie)
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(serde_json::json!({
            "filename": "Sémiologie Cardiaque.md"
        }).to_string()))
        .unwrap();

    let res_restore = router.clone().oneshot(req_restore).await.unwrap();
    assert_eq!(res_restore.status(), StatusCode::OK);

    // Le dossier de note et son fichier doivent être restaurés dans documents_dir
    assert!(note_dir.exists());
    assert!(physical_file.exists());
    assert!(assets_dir.exists());
    // Et le .meta.json de corbeille supprimé
    assert!(!meta_file.exists());
}

#[tokio::test]
async fn test_sync_manifest_differential_protocol() {
    let (state, token, _tmp) = setup_test_app();
    let router = create_api_router(Arc::clone(&state)).with_state(Arc::clone(&state));
    let cookie = format!("docseeker_session={}", token);

    // Créer un fichier sur le serveur
    let server_file = state.config.documents_dir.join("serveur_doc.md");
    std::fs::write(&server_file, "# Doc Serveur").unwrap();

    // Simuler requête manifest client avec :
    // - client_doc.md : nouveau fichier client (absent du serveur) -> push attendu
    // - serveur_doc.md : ancien mtime client -> pull attendu
    let now = chrono::Utc::now().timestamp();
    let manifest_req = SyncManifestRequest {
        files: vec![
            ClientFileEntry {
                filename: "client_doc.md".to_string(),
                hash: None,
                mtime: now + 100,
                status: Some("active".to_string()),
            },
            ClientFileEntry {
                filename: "serveur_doc.md".to_string(),
                hash: None,
                mtime: now - 1000, // très ancien
                status: Some("active".to_string()),
            },
        ],
        trash: vec![],
    };

    let req = Request::builder()
        .method("POST")
        .uri("/api/sync/manifest")
        .header(header::COOKIE, &cookie)
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(serde_json::to_string(&manifest_req).unwrap()))
        .unwrap();

    let res = router.clone().oneshot(req).await.unwrap();
    assert_eq!(res.status(), StatusCode::OK);

    let body = to_bytes(res.into_body(), usize::MAX).await.unwrap();
    let plan: serde_json::Value = serde_json::from_slice(&body).unwrap();

    // client_doc.md doit être dans push
    let push_list: Vec<String> = plan["push"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v.as_str().unwrap().to_string())
        .collect();
    assert!(push_list.contains(&"client_doc.md".to_string()));

    // serveur_doc.md doit être dans pull
    let pull_files: Vec<String> = plan["pull"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v["filename"].as_str().unwrap().to_string())
        .collect();
    assert!(pull_files.contains(&"serveur_doc.md".to_string()));
}

#[tokio::test]
async fn test_rebuild_db_from_filesystem_recovery() {
    let (state, token, _tmp) = setup_test_app();
    let router = create_api_router(Arc::clone(&state)).with_state(Arc::clone(&state));
    let cookie = format!("docseeker_session={}", token);

    // Créer une hiérarchie physique de dossiers et fichiers
    let cardio_dir = state.config.documents_dir.join("Cardiologie");
    std::fs::create_dir_all(&cardio_dir).unwrap();
    std::fs::write(cardio_dir.join("cours_ecg.md"), "# Cours ECG\n\nTracé normal et infarctus.").unwrap();
    std::fs::write(state.config.documents_dir.join("todo.md"), "# A faire").unwrap();

    // Déclencher la reconstruction totale de la base via POST /api/rebuild-db
    let req = Request::builder()
        .method("POST")
        .uri("/api/rebuild-db")
        .header(header::COOKIE, &cookie)
        .body(Body::empty())
        .unwrap();

    let res = router.clone().oneshot(req).await.unwrap();
    assert_eq!(res.status(), StatusCode::OK);

    let body = to_bytes(res.into_body(), usize::MAX).await.unwrap();
    let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(json["status"], "rebuilding");
    assert_eq!(json["queued_count"], 2);

    // Vérifier que la DB SQLite dérivée contient bien les dossiers et documents
    let conn = state.db.get().unwrap();
    let doc_count: i64 = conn.query_row("SELECT COUNT(*) FROM documents", [], |r| r.get(0)).unwrap();
    assert_eq!(doc_count, 2);

    let folder_count: i64 = conn.query_row("SELECT COUNT(*) FROM folders WHERE name = 'Cardiologie'", [], |r| r.get(0)).unwrap();
    assert_eq!(folder_count, 1);
}

#[tokio::test]
async fn test_markdown_rename_assets_and_soft_delete_handler() {
    let (state, token, _tmp) = setup_test_app();
    let router = create_api_router(Arc::clone(&state)).with_state(Arc::clone(&state));
    let cookie = format!("docseeker_session={}", token);

    // 1. Créer une note Markdown
    let req = Request::builder()
        .method("POST")
        .uri("/api/files")
        .header(header::COOKIE, &cookie)
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(serde_json::json!({
            "filename": "biologie.md",
            "content": "# Biologie Cellulaire\n\nNotes de cours."
        }).to_string()))
        .unwrap();

    let res = router.clone().oneshot(req).await.unwrap();
    assert_eq!(res.status(), StatusCode::CREATED);
    let body = to_bytes(res.into_body(), usize::MAX).await.unwrap();
    let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
    let doc_id = json["doc_id"].as_i64().unwrap();

    // 2. Créer un asset physique pour cette note dans son sous-dossier assets/
    let assets_dir = state.config.documents_dir.join("biologie").join("assets");
    std::fs::create_dir_all(&assets_dir).unwrap();
    std::fs::write(assets_dir.join("cellule.png"), b"FAKE_PNG_BYTES").unwrap();

    // 3. Renommer la note via PATCH /api/documents/:id
    let req = Request::builder()
        .method("PATCH")
        .uri(format!("/api/documents/{}", doc_id))
        .header(header::COOKIE, &cookie)
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(serde_json::json!({
            "title": "Biochimie"
        }).to_string()))
        .unwrap();

    let res = router.clone().oneshot(req).await.unwrap();
    assert_eq!(res.status(), StatusCode::OK);

    // Vérifier que le dossier de la note, le fichier markdown et le dossier d'assets ont été renommés
    let new_note_dir = state.config.documents_dir.join("Biochimie");
    let new_md_file = new_note_dir.join("Biochimie.md");
    let new_asset_file = new_note_dir.join("assets").join("cellule.png");
    assert!(new_note_dir.exists(), "Le nouveau dossier de note doit exister");
    assert!(new_md_file.exists(), "Le fichier markdown renommé doit exister dans le dossier");
    assert!(new_asset_file.exists(), "L'asset doit avoir suivi dans le dossier de note renommé");
    assert!(!state.config.documents_dir.join("biologie").exists(), "L'ancien dossier de note ne doit plus exister");

    // Indexer la note pour qu'elle passe au statut 'ready'
    {
        let conn = state.db.get().unwrap();
        docseeker_backend::document::markdown::index_markdown_file(
            &conn,
            &state.config,
            &new_md_file,
            "Biochimie.md",
        ).unwrap();
    }

    // 4. Vérifier GET /api/documents/:id/offline-bundle
    let req = Request::builder()
        .method("GET")
        .uri(format!("/api/documents/{}/offline-bundle", doc_id))
        .header(header::COOKIE, &cookie)
        .body(Body::empty())
        .unwrap();

    let res = router.clone().oneshot(req).await.unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    let body = to_bytes(res.into_body(), usize::MAX).await.unwrap();
    let bundle: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(bundle["document"]["doc_type"], "markdown");

    // 5. Supprimer via DELETE /api/documents/:id
    let req = Request::builder()
        .method("DELETE")
        .uri(format!("/api/documents/{}", doc_id))
        .header(header::COOKIE, &cookie)
        .body(Body::empty())
        .unwrap();

    let res = router.clone().oneshot(req).await.unwrap();
    assert_eq!(res.status(), StatusCode::OK);

    // Vérifier que le dossier de note est parti en corbeille (soft-delete)
    assert!(!new_note_dir.exists(), "Le dossier de note doit avoir disparu de documents_dir");
    assert!(state.config.trash_dir.join("del_Biochimie.md").exists());
    assert!(state.config.trash_dir.join("del_Biochimie.md.meta.json").exists());
}

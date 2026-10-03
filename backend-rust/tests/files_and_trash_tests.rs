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
        crop_cache: Arc::new(docseeker_backend::ShardedCropCache::new()),
        search_cache: Arc::new(Mutex::new(std::collections::HashMap::new())),
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

    // Vérifier présence physique sur le disque du fichier markdown et de .assets/
    let physical_file = state.config.documents_dir.join("Sémiologie Cardiaque.md");
    let assets_dir = state.config.documents_dir.join(".assets").join("Sémiologie Cardiaque");
    assert!(physical_file.exists(), "Le fichier markdown direct doit exister");
    assert!(assets_dir.exists(), "Le dossier d'assets dans .assets/ doit exister");
    assert!(!state.config.documents_dir.join("Sémiologie Cardiaque").is_dir(), "Aucun dossier visible ne doit exister");

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

    // Le fichier et le dossier d'assets ne doivent plus être dans documents_dir
    assert!(!physical_file.exists());
    assert!(!assets_dir.exists());

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

    // Le fichier direct et son dossier d'assets doivent être restaurés dans documents_dir
    assert!(physical_file.exists());
    assert!(assets_dir.exists());
    assert!(!state.config.documents_dir.join("Sémiologie Cardiaque").is_dir());
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
async fn test_server_trash_not_resurrected_by_ready_client_file() {
    let (state, token, _tmp) = setup_test_app();
    let router = create_api_router(Arc::clone(&state)).with_state(Arc::clone(&state));
    let cookie = format!("docseeker_session={}", token);

    // 1. Créer un fichier sur le serveur et le mettre en corbeille
    let file_path = state.config.documents_dir.join("QAProbeSync.md");
    std::fs::write(&file_path, "# Probe").unwrap();
    let db_conn = state.db.get().unwrap();
    db_conn.execute(
        "INSERT INTO documents (filename, title, doc_type, status) VALUES ('QAProbeSync.md', 'QAProbeSync', 'markdown', 'ready')",
        [],
    ).unwrap();
    docseeker_backend::document::trash::soft_delete(&db_conn, &state.config, "QAProbeSync.md").unwrap();

    let now = chrono::Utc::now().timestamp();

    // 2. Client envoie un manifeste avec status="ready" et mtime récent
    let manifest_ready = SyncManifestRequest {
        files: vec![
            ClientFileEntry {
                filename: "QAProbeSync.md".to_string(),
                hash: None,
                mtime: now + 500,
                status: Some("ready".to_string()),
            },
        ],
        trash: vec![],
    };

    let req_ready = Request::builder()
        .method("POST")
        .uri("/api/sync/manifest")
        .header(header::COOKIE, &cookie)
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(serde_json::to_string(&manifest_ready).unwrap()))
        .unwrap();

    let res_ready = router.clone().oneshot(req_ready).await.unwrap();
    assert_eq!(res_ready.status(), StatusCode::OK);
    let body_ready = to_bytes(res_ready.into_body(), usize::MAX).await.unwrap();
    let plan_ready: serde_json::Value = serde_json::from_slice(&body_ready).unwrap();

    let delete_local: Vec<String> = plan_ready["delete_local"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v.as_str().unwrap().to_string())
        .collect();
    let push_ready: Vec<String> = plan_ready["push"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v.as_str().unwrap().to_string())
        .collect();

    assert!(delete_local.contains(&"QAProbeSync.md".to_string()), "La note en corbeille serveur doit être supprimée en local pour un client non-modifié (ready)");
    assert!(!push_ready.contains(&"QAProbeSync.md".to_string()), "La note ne doit pas être ressuscitée dans push");

    // 3. Client envoie un manifeste avec status="modified" et mtime plus récent -> push (restauration explicite)
    let manifest_modified = SyncManifestRequest {
        files: vec![
            ClientFileEntry {
                filename: "QAProbeSync.md".to_string(),
                hash: None,
                mtime: now + 500,
                status: Some("modified".to_string()),
            },
        ],
        trash: vec![],
    };

    let req_mod = Request::builder()
        .method("POST")
        .uri("/api/sync/manifest")
        .header(header::COOKIE, &cookie)
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(serde_json::to_string(&manifest_modified).unwrap()))
        .unwrap();

    let res_mod = router.clone().oneshot(req_mod).await.unwrap();
    assert_eq!(res_mod.status(), StatusCode::OK);
    let body_mod = to_bytes(res_mod.into_body(), usize::MAX).await.unwrap();
    let plan_mod: serde_json::Value = serde_json::from_slice(&body_mod).unwrap();

    let push_mod: Vec<String> = plan_mod["push"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v.as_str().unwrap().to_string())
        .collect();

    assert!(push_mod.contains(&"QAProbeSync.md".to_string()), "Une modification explicite client (modified) doit être pushée");
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

    // 2. Créer un asset physique pour cette note dans son dossier .assets/
    let assets_dir = state.config.documents_dir.join(".assets").join("biologie");
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

    // Vérifier que le fichier markdown et le dossier d'assets ont été renommés
    let new_md_file = state.config.documents_dir.join("Biochimie.md");
    let new_asset_file = state.config.documents_dir.join(".assets").join("Biochimie").join("cellule.png");
    assert!(new_md_file.exists(), "Le fichier markdown renommé doit exister");
    assert!(new_asset_file.exists(), "L'asset doit avoir suivi dans le nouveau dossier .assets");
    assert!(!state.config.documents_dir.join("biologie.md").exists(), "L'ancien fichier markdown ne doit plus exister");
    assert!(!assets_dir.exists(), "L'ancien dossier d'assets ne doit plus exister");

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

    // Vérifier que la note et ses assets sont partis en corbeille (soft-delete)
    assert!(!new_md_file.exists(), "Le fichier de note doit avoir disparu de documents_dir");
    assert!(!new_asset_file.exists(), "Le fichier d'asset doit avoir disparu de documents_dir");
    assert!(state.config.trash_dir.join("del_Biochimie.md").exists());
    assert!(state.config.trash_dir.join("del_Biochimie.md.meta.json").exists());

    // 6. Supprimer définitivement via DELETE /api/trash/del_Biochimie.md
    let req = Request::builder()
        .method("DELETE")
        .uri("/api/trash/del_Biochimie.md")
        .header(header::COOKIE, &cookie)
        .body(Body::empty())
        .unwrap();

    let res = router.clone().oneshot(req).await.unwrap();
    assert_eq!(res.status(), StatusCode::OK);

    // 7. Vérifier l'absence d'orphelins et la suppression complète en BDD
    let db_conn = state.db.get().unwrap();
    let orphan_count: i64 = db_conn
        .query_row(
            "SELECT count(*) FROM pages p LEFT JOIN documents d ON p.doc_id=d.id WHERE d.id IS NULL",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(orphan_count, 0, "Aucune page orpheline ne doit subsister après purge");

    let doc_pages_count: i64 = db_conn
        .query_row(
            "SELECT count(*) FROM pages WHERE doc_id = ?1",
            rusqlite::params![doc_id],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(doc_pages_count, 0, "Les pages du document doivent être supprimées");
}

#[tokio::test]
async fn test_upload_and_note_creation_into_current_folder() {
    let (state, token, _tmp) = setup_test_app();
    let router = create_api_router(Arc::clone(&state)).with_state(Arc::clone(&state));
    let cookie = format!("docseeker_session={}", token);

    // 1. Créer un dossier "Cardiologie"
    let req_folder = Request::builder()
        .method("POST")
        .uri("/api/folders")
        .header(header::COOKIE, &cookie)
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(serde_json::json!({
            "name": "Cardiologie"
        }).to_string()))
        .unwrap();

    let res_folder = router.clone().oneshot(req_folder).await.unwrap();
    assert_eq!(res_folder.status(), StatusCode::OK);
    let body_f = to_bytes(res_folder.into_body(), usize::MAX).await.unwrap();
    let json_f: serde_json::Value = serde_json::from_slice(&body_f).unwrap();
    let folder_id = json_f["id"].as_i64().unwrap();

    // 2. Upload d'un document PDF dans "Cardiologie" avec target_folder_id
    let boundary = "---------------------------974767299852498929531610575";
    let multipart_body = format!(
        "--{boundary}\r\n\
        Content-Disposition: form-data; name=\"folder_id\"\r\n\r\n\
        {folder_id}\r\n\
        --{boundary}\r\n\
        Content-Disposition: form-data; name=\"title\"\r\n\r\n\
        Guide ECG Clinique\r\n\
        --{boundary}\r\n\
        Content-Disposition: form-data; name=\"file\"; filename=\"ecg_guide.pdf\"\r\n\
        Content-Type: application/pdf\r\n\r\n\
        %PDF-1.4\n%Fake PDF content for test\n%%EOF\r\n\
        --{boundary}--\r\n"
    );

    let req_upload = Request::builder()
        .method("POST")
        .uri("/api/upload?sync=false")
        .header(header::COOKIE, &cookie)
        .header(
            header::CONTENT_TYPE,
            format!("multipart/form-data; boundary={boundary}"),
        )
        .body(Body::from(multipart_body))
        .unwrap();

    let res_upload = router.clone().oneshot(req_upload).await.unwrap();
    assert_eq!(res_upload.status(), StatusCode::OK);
    let body_u = to_bytes(res_upload.into_body(), usize::MAX).await.unwrap();
    let json_u: serde_json::Value = serde_json::from_slice(&body_u).unwrap();
    assert_eq!(json_u["status"], "queued");
    assert_eq!(json_u["filename"], "Cardiologie/ecg_guide.pdf");

    // Vérifier l'enregistrement en BDD et sur le disque physique
    let db_conn = state.db.get().unwrap();
    let (db_folder_id, db_fname): (Option<i64>, String) = db_conn
        .query_row(
            "SELECT folder_id, filename FROM documents WHERE id = ?1",
            rusqlite::params![json_u["doc_id"].as_i64().unwrap()],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap();

    assert_eq!(db_folder_id, Some(folder_id), "Le folder_id doit être celui du dossier courant");
    assert_eq!(db_fname, "Cardiologie/ecg_guide.pdf", "Le filename doit inclure le chemin relatif");

    let physical_file = state.config.documents_dir.join("Cardiologie").join("ecg_guide.pdf");
    assert!(physical_file.is_file(), "Le fichier doit avoir été créé dans documents_dir/Cardiologie/ecg_guide.pdf");

    // 3. Créer une note Markdown dans "Cardiologie"
    let req_note = Request::builder()
        .method("POST")
        .uri("/api/files")
        .header(header::COOKIE, &cookie)
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(serde_json::json!({
            "filename": "Syndrome coronarien.md",
            "content": "# Syndrome coronarien\n\nNotes cliniques.",
            "folder_id": folder_id
        }).to_string()))
        .unwrap();

    let res_note = router.clone().oneshot(req_note).await.unwrap();
    assert_eq!(res_note.status(), StatusCode::CREATED);
    let body_n = to_bytes(res_note.into_body(), usize::MAX).await.unwrap();
    let json_n: serde_json::Value = serde_json::from_slice(&body_n).unwrap();
    let note_doc_id = json_n["doc_id"].as_i64().unwrap();

    // Vérifier l'enregistrement de la note en BDD et sur le disque
    let (note_folder_id, note_fname): (Option<i64>, String) = db_conn
        .query_row(
            "SELECT folder_id, filename FROM documents WHERE id = ?1",
            rusqlite::params![note_doc_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap();

    assert_eq!(note_folder_id, Some(folder_id), "La note doit appartenir au dossier courant");
    assert_eq!(note_fname, "Cardiologie/Syndrome coronarien.md");

    let physical_note_file = state.config.documents_dir
        .join("Cardiologie")
        .join("Syndrome coronarien.md");
    let assets_dir = state.config.documents_dir
        .join("Cardiologie")
        .join(".assets")
        .join("Syndrome coronarien");
    assert!(physical_note_file.is_file(), "La note Markdown doit être créée physiquement comme fichier direct dans le dossier courant");
    assert!(assets_dir.is_dir(), "Le dossier d'assets .assets/ doit être créé dans le dossier courant");
}

#[tokio::test]
async fn test_delete_orphan_document_without_file_on_disk() {
    let (state, token, _tmp) = setup_test_app();
    let router = create_api_router(Arc::clone(&state)).with_state(Arc::clone(&state));
    let cookie = format!("docseeker_session={}", token);

    // 1. Insérer un document fantôme en base dont le fichier n'existe pas du tout sur le disque
    let doc_id = {
        let conn = state.db.get().unwrap();
        conn.execute(
            "INSERT INTO documents (filename, title, file_size, doc_type, status) VALUES ('inexistant.md', 'Fantôme', 28, 'markdown', 'ready')",
            [],
        ).unwrap();
        conn.last_insert_rowid()
    };

    // 2. Tenter de le supprimer via DELETE /api/documents/:id
    let req = Request::builder()
        .method("DELETE")
        .uri(format!("/api/documents/{}", doc_id))
        .header(header::COOKIE, &cookie)
        .body(Body::empty())
        .unwrap();

    let res = router.clone().oneshot(req).await.unwrap();
    // Doit réussir (200 OK) et nettoyer la base au lieu d'échouer en 500
    assert_eq!(res.status(), StatusCode::OK);

    // 3. Vérifier qu'il a bien disparu de la base
    let conn = state.db.get().unwrap();
    let count: i64 = conn.query_row("SELECT COUNT(*) FROM documents WHERE id = ?1", rusqlite::params![doc_id], |r| r.get(0)).unwrap();
    assert_eq!(count, 0, "Le document orphelin doit être supprimé de la base SQLite");
}

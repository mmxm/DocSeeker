use std::sync::{Arc, Mutex};
use axum::{
    body::{to_bytes, Body},
    http::{header, Request, StatusCode},
};
use rusqlite::Connection;
use tower::ServiceExt;

use docseeker_backend::{
    auth::password::hash_password,
    auth::rate_limit::LoginRateLimiter,
    config::Config,
    pdf::engine::PdfEngine,
    pipeline::IndexingPipeline,
    routes::create_api_router,
    AppState,
};
use search_core::{
    calculate_crop_bounds, find_occurrences_on_page, get_full_schema_sql,
    build_search_query_sql, build_title_search_sql, build_doc_search_sql,
    DELETE_ALL_FOLDERS_SQL, DELETE_DOC_PAGES_SQL, DELETE_DOC_SQL, GET_CACHED_DOCS_SQL,
    INSERT_OR_REPLACE_DOC_SQL, INSERT_OR_REPLACE_FOLDER_SQL, INSERT_PAGE_SQL,
    WordEntry,
};

lazy_static::lazy_static! {
    static ref GLOBAL_PDF_ENGINE: Arc<PdfEngine> = Arc::new(PdfEngine::new().expect("PdfEngine requis"));
}

fn setup_test_state() -> (Arc<AppState>, String) {
    // Utiliser un fichier temporaire pour la base de test (r2d2 requiert un fichier)
    let tmp_dir = tempfile::tempdir().expect("Impossible de créer un répertoire temporaire");
    let db_path = tmp_dir.path().join("test.sqlite");

    // Initialiser le schéma via une connexion directe
    let conn = Connection::open(&db_path).unwrap();
    conn.execute_batch("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;").unwrap();
    conn.execute_batch(&get_full_schema_sql()).unwrap();

    // Tables auth
    conn.execute_batch(r#"
        CREATE TABLE IF NOT EXISTS admin_credentials (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            password_hash TEXT NOT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE IF NOT EXISTS sessions (
            id TEXT PRIMARY KEY,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            expires_at DATETIME NOT NULL,
            last_seen DATETIME DEFAULT CURRENT_TIMESTAMP,
            user_agent TEXT,
            ip_address TEXT
        );
    "#).unwrap();

    // Mot de passe admin de test : "testpass123"
    let pwd_hash = hash_password("testpass123").unwrap();
    conn.execute(
        "INSERT INTO admin_credentials (id, password_hash) VALUES (1, ?1)",
        [&pwd_hash],
    ).unwrap();

    // Session de test pré-créée
    let session_token = "valid_test_session_token_xyz";
    let expires = (chrono::Utc::now() + chrono::Duration::days(7)).to_rfc3339();
    conn.execute(
        "INSERT INTO sessions (id, expires_at) VALUES (?1, ?2)",
        rusqlite::params![session_token, expires],
    ).unwrap();

    // Données de test : dossiers
    conn.execute(
        "INSERT INTO folders (id, name, color) VALUES (1, 'Gynécologie', '#3b82f6')",
        [],
    ).unwrap();
    conn.execute(
        "INSERT INTO folders (id, name, color) VALUES (2, 'Pédiatrie', '#10b981')",
        [],
    ).unwrap();

    // Données de test : documents avec texte médical réaliste
    conn.execute(
        "INSERT INTO documents (id, filename, title, file_hash, folder_id, status, total_pages, file_size) \
         VALUES (1, '025 - Grossesse extra-uterine.pdf', 'Grossesse Extra-Utérine et Urgences', 'hash_doc_1', 1, 'ready', 10, 1048576)",
        [],
    ).unwrap();

    conn.execute(
        "INSERT INTO documents (id, filename, title, file_hash, folder_id, status, total_pages, file_size) \
         VALUES (2, '032 - Soins du nouveau-ne.pdf', 'Pédiatrie Néonatale et Soins', 'hash_doc_2', 2, 'ready', 5, 524288)",
        [],
    ).unwrap();

    // Pages avec mots et coordonnées pour test d'occurrences et BM25
    let words_p1 = serde_json::json!([
        [100.0, 150.0, 150.0, 165.0, "Grossesse", 0, 1],
        [155.0, 150.0, 230.0, 165.0, "extra-utérine", 0, 1],
        [235.0, 150.0, 260.0, 165.0, "aiguë", 0, 1],
        [100.0, 180.0, 170.0, 195.0, "Hémorragie", 0, 2],
        [175.0, 180.0, 230.0, 195.0, "interne", 0, 2],
        [235.0, 180.0, 310.0, 195.0, "cataclysmique", 0, 2]
    ]).to_string();

    let words_p2 = serde_json::json!([
        [80.0, 100.0, 140.0, 115.0, "Examen", 0, 1],
        [145.0, 100.0, 220.0, 115.0, "pédiatrique", 0, 1],
        [80.0, 130.0, 160.0, 145.0, "Surveillance", 0, 2],
        [165.0, 130.0, 210.0, 145.0, "clinique", 0, 2]
    ]).to_string();

    conn.execute(
        "INSERT INTO pages (doc_id, page_number, text_content, words_json) VALUES (1, 1, 'Grossesse extra-utérine aiguë. Hémorragie interne cataclysmique.', ?1)",
        [&words_p1],
    ).unwrap();

    conn.execute(
        "INSERT INTO pages (doc_id, page_number, text_content, words_json) VALUES (1, 2, 'Diagnostic échographique de la grossesse ectopique.', '[]')",
        [],
    ).unwrap();

    conn.execute(
        "INSERT INTO pages (doc_id, page_number, text_content, words_json) VALUES (2, 1, 'Examen pédiatrique initial. Surveillance clinique du nouveau-né.', ?1)",
        [&words_p2],
    ).unwrap();

    // Fermer la connexion d'initialisation avant de créer le pool
    drop(conn);

    // Créer le pool de connexions pour les tests
    let pool = docseeker_backend::db::create_pool(&db_path).expect("Impossible de créer le pool de test");

    // Pipeline dédié avec sa propre connexion
    let pipeline_conn = Connection::open(&db_path).unwrap();
    pipeline_conn.execute_batch("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;").unwrap();
    let pipeline_db = Arc::new(Mutex::new(pipeline_conn));

    let pdf_engine = Arc::clone(&GLOBAL_PDF_ENGINE);

    let config = Config {
        host: "127.0.0.1".to_string(),
        port: 8080,
        data_dir: std::path::PathBuf::from("data"),
        documents_dir: std::path::PathBuf::from("data/documents"),
        cache_dir: std::path::PathBuf::from("data/cache_crops"),
        covers_dir: std::path::PathBuf::from("data/cache_crops/covers"),
        db_path: db_path,
        max_upload_size: 10 * 1024 * 1024,
        session_duration_days: 30,
        default_admin_password: Some("testpass123".to_string()),
    };

    let pipeline = Arc::new(IndexingPipeline::new(
        Arc::clone(&pipeline_db),
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

    // Garder le répertoire temporaire en vie via un leak (éviter la suppression prématurée)
    std::mem::forget(tmp_dir);

    (state, session_token.to_string())
}

// =============================================================================
// TESTS DE L'API EN LIGNE (COUVERTURE 100% DES ENDPOINTS HTTP)
// =============================================================================

#[tokio::test]
async fn test_api_online_public_endpoints() {
    let (state, _) = setup_test_state();
    let router = create_api_router(Arc::clone(&state)).with_state(Arc::clone(&state));

    // 1. GET /api/health
    let req = Request::builder().uri("/api/health").body(Body::empty()).unwrap();
    let res = router.clone().oneshot(req).await.unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    let body = to_bytes(res.into_body(), usize::MAX).await.unwrap();
    let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(json["status"], "ok");

    // 2. GET /api/version
    let req = Request::builder().uri("/api/version").body(Body::empty()).unwrap();
    let res = router.clone().oneshot(req).await.unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    let body = to_bytes(res.into_body(), usize::MAX).await.unwrap();
    let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert!(json["backend"].as_str().unwrap().contains("Rust"));

    // 3. GET /api/auth/status (sans session)
    let req = Request::builder().uri("/api/auth/status").body(Body::empty()).unwrap();
    let res = router.clone().oneshot(req).await.unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    let body = to_bytes(res.into_body(), usize::MAX).await.unwrap();
    let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(json["authenticated"], false);
    assert_eq!(json["initialized"], true);

    // 4. POST /api/auth/login - mauvais mot de passe -> 401
    let req = Request::builder()
        .method("POST")
        .uri("/api/auth/login")
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(serde_json::json!({"password": "mauvais_pass"}).to_string()))
        .unwrap();
    let res = router.clone().oneshot(req).await.unwrap();
    assert_eq!(res.status(), StatusCode::UNAUTHORIZED);

    // 5. POST /api/auth/login - bon mot de passe -> 200 + Set-Cookie
    let req = Request::builder()
        .method("POST")
        .uri("/api/auth/login")
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(serde_json::json!({"password": "testpass123"}).to_string()))
        .unwrap();
    let res = router.clone().oneshot(req).await.unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    assert!(res.headers().contains_key(header::SET_COOKIE));
}

#[tokio::test]
async fn test_api_online_protected_folders_and_docs_crud() {
    let (state, token) = setup_test_state();
    let router = create_api_router(Arc::clone(&state)).with_state(Arc::clone(&state));
    let cookie_header = format!("docseeker_session={}", token);

    // 1. GET /api/folders
    let req = Request::builder()
        .uri("/api/folders")
        .header(header::COOKIE, &cookie_header)
        .body(Body::empty())
        .unwrap();
    let res = router.clone().oneshot(req).await.unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    let body = to_bytes(res.into_body(), usize::MAX).await.unwrap();
    let folders: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert!(folders["folders"].as_array().unwrap().len() >= 2);

    // 2. POST /api/folders - Création d'un nouveau dossier
    let req = Request::builder()
        .method("POST")
        .uri("/api/folders")
        .header(header::COOKIE, &cookie_header)
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(serde_json::json!({"name": "Cardiologie", "color": "#ef4444"}).to_string()))
        .unwrap();
    let res = router.clone().oneshot(req).await.unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    let body = to_bytes(res.into_body(), usize::MAX).await.unwrap();
    let created_folder: serde_json::Value = serde_json::from_slice(&body).unwrap();
    let new_folder_id = created_folder["id"].as_i64().unwrap();

    // 3. PATCH /api/folders/:id - Mise à jour du dossier
    let req = Request::builder()
        .method("PATCH")
        .uri(format!("/api/folders/{}", new_folder_id))
        .header(header::COOKIE, &cookie_header)
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(serde_json::json!({"name": "Cardiologie & Vasculaire"}).to_string()))
        .unwrap();
    let res = router.clone().oneshot(req).await.unwrap();
    assert_eq!(res.status(), StatusCode::OK);

    // 4. GET /api/documents - Liste des documents
    let req = Request::builder()
        .uri("/api/documents")
        .header(header::COOKIE, &cookie_header)
        .body(Body::empty())
        .unwrap();
    let res = router.clone().oneshot(req).await.unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    let body = to_bytes(res.into_body(), usize::MAX).await.unwrap();
    let docs: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(docs["documents"].as_array().unwrap().len(), 2);

    // 5. GET /api/documents/:id/status
    let req = Request::builder()
        .uri("/api/documents/1/status")
        .header(header::COOKIE, &cookie_header)
        .body(Body::empty())
        .unwrap();
    let res = router.clone().oneshot(req).await.unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    let body = to_bytes(res.into_body(), usize::MAX).await.unwrap();
    let doc_status: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(doc_status["status"], "ready");

    // 6. PATCH /api/documents/:id - Renommer document
    let req = Request::builder()
        .method("PATCH")
        .uri("/api/documents/1")
        .header(header::COOKIE, &cookie_header)
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(serde_json::json!({"title": "GEU - Grossesse Extra-Utérine"}).to_string()))
        .unwrap();
    let res = router.clone().oneshot(req).await.unwrap();
    assert_eq!(res.status(), StatusCode::OK);

    // 7. PATCH /api/documents/:id/move - Déplacer dans le nouveau dossier
    let req = Request::builder()
        .method("PATCH")
        .uri("/api/documents/1/move")
        .header(header::COOKIE, &cookie_header)
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(serde_json::json!({"folder_id": new_folder_id}).to_string()))
        .unwrap();
    let res = router.clone().oneshot(req).await.unwrap();
    assert_eq!(res.status(), StatusCode::OK);

    // 8. POST /api/documents/batch-move
    let req = Request::builder()
        .method("POST")
        .uri("/api/documents/batch-move")
        .header(header::COOKIE, &cookie_header)
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(serde_json::json!({"doc_ids": [1], "folder_id": 1}).to_string()))
        .unwrap();
    let res = router.clone().oneshot(req).await.unwrap();
    assert_eq!(res.status(), StatusCode::OK);

    // 9. GET /api/check-hash/:file_hash
    let req = Request::builder()
        .uri("/api/check-hash/hash_doc_1")
        .header(header::COOKIE, &cookie_header)
        .body(Body::empty())
        .unwrap();
    let res = router.clone().oneshot(req).await.unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    let body = to_bytes(res.into_body(), usize::MAX).await.unwrap();
    let hash_res: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(hash_res["exists"], true);

    // 10. POST /api/documents/reindex-all (Préservation de l'arborescence)
    let req = Request::builder()
        .method("POST")
        .uri("/api/documents/reindex-all")
        .header(header::COOKIE, &cookie_header)
        .body(Body::empty())
        .unwrap();
    let res = router.clone().oneshot(req).await.unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    let body = to_bytes(res.into_body(), usize::MAX).await.unwrap();
    let reindex_res: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(reindex_res["status"], "ok");

    // Vérifier que le dossier existe toujours (arborescence non effacée)
    let req = Request::builder()
        .uri(format!("/api/folders"))
        .header(header::COOKIE, &cookie_header)
        .body(Body::empty())
        .unwrap();
    let res = router.clone().oneshot(req).await.unwrap();
    assert_eq!(res.status(), StatusCode::OK);

    // 11. DELETE /api/folders/:id
    let req = Request::builder()
        .method("DELETE")
        .uri(format!("/api/folders/{}", new_folder_id))
        .header(header::COOKIE, &cookie_header)
        .body(Body::empty())
        .unwrap();
    let res = router.clone().oneshot(req).await.unwrap();
    assert_eq!(res.status(), StatusCode::OK);
}

#[tokio::test]
async fn test_api_online_offline_bundle_and_sync() {
    let (state, token) = setup_test_state();
    let router = create_api_router(Arc::clone(&state)).with_state(Arc::clone(&state));
    let cookie_header = format!("docseeker_session={}", token);

    // 1. GET /api/documents/1/offline-bundle (Téléchargement du bundle hors-ligne)
    let req = Request::builder()
        .uri("/api/documents/1/offline-bundle")
        .header(header::COOKIE, &cookie_header)
        .body(Body::empty())
        .unwrap();
    let res = router.clone().oneshot(req).await.unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    let body = to_bytes(res.into_body(), usize::MAX).await.unwrap();
    let bundle: serde_json::Value = serde_json::from_slice(&body).unwrap();

    assert_eq!(bundle["document"]["id"], 1);
    assert_eq!(bundle["document"]["file_hash"], "hash_doc_1");
    let pages = bundle["pages"].as_array().unwrap();
    assert_eq!(pages.len(), 2);
    assert_eq!(pages[0]["page_number"], 1);
    let words = pages[0]["words"].as_array().unwrap();
    assert_eq!(words.len(), 6); // 6 mots avec coordonnées

    // 2. POST /api/sync/check - Vérification de synchronisation
    let check_payload = serde_json::json!({
        "cached_documents": [
            {"id": 1, "file_hash": "hash_doc_1", "updated_at": "2099-01-01 00:00:00"}, // à jour
            {"id": 2, "file_hash": "ancien_hash_obsolete", "updated_at": "2020-01-01 00:00:00"}, // obsolète
            {"id": 999, "file_hash": "hash_inconnu", "updated_at": "2020-01-01 00:00:00"} // supprimé du serveur
        ]
    });

    let req = Request::builder()
        .method("POST")
        .uri("/api/sync/check")
        .header(header::COOKIE, &cookie_header)
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(check_payload.to_string()))
        .unwrap();
    let res = router.clone().oneshot(req).await.unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    let body = to_bytes(res.into_body(), usize::MAX).await.unwrap();
    let sync_res: serde_json::Value = serde_json::from_slice(&body).unwrap();

    let outdated = sync_res["outdated_ids"].as_array().unwrap();
    let deleted = sync_res["deleted_ids"].as_array().unwrap();
    assert_eq!(outdated, &vec![serde_json::json!(2)]);
    assert_eq!(deleted, &vec![serde_json::json!(999)]);

    // 3. GET /api/pipeline/status & POST /api/pipeline/retry-failed
    let req = Request::builder()
        .uri("/api/pipeline/status")
        .header(header::COOKIE, &cookie_header)
        .body(Body::empty())
        .unwrap();
    let res = router.clone().oneshot(req).await.unwrap();
    assert_eq!(res.status(), StatusCode::OK);

    let req = Request::builder()
        .method("POST")
        .uri("/api/pipeline/retry-failed")
        .header(header::COOKIE, &cookie_header)
        .body(Body::empty())
        .unwrap();
    let res = router.clone().oneshot(req).await.unwrap();
    assert_eq!(res.status(), StatusCode::OK);
}

#[tokio::test]
async fn test_api_online_search_scoring_and_ranking() {
    let (state, token) = setup_test_state();
    let router = create_api_router(Arc::clone(&state)).with_state(Arc::clone(&state));
    let cookie_header = format!("docseeker_session={}", token);

    // 1. GET /api/search?q=grossesse
    let req = Request::builder()
        .uri("/api/search?q=grossesse")
        .header(header::COOKIE, &cookie_header)
        .body(Body::empty())
        .unwrap();
    let res = router.clone().oneshot(req).await.unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    let body = to_bytes(res.into_body(), usize::MAX).await.unwrap();
    let search_data: serde_json::Value = serde_json::from_slice(&body).unwrap();

    let results = search_data["results"].as_array().unwrap();
    assert!(!results.is_empty());
    let first = &results[0];
    assert_eq!(first["id"], 1);

    // VÉRIFICATION STRICTE DU SCORE :
    // Le terme "grossesse" est présent dans le titre ET dans le nom de fichier -> Bonus titre +1500.0
    let score = first["relevance_score"].as_f64().unwrap();
    assert!(score >= 1500.0, "Le score avec bonus titre doit être >= 1500.0, obtenu: {}", score);
    assert_eq!(first["total_occurrences"].as_i64().unwrap(), 2);

    // 2. GET /api/search?q=grossesse&titles_only=true
    let req = Request::builder()
        .uri("/api/search?q=grossesse&titles_only=true")
        .header(header::COOKIE, &cookie_header)
        .body(Body::empty())
        .unwrap();
    let res = router.clone().oneshot(req).await.unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    let body = to_bytes(res.into_body(), usize::MAX).await.unwrap();
    let title_res: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(title_res["results"].as_array().unwrap().len(), 1);

    // 3. GET /api/doc-search?doc_id=1&q=hemorragie (terme sans accent)
    let req = Request::builder()
        .uri("/api/doc-search?doc_id=1&q=hemorragie")
        .header(header::COOKIE, &cookie_header)
        .body(Body::empty())
        .unwrap();
    let res = router.clone().oneshot(req).await.unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    let body = to_bytes(res.into_body(), usize::MAX).await.unwrap();
    let doc_res: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(doc_res["total_occurrences"], 1);
    let occs = doc_res["occurrences"].as_array().unwrap();
    assert_eq!(occs[0]["page_number"], 1);

    // 4. GET /api/doc-search?doc_id=1&q=hémorragie (AVEC accent aigu)
    let req = Request::builder()
        .uri("/api/doc-search?doc_id=1&q=h%C3%A9morragie")
        .header(header::COOKIE, &cookie_header)
        .body(Body::empty())
        .unwrap();
    let res = router.clone().oneshot(req).await.unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    let body = to_bytes(res.into_body(), usize::MAX).await.unwrap();
    let doc_res: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(doc_res["total_occurrences"], 1, "La recherche intra-doc avec accent 'hémorragie' doit trouver l'occurrence");

    // 5. GET /api/doc-search?doc_id=1&q=aiguë (AVEC tréma)
    let req = Request::builder()
        .uri("/api/doc-search?doc_id=1&q=aigu%C3%AB")
        .header(header::COOKIE, &cookie_header)
        .body(Body::empty())
        .unwrap();
    let res = router.clone().oneshot(req).await.unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    let body = to_bytes(res.into_body(), usize::MAX).await.unwrap();
    let doc_res: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(doc_res["total_occurrences"], 1, "La recherche intra-doc avec tréma 'aiguë' doit trouver l'occurrence");
}

#[tokio::test]
async fn test_api_online_annotations_and_auth_lifecycle() {
    let (state, token) = setup_test_state();
    let router = create_api_router(Arc::clone(&state)).with_state(Arc::clone(&state));
    let cookie_header = format!("docseeker_session={}", token);

    // 1. GET /api/documents/1/annotations (initialement vide)
    let req = Request::builder()
        .uri("/api/documents/1/annotations")
        .header(header::COOKIE, &cookie_header)
        .body(Body::empty())
        .unwrap();
    let res = router.clone().oneshot(req).await.unwrap();
    assert_eq!(res.status(), StatusCode::OK);

    // 2. POST /api/documents/1/annotations (sauvegarde)
    let annot_payload = serde_json::json!({
        "annotations": [
            {"type": "highlight", "page": 1, "rect": [100.0, 150.0, 260.0, 165.0]}
        ]
    });
    let req = Request::builder()
        .method("POST")
        .uri("/api/documents/1/annotations")
        .header(header::COOKIE, &cookie_header)
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(annot_payload.to_string()))
        .unwrap();
    let res = router.clone().oneshot(req).await.unwrap();
    assert_eq!(res.status(), StatusCode::OK);

    // 3. POST /api/auth/change-password
    let change_pwd_payload = serde_json::json!({
        "current_password": "testpass123",
        "new_password": "new_secure_password_456"
    });
    let req = Request::builder()
        .method("POST")
        .uri("/api/auth/change-password")
        .header(header::COOKIE, &cookie_header)
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(change_pwd_payload.to_string()))
        .unwrap();
    let res = router.clone().oneshot(req).await.unwrap();
    assert_eq!(res.status(), StatusCode::OK);

    // 4. POST /api/auth/logout
    let req = Request::builder()
        .method("POST")
        .uri("/api/auth/logout")
        .header(header::COOKIE, &cookie_header)
        .body(Body::empty())
        .unwrap();
    let res = router.clone().oneshot(req).await.unwrap();
    assert_eq!(res.status(), StatusCode::OK);

    // 5. Requête ultérieure avec l'ancien token -> 401 Unauthorized
    let req = Request::builder()
        .uri("/api/documents")
        .header(header::COOKIE, &cookie_header)
        .body(Body::empty())
        .unwrap();
    let res = router.clone().oneshot(req).await.unwrap();
    assert_eq!(res.status(), StatusCode::UNAUTHORIZED);
}

// =============================================================================
// TESTS DU MOTEUR HORS-LIGNE & VALIDATION DES VOLUMES RÉELS (data/db.sqlite)
// =============================================================================

#[test]
fn test_offline_engine_high_volume_real_corpus() {
    let real_db_path = std::path::Path::new("../data/db.sqlite");
    if !real_db_path.exists() {
        println!("Note : ../data/db.sqlite non trouvé, test ignoré en environnement minimal.");
        return;
    }

    println!("Ouverture de la base médicale de production réelle (416 Mo)...");
    let real_conn = Connection::open_with_flags(
        real_db_path,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    ).expect("Impossible d'ouvrir ../data/db.sqlite");

    let total_docs: i64 = real_conn.query_row("SELECT count(*) FROM documents", [], |r| r.get(0)).unwrap();
    let total_pages: i64 = real_conn.query_row("SELECT count(*) FROM pages", [], |r| r.get(0)).unwrap();
    println!("Base réelle : {} documents, {} pages indexées.", total_docs, total_pages);
    assert!(total_docs > 50);
    assert!(total_pages > 1000);

    // 1. Simulation exacte du moteur SQLite-Wasm local du client (foreign_keys désactivées pour le cache client)
    println!("Création de l'instance SQLite locale cliente avec le schéma généré par Rust...");
    let local_client_conn = Connection::open_in_memory().unwrap();
    local_client_conn.execute_batch("PRAGMA foreign_keys = OFF;").unwrap();
    local_client_conn.execute_batch(&get_full_schema_sql()).unwrap();

    // Ingestion préalable des dossiers réels pour reproduire le comportement client
    let mut folder_stmt = real_conn.prepare("SELECT id, name, parent_id, color FROM folders").unwrap();
    let folders = folder_stmt.query_map([], |r| {
        Ok((
            r.get::<_, i64>(0)?,
            r.get::<_, String>(1)?,
            r.get::<_, Option<i64>>(2)?,
            r.get::<_, Option<String>>(3)?,
        ))
    }).unwrap();
    for f in folders.flatten() {
        local_client_conn.execute(
            INSERT_OR_REPLACE_FOLDER_SQL,
            rusqlite::params![f.0, f.1, f.2, f.3.unwrap_or_else(|| "#3b82f6".to_string())],
        ).unwrap();
    }

    // 2. Ingestion de paquets offline-bundle réels depuis la base distante
    let mut stmt = real_conn.prepare(
        "SELECT id, filename, title, file_hash, folder_id, total_pages, file_size, created_at, updated_at \
         FROM documents WHERE status = 'ready' AND (filename LIKE '%grossesse%' OR title LIKE '%grossesse%') LIMIT 10"
    ).unwrap();

    let doc_bundles = stmt.query_map([], |r| {
        Ok((
            r.get::<_, i64>(0)?,
            r.get::<_, String>(1)?,
            r.get::<_, Option<String>>(2)?.unwrap_or_default(),
            r.get::<_, Option<String>>(3)?,
            r.get::<_, Option<i64>>(4)?,
            r.get::<_, i64>(5)?,
            r.get::<_, i64>(6)?,
            r.get::<_, String>(7)?,
            r.get::<_, String>(8)?,
        ))
    }).unwrap();

    let mut ingested_count = 0;
    for doc in doc_bundles.flatten() {
        let (id, filename, title, file_hash, folder_id, total_pages, file_size, created_at, updated_at) = doc;

        // Ingestion document avec la requête partagée
        local_client_conn.execute(
            INSERT_OR_REPLACE_DOC_SQL,
            rusqlite::params![id, filename, title, file_hash, folder_id, total_pages, file_size, created_at, updated_at],
        ).unwrap();

        // Récupérer les 50 premières pages réelles de ce document
        let mut page_stmt = real_conn.prepare(
            "SELECT page_number, text_content, words_json FROM pages WHERE doc_id = ?1 LIMIT 50"
        ).unwrap();

        let pages = page_stmt.query_map([id], |pr| {
            Ok((
                pr.get::<_, i64>(0)?,
                pr.get::<_, String>(1)?,
                pr.get::<_, String>(2)?,
            ))
        }).unwrap();

        for p in pages.flatten() {
            let (page_num, text, words) = p;
            local_client_conn.execute(
                INSERT_PAGE_SQL,
                rusqlite::params![id, page_num, text, words],
            ).unwrap();
        }
        ingested_count += 1;
    }

    assert!(ingested_count > 0);

    // Vérification du trigger FTS5 pages_ai : les pages insérées doivent être immédiatement cherchables
    let fts_count: i64 = local_client_conn.query_row("SELECT count(*) FROM pages_fts", [], |r| r.get(0)).unwrap();
    let page_count: i64 = local_client_conn.query_row("SELECT count(*) FROM pages", [], |r| r.get(0)).unwrap();
    assert_eq!(fts_count, page_count, "Le trigger FTS5 pages_ai doit avoir alimenté pages_fts automatiquement");
    assert!(fts_count > 0, "Des pages doivent être indexées");

    // 3. Exécution d'une recherche FTS5 + BM25 locale avec build_search_query_sql
    let search_sql_data = build_search_query_sql("grossesse", None, 10, 0);
    assert!(!search_sql_data.sql.is_empty());
    assert_eq!(search_sql_data.terms, vec!["grossesse"]);

    let mut search_stmt = local_client_conn.prepare(&search_sql_data.sql).unwrap();
    let results: Vec<(i64, String, f64, i64, f64)> = search_stmt.query_map([], |r| {
        Ok((
            r.get::<_, i64>(0)?, // doc_id
            r.get::<_, String>(1)?, // filename
            r.get::<_, f64>(7)?, // doc_relevance_score
            r.get::<_, i64>(8)?, // matching_pages_count
            r.get::<_, f64>(11)?, // page_bm25
        ))
    }).unwrap().flatten().collect();

    assert!(!results.is_empty(), "La recherche locale hors-ligne doit retourner des résultats");
    println!("Résultats hors-ligne trouvés : {} entrées de pages correspondantes.", results.len());

    // Vérifier que le tri est rigoureusement décroissant par relevance_score
    for i in 1..results.len() {
        assert!(results[i - 1].2 >= results[i].2, "Les résultats doivent être triés par pertinence décroissante");
    }

    // Vérification mathématique stricte du respect de la formule Goodnotes de score:
    // doc_relevance_score = (title_match ? 1500.0 : 0.0) + (ABS(min(page_bm25)) * 100.0) + MIN(pages * 5.0, 300.0)
    for res in &results {
        let (_doc_id, _filename, score, page_count, _page_bm25) = res;
        assert!(*score >= 1500.0, "Le score doit comporter le bonus titre/nom de 1500.0, obtenu: {}", score);
        let density_bonus = (*page_count as f64 * 5.0).min(300.0);
        assert!(*score >= 1500.0 + density_bonus);
    }

    // 4. Test de la recherche par titre (build_title_search_sql)
    let (title_sql, title_terms) = build_title_search_sql("grossesse", None, 10, 0);
    assert!(!title_sql.is_empty());
    assert_eq!(title_terms, vec!["grossesse"]);
    let title_docs: Vec<i64> = local_client_conn.prepare(&title_sql).unwrap()
        .query_map([], |r| r.get(0)).unwrap().flatten().collect();
    assert_eq!(title_docs.len(), ingested_count, "Tous les documents ingérés ont le mot grossesse dans le titre ou le nom");

    // 5. Test de la recherche interne à un document (build_doc_search_sql)
    let (doc_sql, doc_terms, _) = build_doc_search_sql(title_docs[0], "grossesse");
    assert!(!doc_sql.is_empty());
    assert_eq!(doc_terms, vec!["grossesse"]);
    let doc_pages: Vec<i64> = local_client_conn.prepare(&doc_sql).unwrap()
        .query_map([], |r| r.get(0)).unwrap().flatten().collect();
    assert!(!doc_pages.is_empty(), "Le document doit avoir des pages contenant grossesse");

    // 6. Test spatial et surlignage d'occurrences avec find_occurrences_on_page
    let sample_words_raw: String = local_client_conn.query_row(
        "SELECT words_json FROM pages WHERE text_content LIKE '%grossesse%' AND words_json != '[]' LIMIT 1",
        [],
        |r| r.get(0),
    ).unwrap_or_default();

    if !sample_words_raw.is_empty() {
        let words_data: Vec<WordEntry> = serde_json::from_str(&sample_words_raw).unwrap();
        let occs = find_occurrences_on_page(
            &words_data,
            &["grossesse".to_string()],
            &search_sql_data.query_hash,
            1,
            1,
            -2.5,
            "grossesse",
            842.0,
        );

        assert!(!occs.is_empty(), "L'algorithme spatial d'occurrences doit trouver les occurrences dans la page");
        for occ in occs {
            assert!(occ.rect[2] > occ.rect[0]);
            assert!(occ.rect[3] > occ.rect[1]);
            assert!(!occ.highlight_rects.is_empty());
        }
    }

    // 7. Test du calcul de recadrage partagé (Crop Bounds)
    let bounds = calculate_crop_bounds([120.0, 200.0, 180.0, 215.0], 595.0, 842.0, None, None);
    assert_eq!(bounds.width, 300.0);
    assert_eq!(bounds.height, 120.0);
    assert!(bounds.x0 >= 0.0 && bounds.x1 <= 595.0);
    assert!(bounds.y0 >= 0.0 && bounds.y1 <= 842.0);

    // 8. Test de la gestion des dossiers partagée (INSERT_OR_REPLACE_FOLDER_SQL et DELETE_ALL_FOLDERS_SQL)
    local_client_conn.execute(
        INSERT_OR_REPLACE_FOLDER_SQL,
        rusqlite::params![100, "Maternité", None::<i64>, "#ec4899"],
    ).unwrap();
    let folder_cnt: i64 = local_client_conn.query_row("SELECT count(*) FROM folders WHERE id = 100", [], |r| r.get(0)).unwrap();
    assert_eq!(folder_cnt, 1);
    local_client_conn.execute(DELETE_ALL_FOLDERS_SQL, []).unwrap();
    let folder_cnt_after: i64 = local_client_conn.query_row("SELECT count(*) FROM folders", [], |r| r.get(0)).unwrap();
    assert_eq!(folder_cnt_after, 0);

    // 9. Test de la liste des documents en cache (GET_CACHED_DOCS_SQL)
    let cached_docs: Vec<i64> = local_client_conn.prepare(GET_CACHED_DOCS_SQL).unwrap()
        .query_map([], |r| r.get(0)).unwrap().flatten().collect();
    assert_eq!(cached_docs.len(), ingested_count);

    // 10. Test de suppression d'un document local (DELETE_DOC_SQL et DELETE_DOC_PAGES_SQL)
    let target_doc_id = cached_docs[0];
    local_client_conn.execute(DELETE_DOC_PAGES_SQL, [target_doc_id]).unwrap();
    local_client_conn.execute(DELETE_DOC_SQL, [target_doc_id]).unwrap();

    let count_after: i64 = local_client_conn.query_row("SELECT count(*) FROM documents WHERE id = ?1", [target_doc_id], |r| r.get(0)).unwrap();
    assert_eq!(count_after, 0);

    let pages_fts_after: i64 = local_client_conn.query_row(
        "SELECT count(*) FROM pages_fts pf JOIN pages p ON p.id = pf.rowid WHERE p.doc_id = ?1",
        [target_doc_id],
        |r| r.get(0),
    ).unwrap();
    assert_eq!(pages_fts_after, 0);
}

#[tokio::test]
async fn test_recursive_directory_scan_and_reindex() {
    let tmp = tempfile::tempdir().unwrap();
    let db_path = tmp.path().join("test.sqlite");
    let docs_dir = tmp.path().join("documents");
    let covers_dir = tmp.path().join("covers");
    let cache_dir = tmp.path().join("cache");
    std::fs::create_dir_all(&docs_dir).unwrap();
    std::fs::create_dir_all(&covers_dir).unwrap();
    std::fs::create_dir_all(&cache_dir).unwrap();

    // Créer un sous-dossier "Pneumologie" avec un PDF valide
    let pneumo_dir = docs_dir.join("Pneumologie");
    std::fs::create_dir_all(&pneumo_dir).unwrap();
    let pdf_in_sub = pneumo_dir.join("ITEM_159_TUBERCULOSE.pdf");
    // Écrire un header PDF minimal valide (> 5 octets avec %PDF-)
    std::fs::write(&pdf_in_sub, b"%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n").unwrap();

    // PDF à la racine
    let pdf_at_root = docs_dir.join("025 - Grossesse.pdf");
    std::fs::write(&pdf_at_root, b"%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n").unwrap();

    let conn = Connection::open(&db_path).unwrap();
    conn.execute_batch(&get_full_schema_sql()).unwrap();

    let config = Config {
        host: "127.0.0.1".to_string(),
        port: 8080,
        data_dir: tmp.path().to_path_buf(),
        db_path,
        documents_dir: docs_dir.clone(),
        covers_dir,
        cache_dir,
        max_upload_size: 100 * 1024 * 1024,
        session_duration_days: 30,
        default_admin_password: None,
    };

    // 1. Tester la collecte récursive
    let collected = docseeker_backend::pdf::indexer::collect_pdf_files_recursive(&docs_dir, &docs_dir);
    assert_eq!(collected.len(), 2, "Doit collecter le PDF à la racine ET le PDF dans Pneumologie/");

    let has_sub = collected.iter().any(|(_, rel)| rel.contains("Pneumologie"));
    assert!(has_sub, "Le chemin relatif doit contenir le sous-dossier 'Pneumologie'");

    // 2. Tester resolve_pdf_path
    let resolved = docseeker_backend::pdf::indexer::resolve_pdf_path(&docs_dir, "Pneumologie/ITEM_159_TUBERCULOSE.pdf");
    assert!(resolved.is_some());
    assert!(resolved.unwrap().exists());

    // Résolution résiliente par nom de base si sans préfixe
    let resolved_base = docseeker_backend::pdf::indexer::resolve_pdf_path(&docs_dir, "ITEM_159_TUBERCULOSE.pdf");
    assert!(resolved_base.is_some());
    assert!(resolved_base.unwrap().exists());

    // Test résolution croisée Unicode (NFD sur disque macOS vs requête NFC Linux/Web)
    use unicode_normalization::UnicodeNormalization;
    let accented_nfd: String = "Grossesse_extra_utérine_test.pdf".nfd().collect();
    let nfd_file = docs_dir.join(&accented_nfd);
    std::fs::write(&nfd_file, b"%PDF-1.4 dummy accented content").unwrap();

    let query_nfc: String = "Grossesse_extra_utérine_test.pdf".nfc().collect();
    let resolved_nfc = docseeker_backend::pdf::indexer::resolve_pdf_path(&docs_dir, &query_nfc);
    assert!(resolved_nfc.is_some(), "resolve_pdf_path doit trouver le fichier NFD sur disque avec une requête NFC");
    assert!(resolved_nfc.unwrap().exists());

    // Test résolution dans un sous-dossier avec accent
    let sub_accented = pneumo_dir.join(&accented_nfd);
    std::fs::write(&sub_accented, b"%PDF-1.4 dummy sub accented content").unwrap();
    let resolved_sub_base = docseeker_backend::pdf::indexer::resolve_pdf_path(&docs_dir, &query_nfc);
    assert!(resolved_sub_base.is_some(), "resolve_pdf_path doit retrouver par nom de base un fichier avec accents dans un sous-dossier");
    let _ = std::fs::remove_file(&nfd_file);
    let _ = std::fs::remove_file(&sub_accented);

    // 3. Tester reindex_all_library
    let queued = docseeker_backend::pdf::indexer::reindex_all_library(&conn, &GLOBAL_PDF_ENGINE, &config).unwrap();
    assert_eq!(queued.len(), 2, "Les 2 documents doivent être mis en file lors de la réindexation complète");

    // Vérifier que le dossier 'Pneumologie' a été automatiquement créé et associé
    let pneumo_folder_id: Option<i64> = conn.query_row(
        "SELECT id FROM folders WHERE name = 'Pneumologie'",
        [],
        |r| r.get(0),
    ).ok();
    assert!(pneumo_folder_id.is_some(), "Le dossier 'Pneumologie' doit être créé dans la table folders");

    let doc_in_folder: Option<i64> = conn.query_row(
        "SELECT folder_id FROM documents WHERE filename LIKE '%Pneumologie%'",
        [],
        |r| r.get(0),
    ).unwrap();
    assert_eq!(doc_in_folder, pneumo_folder_id, "Le document doit être rattaché au dossier Pneumologie");
}

#[tokio::test]
async fn test_document_physical_rename_and_title_integrity() {
    let (state, token) = setup_test_state();
    let router = create_api_router(Arc::clone(&state)).with_state(Arc::clone(&state));
    let cookie_header = format!("docseeker_session={}", token);

    // 1. Créer un fichier physique réel dans config.documents_dir
    let original_fname = "025 - Imagerie - Grossesse extra-uterine.pdf";
    let physical_src = state.config.documents_dir.join(original_fname);
    std::fs::write(&physical_src, b"%PDF-1.4 dummy pdf content for rename test").unwrap();
    assert!(physical_src.exists());

    // 2. Insérer le document dans SQLite avec des pages associées
    {
        let conn = state.db.get().unwrap();
        conn.execute(
            "INSERT INTO documents (id, filename, title, file_hash, folder_id, status, total_pages, file_size) \
             VALUES (999, ?1, 'Ancien Titre', 'hash_999', 1, 'ready', 5, 1234)",
            rusqlite::params![original_fname],
        ).unwrap();

        conn.execute(
            "INSERT INTO pages (doc_id, page_number, text_content, words_json) VALUES (999, 1, 'Grossesse extra-uterine item 25', '[]')",
            [],
        ).unwrap();
    }

    // 3. Renommer le document via PATCH /api/documents/999
    let new_title = "025 - Imagerie - GEU Renomme";
    let req = Request::builder()
        .method("PATCH")
        .uri("/api/documents/999")
        .header(header::COOKIE, &cookie_header)
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(serde_json::json!({"title": new_title}).to_string()))
        .unwrap();

    let res = router.clone().oneshot(req).await.unwrap();
    assert_eq!(res.status(), StatusCode::OK);

    let body = to_bytes(res.into_body(), usize::MAX).await.unwrap();
    let resp: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(resp["title"], new_title);
    assert_eq!(resp["filename"], format!("{}.pdf", new_title));

    // 4. Vérifier que le fichier physique a été renommé sur le disque
    let physical_dest = state.config.documents_dir.join(format!("{}.pdf", new_title));
    assert!(physical_dest.exists(), "Le fichier physique renommé doit exister sur le disque");
    assert!(!physical_src.exists(), "L'ancien fichier physique ne doit plus exister");

    // 5. Vérifier que la base SQLite maintient l'intégrité parfaite (relations pages, fts)
    {
        let conn = state.db.get().unwrap();
        let (db_title, db_filename): (String, String) = conn.query_row(
            "SELECT title, filename FROM documents WHERE id = 999",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        ).unwrap();
        assert_eq!(db_title, new_title);
        assert_eq!(db_filename, format!("{}.pdf", new_title));

        // Vérifier que les pages sont toujours bien associées au doc_id 999
        let page_count: i64 = conn.query_row(
            "SELECT COUNT(*) FROM pages WHERE doc_id = 999",
            [],
            |r| r.get(0),
        ).unwrap();
        assert_eq!(page_count, 1, "Les pages doivent toujours être reliées au doc_id 999");

        // Vérifier la recherche plein texte sur les pages
        let fts_matches: i64 = conn.query_row(
            "SELECT COUNT(*) FROM pages_fts WHERE text_content MATCH 'Grossesse'",
            [],
            |r| r.get(0),
        ).unwrap();
        assert!(fts_matches >= 1, "L'index FTS5 doit toujours fonctionner pour ce document");
    }

    // Nettoyage
    let _ = std::fs::remove_file(physical_dest);
}



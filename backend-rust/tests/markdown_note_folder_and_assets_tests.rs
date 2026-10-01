use axum::{
    body::{to_bytes, Body},
    http::{header, Request, StatusCode},
};
use rusqlite::Connection;
use std::sync::{Arc, Mutex};
use tower::ServiceExt;

use docseeker_backend::auth::rate_limit::LoginRateLimiter;
use docseeker_backend::config::Config;
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
    let session_token = "valid_session_token_note_folder_test";
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
async fn test_note_folder_structure_and_orphan_assets_cleanup() {
    let (state, token, _tmp) = setup_test_app();
    let router = create_api_router(Arc::clone(&state)).with_state(Arc::clone(&state));
    let cookie = format!("docseeker_session={}", token);

    // 1. Créer une nouvelle note via POST /api/files
    let req = Request::builder()
        .method("POST")
        .uri("/api/files")
        .header(header::COOKIE, &cookie)
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(serde_json::json!({
            "filename": "Neurologie Clinique.md",
            "content": "# Neurologie Clinique\n\nExamen des paires crâniennes."
        }).to_string()))
        .unwrap();

    let res = router.clone().oneshot(req).await.unwrap();
    assert_eq!(res.status(), StatusCode::CREATED);
    let body = to_bytes(res.into_body(), usize::MAX).await.unwrap();
    let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
    let doc_id = json["doc_id"].as_i64().unwrap();

    // 2. Vérification physique : un dossier "Neurologie Clinique/" contenant :
    // - "Neurologie Clinique.md"
    // - "assets/"
    let note_dir = state.config.documents_dir.join("Neurologie Clinique");
    let md_file = note_dir.join("Neurologie Clinique.md");
    let assets_dir = note_dir.join("assets");

    assert!(note_dir.is_dir(), "La note doit être un dossier sur le volume");
    assert!(md_file.is_file(), "Le dossier doit contenir le fichier markdown");
    assert!(assets_dir.is_dir(), "Le dossier doit contenir le sous-dossier assets/");

    // 3. Vérification UI : la liste des dossiers /api/folders NE DOIT PAS contenir "Neurologie Clinique"
    let req_folders = Request::builder()
        .uri("/api/folders")
        .header(header::COOKIE, &cookie)
        .body(Body::empty())
        .unwrap();
    let res_folders = router.clone().oneshot(req_folders).await.unwrap();
    assert_eq!(res_folders.status(), StatusCode::OK);
    let body_f = to_bytes(res_folders.into_body(), usize::MAX).await.unwrap();
    let json_f: serde_json::Value = serde_json::from_slice(&body_f).unwrap();
    let folders = json_f["folders"].as_array().unwrap();
    assert!(
        !folders.iter().any(|f| f["name"] == "Neurologie Clinique"),
        "Le dossier de la note ne doit pas apparaître dans les dossiers UI"
    );

    // 4. Ajouter deux assets physiques dans assets/
    // Asset 1 : cerveau.png (sera référencé dans le markdown)
    // Asset 2 : orphelin.png (non référencé)
    std::fs::write(assets_dir.join("cerveau.png"), b"PNG_CERVEAU").unwrap();
    std::fs::write(assets_dir.join("orphelin.png"), b"PNG_ORPHELIN").unwrap();
    assert!(assets_dir.join("cerveau.png").exists());
    assert!(assets_dir.join("orphelin.png").exists());

    // 5. Sauvegarder la note avec SEULEMENT cerveau.png référencé
    // Le serveur doit physiquement supprimer orphelin.png
    let updated_md = "# Neurologie Clinique\n\nVoici le schéma du cerveau :\n\n![Cerveau](assets/cerveau.png)";
    let req_put = Request::builder()
        .method("PUT")
        .uri("/api/files/Neurologie%20Clinique.md")
        .header(header::COOKIE, &cookie)
        .header(header::CONTENT_TYPE, "text/markdown")
        .body(Body::from(updated_md))
        .unwrap();

    let res_put = router.clone().oneshot(req_put).await.unwrap();
    assert_eq!(res_put.status(), StatusCode::OK);

    // Vérifier que cerveau.png est conservé et orphelin.png est physiquement supprimé du serveur
    assert!(assets_dir.join("cerveau.png").exists(), "cerveau.png est référencé, il doit être conservé");
    assert!(!assets_dir.join("orphelin.png").exists(), "orphelin.png doit avoir été supprimé physiquement du serveur");

    // 6. Si l'utilisateur supprime cerveau.png du markdown et sauvegarde
    let no_images_md = "# Neurologie Clinique\n\nTexte sans aucune image.";
    let req_put2 = Request::builder()
        .method("PUT")
        .uri("/api/files/Neurologie%20Clinique.md")
        .header(header::COOKIE, &cookie)
        .header(header::CONTENT_TYPE, "text/markdown")
        .body(Body::from(no_images_md))
        .unwrap();

    let res_put2 = router.clone().oneshot(req_put2).await.unwrap();
    assert_eq!(res_put2.status(), StatusCode::OK);

    assert!(!assets_dir.join("cerveau.png").exists(), "cerveau.png n'est plus référencé, il doit être supprimé physiquement");

    // 7. Renommage physique de la note :
    // Remettre un asset pour vérifier qu'il suit le renommage
    std::fs::write(assets_dir.join("moelle.png"), b"PNG_MOELLE").unwrap();

    let req_patch = Request::builder()
        .method("PATCH")
        .uri(format!("/api/documents/{}", doc_id))
        .header(header::COOKIE, &cookie)
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(serde_json::json!({
            "title": "Neuroanatomie"
        }).to_string()))
        .unwrap();

    let res_patch = router.clone().oneshot(req_patch).await.unwrap();
    assert_eq!(res_patch.status(), StatusCode::OK);

    // Vérifier que le dossier ET le fichier markdown ont été renommés physiquement
    let new_note_dir = state.config.documents_dir.join("Neuroanatomie");
    let new_md_file = new_note_dir.join("Neuroanatomie.md");
    let new_asset = new_note_dir.join("assets").join("moelle.png");

    assert!(new_note_dir.is_dir(), "Le dossier physique de la note doit être renommé");
    assert!(new_md_file.is_file(), "Le fichier markdown doit être renommé dans le nouveau dossier");
    assert!(new_asset.is_file(), "Les assets doivent avoir suivi dans le dossier de note renommé");
    assert!(!note_dir.exists(), "L'ancien dossier de note ne doit plus exister");

    // 8. Déplacement dans l'arborescence : Créer un dossier utilisateur "Médecine" et déplacer la note dedans
    let req_create_folder = Request::builder()
        .method("POST")
        .uri("/api/folders")
        .header(header::COOKIE, &cookie)
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(serde_json::json!({
            "name": "Médecine"
        }).to_string()))
        .unwrap();

    let res_cf = router.clone().oneshot(req_create_folder).await.unwrap();
    assert_eq!(res_cf.status(), StatusCode::OK);
    let body_cf = to_bytes(res_cf.into_body(), usize::MAX).await.unwrap();
    let json_cf: serde_json::Value = serde_json::from_slice(&body_cf).unwrap();
    let folder_id = json_cf["id"].as_i64().unwrap();

    // Déplacer la note dans "Médecine"
    let req_move = Request::builder()
        .method("PATCH")
        .uri(format!("/api/documents/{}/move", doc_id))
        .header(header::COOKIE, &cookie)
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(serde_json::json!({
            "folder_id": folder_id
        }).to_string()))
        .unwrap();

    let res_move = router.clone().oneshot(req_move).await.unwrap();
    assert_eq!(res_move.status(), StatusCode::OK);

    // Vérifier que tout le dossier de note a été déplacé dans Médecine/
    let moved_note_dir = state.config.documents_dir.join("Médecine").join("Neuroanatomie");
    let moved_md_file = moved_note_dir.join("Neuroanatomie.md");
    let moved_asset = moved_note_dir.join("assets").join("moelle.png");

    assert!(moved_note_dir.is_dir(), "Le dossier de note entier doit avoir été déplacé dans Médecine/");
    assert!(moved_md_file.is_file(), "Le fichier markdown doit être présent dans le dossier déplacé");
    assert!(moved_asset.is_file(), "Les assets doivent avoir été déplacés avec le dossier");
    assert!(!new_note_dir.exists(), "L'ancien emplacement à la racine ne doit plus exister");

    // 9. Suppression et mise à la corbeille (Soft-Delete)
    let req_del = Request::builder()
        .method("DELETE")
        .uri(format!("/api/documents/{}", doc_id))
        .header(header::COOKIE, &cookie)
        .body(Body::empty())
        .unwrap();

    let res_del = router.clone().oneshot(req_del).await.unwrap();
    assert_eq!(res_del.status(), StatusCode::OK);

    assert!(!moved_note_dir.exists(), "Le dossier de note doit avoir disparu de documents/");
    assert!(state.config.trash_dir.join("del_Médecine__Neuroanatomie.md").exists());
    assert!(state.config.trash_dir.join("del_Médecine__Neuroanatomie.md.meta.json").exists());

    // 10. Restauration depuis la corbeille
    let req_restore = Request::builder()
        .method("POST")
        .uri("/api/trash/restore")
        .header(header::COOKIE, &cookie)
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(serde_json::json!({
            "filename": "Médecine/Neuroanatomie.md"
        }).to_string()))
        .unwrap();
    let res_restore = router.clone().oneshot(req_restore).await.unwrap();
    assert_eq!(res_restore.status(), StatusCode::OK);

    assert!(moved_note_dir.is_dir(), "Le dossier de note restauré doit réapparaître");
    assert!(moved_md_file.is_file(), "Le fichier markdown doit être restauré");
    assert!(moved_asset.is_file(), "Les assets doivent être restaurés");

    // 11. Téléchargement de la note en archive ZIP avec assets inclus via /api/files/export-zip/*filename
    let req_zip = Request::builder()
        .method("GET")
        .uri("/api/files/export-zip/M%C3%A9decine/Neuroanatomie.md")
        .header(header::COOKIE, &cookie)
        .body(Body::empty())
        .unwrap();

    let res_zip = router.clone().oneshot(req_zip).await.unwrap();
    assert_eq!(res_zip.status(), StatusCode::OK);
    assert_eq!(
        res_zip.headers().get(header::CONTENT_TYPE).unwrap(),
        "application/zip"
    );
    assert!(res_zip
        .headers()
        .get(header::CONTENT_DISPOSITION)
        .unwrap()
        .to_str()
        .unwrap()
        .contains("Neuroanatomie.zip"));

    let zip_bytes = to_bytes(res_zip.into_body(), usize::MAX).await.unwrap();
    let cursor = std::io::Cursor::new(zip_bytes);
    let zip_archive = zip::ZipArchive::new(cursor).expect("Archive zip valide");

    let mut entry_names: Vec<String> = zip_archive.file_names().map(|s| s.to_string()).collect();
    entry_names.sort();

    assert!(
        entry_names.iter().any(|n| n == "Neuroanatomie/" || n == "Neuroanatomie/Neuroanatomie.md"),
        "L'archive doit contenir le dossier racine et le fichier .md: {:?}",
        entry_names
    );
    assert!(
        entry_names.iter().any(|n| n.contains("assets/moelle.png")),
        "L'archive doit contenir l'asset moelle.png: {:?}",
        entry_names
    );

    // Vérifier aussi le téléchargement via /api/documents/:id/download
    let req_doc_dl = Request::builder()
        .method("GET")
        .uri(format!("/api/documents/{}/download", doc_id))
        .header(header::COOKIE, &cookie)
        .body(Body::empty())
        .unwrap();

    let res_doc_dl = router.clone().oneshot(req_doc_dl).await.unwrap();
    assert_eq!(res_doc_dl.status(), StatusCode::OK);
    assert_eq!(
        res_doc_dl.headers().get(header::CONTENT_TYPE).unwrap(),
        "application/zip"
    );
    let dl_bytes = to_bytes(res_doc_dl.into_body(), usize::MAX).await.unwrap();
    let dl_archive = zip::ZipArchive::new(std::io::Cursor::new(dl_bytes)).expect("Archive zip valide");
    let dl_names: Vec<String> = dl_archive.file_names().map(|s| s.to_string()).collect();
    assert!(
        dl_names.iter().any(|n| n.contains("assets/moelle.png")),
        "Le téléchargement de document markdown doit être un zip avec assets: {:?}",
        dl_names
    );
}

#[tokio::test]
async fn test_rename_note_rewrites_asset_references() {
    let (state, token, _tmp) = setup_test_app();
    let router = create_api_router(Arc::clone(&state)).with_state(Arc::clone(&state));
    let cookie = format!("docseeker_session={}", token);

    // 1. Créer une note contenant une référence vers un asset
    let initial_content = "# QA Asset\n\n![img](/api/assets/QA%20Asset%20Note/tiny.png)\n";
    let req_create = Request::builder()
        .method("POST")
        .uri("/api/files")
        .header(header::COOKIE, &cookie)
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(serde_json::json!({
            "filename": "QA Asset Note.md",
            "content": initial_content
        }).to_string()))
        .unwrap();

    let res_create = router.clone().oneshot(req_create).await.unwrap();
    assert_eq!(res_create.status(), StatusCode::CREATED);
    let create_body = to_bytes(res_create.into_body(), usize::MAX).await.unwrap();
    let create_json: serde_json::Value = serde_json::from_slice(&create_body).unwrap();
    let doc_id = create_json["doc_id"].as_i64().expect("doc_id valide");

    // 2. Créer manuellement l'asset tiny.png dans son dossier
    let note_dir = state.config.documents_dir.join("QA Asset Note");
    let assets_dir = note_dir.join("assets");
    std::fs::create_dir_all(&assets_dir).unwrap();
    std::fs::write(assets_dir.join("tiny.png"), b"\x89PNG\r\n\x1a\nfakeimage").unwrap();

    // Vérifier l'accès à l'asset sous son ancien nom
    let req_asset_old = Request::builder()
        .method("GET")
        .uri("/api/assets/QA%20Asset%20Note/tiny.png")
        .header(header::COOKIE, &cookie)
        .body(Body::empty())
        .unwrap();
    let res_asset_old = router.clone().oneshot(req_asset_old).await.unwrap();
    assert_eq!(res_asset_old.status(), StatusCode::OK);

    // 3. Renommer la note via PATCH /api/documents/:id
    let req_rename = Request::builder()
        .method("PATCH")
        .uri(format!("/api/documents/{}", doc_id))
        .header(header::COOKIE, &cookie)
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(serde_json::json!({
            "title": "QA Asset Note Renamed"
        }).to_string()))
        .unwrap();
    let res_rename = router.clone().oneshot(req_rename).await.unwrap();
    assert_eq!(res_rename.status(), StatusCode::OK);

    // 4. Vérifier que les références dans le fichier .md ont été réécrites
    let new_note_dir = state.config.documents_dir.join("QA Asset Note Renamed");
    let new_md_file = new_note_dir.join("QA Asset Note Renamed.md");
    assert!(new_md_file.exists(), "Le nouveau fichier markdown doit exister");

    let updated_content = std::fs::read_to_string(&new_md_file).unwrap();
    assert!(
        updated_content.contains("/api/assets/QA%20Asset%20Note%20Renamed/tiny.png"),
        "La référence d'asset doit être réécrite avec le nouveau nom : {}",
        updated_content
    );
    assert!(
        !updated_content.contains("/api/assets/QA%20Asset%20Note/"),
        "L'ancien chemin ne doit plus figurer dans le contenu"
    );

    // 5. Vérifier que l'asset est accessible sous le nouveau chemin
    let req_asset_new = Request::builder()
        .method("GET")
        .uri("/api/assets/QA%20Asset%20Note%20Renamed/tiny.png")
        .header(header::COOKIE, &cookie)
        .body(Body::empty())
        .unwrap();
    let res_asset_new = router.clone().oneshot(req_asset_new).await.unwrap();
    assert_eq!(res_asset_new.status(), StatusCode::OK);
}

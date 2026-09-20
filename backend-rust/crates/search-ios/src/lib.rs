//! search-ios: Pont C-ABI / Native pour le client iOS & iPadOS de DocSeeker
//!
//! Expose des fonctions conformes au standard C-ABI (extern "C") directement
//! appelables depuis Swift et Objective-C, sans aucune surcouche WebAssembly.

use std::ffi::{CStr, CString};
use std::os::raw::{c_char, c_double, c_int};
use std::path::Path;
use rusqlite::{params, Connection};
use search_core::{
    calculate_crop_bounds, get_full_schema_sql,
    build_doc_search_sql, build_search_query_sql,
    process_doc_search_results, process_search_results,
    RawSqlSearchRow, SearchResponse, WordEntry,
    INSERT_OR_REPLACE_DOC_SQL, INSERT_PAGE_SQL,
    DELETE_DOC_PAGES_SQL, DELETE_DOC_SQL,
    INSERT_OR_REPLACE_FOLDER_SQL, GET_CACHED_DOCS_SQL,
    GET_SUBFOLDER_IDS_SQL,
};
use serde::{Deserialize, Serialize};

// Helper de conversion C string vers &str
unsafe fn cstr_to_str<'a>(ptr: *const c_char) -> Option<&'a str> {
    if ptr.is_null() {
        return None;
    }
    CStr::from_ptr(ptr).to_str().ok()
}

// Helper pour retourner une C string allouée
fn str_to_c_string(s: &str) -> *mut c_char {
    CString::new(s).unwrap_or_default().into_raw()
}

/// Libère la mémoire d'une chaîne retournée par Rust
#[no_mangle]
pub unsafe extern "C" fn docseeker_free_string(ptr: *mut c_char) {
    if !ptr.is_null() {
        let _ = CString::from_raw(ptr);
    }
}

/// Initialise la base de données SQLite locale avec le schéma officiel
/// et active les pragmas de performance (WAL mode, cache).
#[no_mangle]
pub unsafe extern "C" fn docseeker_init_db(db_path_ptr: *const c_char) -> c_int {
    let db_path = match cstr_to_str(db_path_ptr) {
        Some(p) => p,
        None => return -1,
    };

    let conn = match Connection::open(Path::new(db_path)) {
        Ok(c) => c,
        Err(_) => return -2,
    };

    let pragmas = "
        PRAGMA journal_mode = WAL;
        PRAGMA synchronous = NORMAL;
        PRAGMA foreign_keys = OFF;
        PRAGMA cache_size = -64000;
        PRAGMA temp_store = MEMORY;
    ";
    if conn.execute_batch(pragmas).is_err() {
        return -3;
    }

    let schema = get_full_schema_sql();
    if conn.execute_batch(&schema).is_err() {
        return -4;
    }

    0
}

/// Structure miroir pour désérialiser le bundle de synchronisation
#[derive(Debug, Deserialize)]
struct BundleDoc {
    id: i64,
    filename: String,
    title: Option<String>,
    file_hash: Option<String>,
    folder_id: Option<i64>,
    total_pages: Option<i64>,
    file_size: Option<i64>,
    created_at: Option<String>,
    updated_at: Option<String>,
}

#[derive(Debug, Deserialize)]
struct BundlePage {
    page_number: i64,
    text_content: Option<String>,
    words_json: Option<String>,
    words: Option<serde_json::Value>,
}

#[derive(Debug, Deserialize)]
struct DocumentBundlePayload {
    document: BundleDoc,
    pages: Option<Vec<BundlePage>>,
}

/// Insère atomiquement un document et ses pages dans la base SQLite locale
#[no_mangle]
pub unsafe extern "C" fn docseeker_insert_bundle(
    db_path_ptr: *const c_char,
    bundle_json_ptr: *const c_char,
) -> c_int {
    let db_path = match cstr_to_str(db_path_ptr) {
        Some(p) => p,
        None => return -1,
    };
    let bundle_json = match cstr_to_str(bundle_json_ptr) {
        Some(j) => j,
        None => return -2,
    };

    let payload: DocumentBundlePayload = match serde_json::from_str(bundle_json) {
        Ok(p) => p,
        Err(_) => return -3,
    };

    let mut conn = match Connection::open(Path::new(db_path)) {
        Ok(c) => c,
        Err(_) => return -4,
    };
    let _ = conn.execute_batch("PRAGMA foreign_keys = OFF;");

    let tx = match conn.transaction() {
        Ok(t) => t,
        Err(_) => return -5,
    };

    let doc = payload.document;
    let pages = payload.pages.unwrap_or_default();
    let total_pages = doc.total_pages.unwrap_or(pages.len() as i64);
    let title = doc.title.unwrap_or_else(|| doc.filename.clone());
    let now = chrono::Utc::now().to_rfc3339();
    let created_at = doc.created_at.unwrap_or_else(|| now.clone());
    let updated_at = doc.updated_at.unwrap_or(now);

    // 1. Insertion ou mise à jour du document
    if let Err(e) = tx.execute(
        INSERT_OR_REPLACE_DOC_SQL,
        params![
            doc.id,
            doc.filename,
            title,
            doc.file_hash,
            doc.folder_id,
            total_pages,
            doc.file_size.unwrap_or(0),
            created_at,
            updated_at,
        ],
    ) {
        eprintln!("[docseeker_insert_bundle] execute error: {:?}", e);
        return -6;
    }

    // 2. Nettoyage des anciennes pages
    let _ = tx.execute(DELETE_DOC_PAGES_SQL, params![doc.id]);

    // 3. Insertion des nouvelles pages (les triggers pages_ai alimentent pages_fts automatiquement)
    {
        let mut stmt = match tx.prepare(INSERT_PAGE_SQL) {
            Ok(s) => s,
            Err(_) => return -7,
        };

        for page in pages {
            let text = page.text_content.unwrap_or_default();
            let words = if let Some(wj) = page.words_json {
                wj
            } else if let Some(w) = page.words {
                serde_json::to_string(&w).unwrap_or_else(|_| "[]".to_string())
            } else {
                "[]".to_string()
            };
            if stmt.execute(params![doc.id, page.page_number, text, words]).is_err() {
                return -8;
            }
        }
    }

    if tx.commit().is_err() {
        return -9;
    }

    0
}

#[derive(Debug, Deserialize)]
struct SyncFolderItem {
    id: i64,
    name: String,
    parent_id: Option<i64>,
    color: Option<String>,
}

/// Synchronise l'ensemble de l'arborescence des dossiers
#[no_mangle]
pub unsafe extern "C" fn docseeker_sync_folders(
    db_path_ptr: *const c_char,
    folders_json_ptr: *const c_char,
) -> c_int {
    let db_path = match cstr_to_str(db_path_ptr) {
        Some(p) => p,
        None => return -1,
    };
    let folders_json = match cstr_to_str(folders_json_ptr) {
        Some(j) => j,
        None => return -2,
    };

    let folders: Vec<SyncFolderItem> = match serde_json::from_str(folders_json) {
        Ok(f) => f,
        Err(_) => return -3,
    };

    let mut conn = match Connection::open(Path::new(db_path)) {
        Ok(c) => c,
        Err(_) => return -4,
    };
    // Crucial : désactiver les clés étrangères pour éviter que SQLite ne mette folder_id = NULL sur les documents en cache
    let _ = conn.execute_batch("PRAGMA foreign_keys = OFF;");

    let tx = match conn.transaction() {
        Ok(t) => t,
        Err(_) => return -5,
    };

    let mut keep_ids = Vec::new();
    {
        let mut stmt = match tx.prepare(INSERT_OR_REPLACE_FOLDER_SQL) {
            Ok(s) => s,
            Err(_) => return -6,
        };

        for f in folders {
            keep_ids.push(f.id);
            let color = f.color.unwrap_or_else(|| "#3b82f6".to_string());
            if stmt.execute(params![f.id, f.name, f.parent_id, color]).is_err() {
                return -7;
            }
        }
    }

    if !keep_ids.is_empty() {
        let id_strs: Vec<String> = keep_ids.iter().map(|id| id.to_string()).collect();
        let delete_sql = format!("DELETE FROM folders WHERE id NOT IN ({})", id_strs.join(","));
        let _ = tx.execute(&delete_sql, []);
    } else {
        let _ = tx.execute("DELETE FROM folders;", []);
    }

    if tx.commit().is_err() {
        return -8;
    }

    0
}

/// Supprime un document et ses pages de la base locale
#[no_mangle]
pub unsafe extern "C" fn docseeker_delete_doc(
    db_path_ptr: *const c_char,
    doc_id: i64,
) -> c_int {
    let db_path = match cstr_to_str(db_path_ptr) {
        Some(p) => p,
        None => return -1,
    };
    let conn = match Connection::open(Path::new(db_path)) {
        Ok(c) => c,
        Err(_) => return -2,
    };

    let _ = conn.execute(DELETE_DOC_PAGES_SQL, params![doc_id]);
    let _ = conn.execute(DELETE_DOC_SQL, params![doc_id]);
    0
}

#[derive(Debug, Serialize)]
struct CachedDocInfo {
    id: i64,
    file_hash: Option<String>,
    updated_at: Option<String>,
}

/// Récupère la liste des documents indexés localement
#[no_mangle]
pub unsafe extern "C" fn docseeker_get_cached_docs(db_path_ptr: *const c_char) -> *mut c_char {
    let db_path = match cstr_to_str(db_path_ptr) {
        Some(p) => p,
        None => return str_to_c_string("[]"),
    };
    let conn = match Connection::open(Path::new(db_path)) {
        Ok(c) => c,
        Err(_) => return str_to_c_string("[]"),
    };

    let mut stmt = match conn.prepare(GET_CACHED_DOCS_SQL) {
        Ok(s) => s,
        Err(_) => return str_to_c_string("[]"),
    };

    let rows = stmt.query_map([], |row| {
        Ok(CachedDocInfo {
            id: row.get(0)?,
            file_hash: row.get(1)?,
            updated_at: row.get(2)?,
        })
    });

    let mut list = Vec::new();
    if let Ok(iter) = rows {
        for item in iter.flatten() {
            list.push(item);
        }
    }

    let json = serde_json::to_string(&list).unwrap_or_else(|_| "[]".to_string());
    str_to_c_string(&json)
}

/// Exécute une recherche globale FTS5 + BM25 locale avec scoring Goodnotes
#[no_mangle]
pub unsafe extern "C" fn docseeker_search_local(
    db_path_ptr: *const c_char,
    query_ptr: *const c_char,
    folder_id: i64,
    has_folder: c_int,
    limit: usize,
    offset: usize,
) -> *mut c_char {
    let db_path = match cstr_to_str(db_path_ptr) {
        Some(p) => p,
        None => return str_to_c_string("{\"error\":\"invalid_db_path\"}"),
    };
    let query_str = match cstr_to_str(query_ptr) {
        Some(q) => q,
        None => return str_to_c_string("{\"error\":\"invalid_query\"}"),
    };

    let conn = match Connection::open(Path::new(db_path)) {
        Ok(c) => c,
        Err(e) => {
            let err = format!("{{\"error\":\"db_open_failed: {}\"}}", e);
            return str_to_c_string(&err);
        }
    };

    // Récupérer les sous-dossiers récursifs si folder_id est spécifié
    let folder_ids_vec: Option<Vec<i64>> = if has_folder != 0 {
        let mut ids = vec![folder_id];
        if let Ok(mut stmt) = conn.prepare(GET_SUBFOLDER_IDS_SQL) {
            if let Ok(rows) = stmt.query_map(params![folder_id], |row| row.get::<_, i64>(0)) {
                for id in rows.flatten() {
                    if !ids.contains(&id) {
                        ids.push(id);
                    }
                }
            }
        }
        Some(ids)
    } else {
        None
    };

    let search_sql_data = build_search_query_sql(
        query_str,
        folder_ids_vec.as_deref(),
        limit,
        offset,
    );

    if search_sql_data.sql.is_empty() || search_sql_data.terms.is_empty() {
        let empty_res = SearchResponse {
            query: query_str.to_string(),
            query_hash: String::new(),
            total_documents: 0,
            total_occurrences: 0,
            results: Vec::new(),
            page: 1,
            limit,
            total_pages: 0,
            has_more: false,
        };
        return str_to_c_string(&serde_json::to_string(&empty_res).unwrap_or_default());
    }

    let mut raw_rows = Vec::new();
    let mut total_docs: usize = 0;
    let mut total_occs: usize = 0;

    if let Ok(mut stmt) = conn.prepare(&search_sql_data.sql) {
        let query_iter = stmt.query_map([], |row| {
            let doc_id: i64 = row.get(0)?;
            let filename: String = row.get(1)?;
            let title: String = row.get::<_, Option<String>>(2)?.unwrap_or_else(|| filename.clone());
            let f_id: Option<i64> = row.get(3)?;
            let total_p: i64 = row.get(4)?;
            let created_at: String = row.get::<_, Option<String>>(5)?.unwrap_or_default();
            let updated_at: String = row.get::<_, Option<String>>(6)?.unwrap_or_default();
            let doc_rel: f64 = row.get(7)?;
            let match_p: i64 = row.get(8)?;
            let page_num: i64 = row.get(9)?;
            let words_json: String = row.get::<_, Option<String>>(10)?.unwrap_or_else(|| "[]".to_string());
            let page_bm25: f64 = row.get(11)?;
            let t_docs: i64 = row.get(12)?;
            let t_occs: i64 = row.get(13)?;

            Ok((
                doc_id, filename, title, f_id, total_p, created_at, updated_at,
                doc_rel, match_p, page_num, words_json, page_bm25, t_docs, t_occs
            ))
        });

        if let Ok(rows) = query_iter {
            for item in rows.flatten() {
                let (
                    doc_id, filename, title, f_id, total_p, created_at, updated_at,
                    doc_rel, match_p, page_num, words_json, page_bm25, t_docs, t_occs
                ) = item;

                total_docs = t_docs.max(0) as usize;
                total_occs = t_occs.max(0) as usize;

                raw_rows.push(RawSqlSearchRow {
                    doc_id,
                    filename,
                    title,
                    folder_id: f_id,
                    total_pages: total_p,
                    created_at,
                    updated_at,
                    doc_relevance_score: doc_rel,
                    matching_pages_count: match_p,
                    page_number: page_num,
                    words_json,
                    page_bm25,
                    total_docs,
                    total_occurrences: total_occs,
                });
            }
        }
    }

    let search_result = process_search_results(
        &raw_rows,
        &search_sql_data.terms,
        &search_sql_data.query_hash,
    );

    let current_page = (offset / limit) + 1;
    let total_pages = if limit > 0 {
        ((total_docs as f64) / (limit as f64)).ceil() as usize
    } else {
        0
    };

    let final_res = SearchResponse {
        query: query_str.to_string(),
        query_hash: search_sql_data.query_hash,
        total_documents: total_docs,
        total_occurrences: total_occs,
        results: search_result,
        page: current_page,
        limit,
        total_pages,
        has_more: offset + limit < total_docs,
    };

    let json = serde_json::to_string(&final_res).unwrap_or_else(|_| "{}".to_string());
    str_to_c_string(&json)
}

/// Exécute la recherche au sein d'un document unique (pour le tiroir d'occurrences)
#[no_mangle]
pub unsafe extern "C" fn docseeker_doc_search_local(
    db_path_ptr: *const c_char,
    doc_id: i64,
    query_ptr: *const c_char,
) -> *mut c_char {
    let db_path = match cstr_to_str(db_path_ptr) {
        Some(p) => p,
        None => return str_to_c_string("{\"occurrences\":[]}"),
    };
    let query_str = match cstr_to_str(query_ptr) {
        Some(q) => q,
        None => return str_to_c_string("{\"occurrences\":[]}"),
    };

    let conn = match Connection::open(Path::new(db_path)) {
        Ok(c) => c,
        Err(_) => return str_to_c_string("{\"occurrences\":[]}"),
    };

    let (doc_sql, terms, query_hash) = build_doc_search_sql(doc_id, query_str);
    if doc_sql.is_empty() || terms.is_empty() {
        return str_to_c_string("{\"occurrences\":[]}");
    }

    let encoded_terms = urlencoding::encode(query_str);
    let mut all_occurrences = Vec::new();

    if let Ok(mut stmt) = conn.prepare(&doc_sql) {
        let query_iter = stmt.query_map([], |row| {
            let page_num: i64 = row.get(0)?;
            let words_json: String = row.get::<_, Option<String>>(1)?.unwrap_or_else(|| "[]".to_string());
            let page_bm25: f64 = row.get(2)?;
            Ok((page_num, words_json, page_bm25))
        });

        if let Ok(rows) = query_iter {
            for item in rows.flatten() {
                let (page_number, words_json, page_bm25) = item;
                if let Ok(words) = serde_json::from_str::<Vec<WordEntry>>(&words_json) {
                    let occs = search_core::matching::find_occurrences_on_page(
                        &words,
                        &terms,
                        &query_hash,
                        doc_id,
                        page_number,
                        page_bm25,
                        &encoded_terms,
                        842.0,
                    );
                    all_occurrences.extend(occs);
                }
            }
        }
    }

    let doc_res = process_doc_search_results(all_occurrences, None, None);
    let json = serde_json::to_string(&doc_res).unwrap_or_else(|_| "{}".to_string());
    str_to_c_string(&json)
}

/// Calcule les coordonnées optimales de cadrage pour un extrait (identique à crop.rs)
#[no_mangle]
pub unsafe extern "C" fn docseeker_calculate_crop_bounds(
    x0: c_double,
    y0: c_double,
    x1: c_double,
    y1: c_double,
    page_w: c_double,
    page_h: c_double,
    out_x0: *mut c_double,
    out_y0: *mut c_double,
    out_w: *mut c_double,
    out_h: *mut c_double,
) {
    let bounds = calculate_crop_bounds([x0, y0, x1, y1], page_w, page_h, None, None);
    if !out_x0.is_null() { *out_x0 = bounds.x0; }
    if !out_y0.is_null() { *out_y0 = bounds.y0; }
    if !out_w.is_null() { *out_w = bounds.width; }
    if !out_h.is_null() { *out_h = bounds.height; }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::ffi::CString;

    #[test]
    fn test_c_abi_lifecycle() {
        let temp_dir = std::env::temp_dir();
        let db_file = temp_dir.join("test_docseeker_ios.sqlite");
        let _ = std::fs::remove_file(&db_file);
        let db_path_c = CString::new(db_file.to_str().unwrap()).unwrap();

        // 1. Initialisation
        unsafe {
            assert_eq!(docseeker_init_db(db_path_c.as_ptr()), 0);
        }

        // 2. Insertion Bundle
        let bundle_json = r#"{
            "document": {
                "id": 101,
                "filename": "cardiologie_cours.pdf",
                "title": "Cardiologie Générale",
                "folder_id": 1,
                "total_pages": 2
            },
            "pages": [
                {
                    "page_number": 1,
                    "text_content": "Introduction aux syndromes coronariens aigus et insuffisance cardiaque.",
                    "words_json": "[[10, 20, 50, 35, \"Introduction\", 1, 1], [60, 20, 120, 35, \"cardiaque\", 1, 2]]"
                },
                {
                    "page_number": 2,
                    "text_content": "Traitement de l'insuffisance cardiaque sévère.",
                    "words_json": "[[10, 20, 80, 35, \"cardiaque\", 1, 1]]"
                }
            ]
        }"#;
        let bundle_c = CString::new(bundle_json).unwrap();
        unsafe {
            assert_eq!(docseeker_insert_bundle(db_path_c.as_ptr(), bundle_c.as_ptr()), 0);
        }

        // 3. Recherche Locale
        let query_c = CString::new("cardiaque").unwrap();
        unsafe {
            let res_ptr = docseeker_search_local(db_path_c.as_ptr(), query_c.as_ptr(), 0, 0, 10, 0);
            assert!(!res_ptr.is_null());
            let res_str = CStr::from_ptr(res_ptr).to_str().unwrap();
            let parsed: serde_json::Value = serde_json::from_str(res_str).unwrap();
            assert_eq!(parsed["total_documents"], 1);
            assert_eq!(parsed["results"][0]["id"], 101);
            docseeker_free_string(res_ptr);
        }

        // 4. Calcul de Crop
        let mut x0 = 0.0;
        let mut y0 = 0.0;
        let mut w = 0.0;
        let mut h = 0.0;
        unsafe {
            docseeker_calculate_crop_bounds(10.0, 20.0, 50.0, 35.0, 595.0, 842.0, &mut x0, &mut y0, &mut w, &mut h);
            assert!(w > 0.0);
            assert!(h > 0.0);
        }

        let _ = std::fs::remove_file(&db_file);
    }
}

use wasm_bindgen::prelude::*;
use search_core::{
    build_doc_search_sql, build_search_query_sql, build_title_search_sql, calculate_crop_bounds,
    find_occurrences_on_page, get_full_schema_sql, get_query_hash, process_doc_search_results,
    process_search_results, sanitize_fts_query, OccurrenceResult, RawSqlSearchRow, WordEntry,
    CROP_RENDER_SCALE, DEFAULT_CROP_HEIGHT, DEFAULT_CROP_WIDTH, GET_CACHED_DOCS_SQL,
    GET_SUBFOLDER_IDS_SQL, GOODNOTES_YELLOW_CSS, GOODNOTES_YELLOW_RGBA, MAX_OCCURRENCES_PER_DOC,
    DELETE_ALL_FOLDERS_SQL, DELETE_DOC_PAGES_SQL, DELETE_DOC_SQL, INSERT_OR_REPLACE_DOC_SQL,
    INSERT_OR_REPLACE_FOLDER_SQL, INSERT_PAGE_SQL, UPSERT_DOC_META_SQL,
};

#[wasm_bindgen]
pub fn get_schema_sql() -> String {
    get_full_schema_sql()
}

#[wasm_bindgen]
pub fn get_insert_doc_sql() -> String {
    INSERT_OR_REPLACE_DOC_SQL.to_string()
}

#[wasm_bindgen]
pub fn get_upsert_doc_meta_sql() -> String {
    UPSERT_DOC_META_SQL.to_string()
}

#[wasm_bindgen]
pub fn get_delete_doc_pages_sql() -> String {
    DELETE_DOC_PAGES_SQL.to_string()
}

#[wasm_bindgen]
pub fn get_insert_page_sql() -> String {
    INSERT_PAGE_SQL.to_string()
}

#[wasm_bindgen]
pub fn get_delete_all_folders_sql() -> String {
    DELETE_ALL_FOLDERS_SQL.to_string()
}

#[wasm_bindgen]
pub fn get_insert_folder_sql() -> String {
    INSERT_OR_REPLACE_FOLDER_SQL.to_string()
}

#[wasm_bindgen]
pub fn get_delete_doc_sql() -> String {
    DELETE_DOC_SQL.to_string()
}

#[wasm_bindgen]
pub fn get_cached_docs_sql() -> String {
    GET_CACHED_DOCS_SQL.to_string()
}

#[wasm_bindgen]
pub fn calculate_crop_bounds_wasm(
    x0: f64,
    y0: f64,
    x1: f64,
    y1: f64,
    page_width: f64,
    page_height: f64,
    target_w: Option<f64>,
    target_h: Option<f64>,
) -> String {
    let bounds = calculate_crop_bounds([x0, y0, x1, y1], page_width, page_height, target_w, target_h);
    serde_json::to_string(&bounds).unwrap_or_else(|_| "{}".to_string())
}


#[wasm_bindgen]
pub fn build_search_sql_wasm(query: &str, folder_id: Option<i64>, limit: usize, offset: usize) -> String {
    let fids = folder_id.map(|fid| vec![fid]);
    let result = build_search_query_sql(query, fids.as_deref(), limit, offset);
    serde_json::json!({
        "sql": result.sql,
        "terms": result.terms,
        "query_hash": result.query_hash,
    }).to_string()
}

#[wasm_bindgen]
pub fn build_title_search_sql_wasm(query: &str, folder_id: Option<i64>, limit: usize, offset: usize) -> String {
    let fids = folder_id.map(|fid| vec![fid]);
    let (sql, terms) = build_title_search_sql(query, fids.as_deref(), limit, offset);
    let query_hash = get_query_hash(&terms);
    serde_json::json!({
        "sql": sql,
        "terms": terms,
        "query_hash": query_hash,
    }).to_string()
}


#[wasm_bindgen]
pub fn build_doc_search_sql_wasm(doc_id: i64, query: &str) -> String {
    let (sql, terms, query_hash) = build_doc_search_sql(doc_id, query);
    serde_json::json!({
        "sql": sql,
        "terms": terms,
        "query_hash": query_hash,
    }).to_string()
}

#[wasm_bindgen]
pub fn sanitize_query_wasm(query: &str) -> String {
    let terms = sanitize_fts_query(query);
    serde_json::to_string(&terms).unwrap_or_else(|_| "[]".to_string())
}

#[wasm_bindgen]
pub fn compute_query_hash_wasm(terms_json: &str) -> String {
    let terms: Vec<String> = serde_json::from_str(terms_json).unwrap_or_default();
    get_query_hash(&terms)
}

#[wasm_bindgen]
pub fn find_occurrences_wasm(
    words_json: &str,
    terms_json: &str,
    query_hash: &str,
    doc_id: i64,
    page_number: i64,
    bm25_score: f64,
    page_height: f64,
) -> String {
    let words_data: Vec<WordEntry> = serde_json::from_str(words_json).unwrap_or_default();
    let query_terms: Vec<String> = serde_json::from_str(terms_json).unwrap_or_default();
    let encoded_terms = urlencoding::encode(&query_terms.join(",")).to_string();

    let results = find_occurrences_on_page(
        &words_data,
        &query_terms,
        query_hash,
        doc_id,
        page_number,
        bm25_score,
        &encoded_terms,
        page_height,
    );

    serde_json::to_string(&results).unwrap_or_else(|_| "[]".to_string())
}

#[wasm_bindgen]
pub fn get_shared_constants_wasm() -> String {
    serde_json::json!({
        "max_occurrences_per_doc": MAX_OCCURRENCES_PER_DOC,
        "default_crop_width": DEFAULT_CROP_WIDTH,
        "default_crop_height": DEFAULT_CROP_HEIGHT,
        "crop_render_scale": CROP_RENDER_SCALE,
        "goodnotes_yellow_rgba": GOODNOTES_YELLOW_RGBA,
        "goodnotes_yellow_css": GOODNOTES_YELLOW_CSS,
    }).to_string()
}

#[wasm_bindgen]
pub fn get_subfolder_ids_sql_wasm() -> String {
    GET_SUBFOLDER_IDS_SQL.to_string()
}

/// Post-traitement algorithmique complet (identique au serveur distant) exécuté en WebAssembly
#[wasm_bindgen]
pub fn process_search_results_wasm(
    raw_rows_json: &str,
    query_terms_json: &str,
    query_hash: &str,
) -> String {
    let rows: Vec<RawSqlSearchRow> = serde_json::from_str(raw_rows_json).unwrap_or_default();
    let terms: Vec<String> = serde_json::from_str(query_terms_json).unwrap_or_default();

    let results = process_search_results(&rows, &terms, query_hash);
    serde_json::to_string(&results).unwrap_or_else(|_| "[]".to_string())
}

/// Tri et pagination des occurrences au sein d'un document (Split View)
#[wasm_bindgen]
pub fn process_doc_search_results_wasm(
    occurrences_json: &str,
    offset: Option<usize>,
    limit: Option<usize>,
) -> String {
    let occurrences: Vec<OccurrenceResult> = serde_json::from_str(occurrences_json).unwrap_or_default();
    let (total, paged) = process_doc_search_results(occurrences, offset, limit);
    serde_json::json!({
        "total_occurrences": total,
        "occurrences": paged,
    }).to_string()
}

/// Traite en lot plusieurs pages d'un document pour extraire les occurrences
/// Évite N allers-retours JS↔WASM avec parsing/sérialisation JSON répété
#[wasm_bindgen]
pub fn batch_find_and_process_doc_occurrences_wasm(
    pages_json: &str,
    terms_json: &str,
    query_hash: &str,
    doc_id: i64,
    page_height: f64,
    offset: Option<usize>,
    limit: Option<usize>,
) -> String {
    let pages: Vec<(i64, String, f64)> = serde_json::from_str(pages_json).unwrap_or_default();
    let query_terms: Vec<String> = serde_json::from_str(terms_json).unwrap_or_default();
    let encoded_terms = urlencoding::encode(&query_terms.join(",")).to_string();

    let mut all_occurrences = Vec::new();
    for (page_number, words_json, page_bm25) in pages {
        if words_json.is_empty() || words_json == "[]" {
            continue;
        }
        let words_data: Vec<WordEntry> = serde_json::from_str(&words_json).unwrap_or_default();
        let occs = find_occurrences_on_page(
            &words_data,
            &query_terms,
            query_hash,
            doc_id,
            page_number,
            page_bm25,
            &encoded_terms,
            page_height,
        );
        all_occurrences.extend(occs);
    }

    let (total, paged) = process_doc_search_results(all_occurrences, offset, limit);
    serde_json::json!({
        "total_occurrences": total,
        "occurrences": paged,
    }).to_string()
}


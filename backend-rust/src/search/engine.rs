use rusqlite::{params, Connection, Result};

use crate::db::text_norm::normalize_text;

use super::types::{DocSearchResponse, DocumentSearchResult, SearchResponse, WordEntry};

// Re-export des constantes, types, fonctions de matching et calcul spatial depuis search_core (source unique de vérité)
pub use search_core::constants::MAX_OCCURRENCES_PER_DOC;
pub use search_core::matching::{find_occurrences_on_page, get_query_hash, sanitize_fts_query};
pub use search_core::processing::{process_doc_search_results, process_search_results, RawSqlSearchRow};
pub use search_core::sql::GET_SUBFOLDER_IDS_SQL;

pub fn get_folder_and_subfolder_ids(conn: &Connection, folder_id: i64) -> Vec<i64> {
    let mut stmt = match conn.prepare(GET_SUBFOLDER_IDS_SQL) {
        Ok(s) => s,
        Err(_) => return vec![folder_id],
    };

    let rows = stmt.query_map(params![folder_id], |row| row.get::<_, i64>(0));
    match rows {
        Ok(mapped) => mapped.flatten().collect(),
        Err(_) => vec![folder_id],
    }
}

pub fn term_matches_text(term: &str, text: &str) -> bool {
    if term.is_empty() || text.is_empty() {
        return false;
    }
    if text.contains(term) {
        return true;
    }
    if term.len() > 3 && (term.ends_with('s') || term.ends_with('x')) {
        let stem = &term[..term.len() - 1];
        if text.contains(stem) {
            return true;
        }
    }
    if term.len() > 4 && term.ends_with("aux") {
        let stem = format!("{}al", &term[..term.len() - 3]);
        if text.contains(&stem) {
            return true;
        }
    }
    false
}

pub fn search_titles(
    conn: &Connection,
    query: &str,
    folder_id: Option<i64>,
    limit: Option<usize>,
    offset: Option<usize>,
) -> Result<SearchResponse> {
    let terms = sanitize_fts_query(query);
    let page_size = limit.unwrap_or(15);
    let current_offset = offset.unwrap_or(0);

    if terms.is_empty() {
        return Ok(SearchResponse {
            query: query.to_string(),
            query_hash: String::new(),
            total_documents: 0,
            total_occurrences: 0,
            results: Vec::new(),
            page: 1,
            limit: page_size,
            total_pages: 0,
            has_more: false,
        });
    }

    let allowed_folder_ids: Option<Vec<i64>> = folder_id.map(|fid| {
        get_folder_and_subfolder_ids(conn, fid)
    });

    // Recherche déléguée au builder partagé (search-core) : l'index documents_fts
    // (même tokenizer FTS5 que la recherche de contenu) garantit l'insensibilité
    // casse/accents en ligne, hors ligne (wasm) et iOS — une seule implémentation.
    let (query_sql, _) = search_core::sql::build_title_search_sql(
        query,
        allowed_folder_ids.as_deref(),
        page_size,
        current_offset,
    );
    if query_sql.is_empty() {
        return Ok(SearchResponse {
            query: query.to_string(),
            query_hash: String::new(),
            total_documents: 0,
            total_occurrences: 0,
            results: Vec::new(),
            page: 1,
            limit: page_size,
            total_pages: 0,
            has_more: false,
        });
    }

    // Nombre total de documents correspondants : même builder SANS limite
    // (i64::MAX) ni offset, pour un COUNT exact indépendant de la pagination.
    let (count_sql, _) = search_core::sql::build_title_search_sql(
        query,
        allowed_folder_ids.as_deref(),
        usize::MAX / 2,
        0,
    );
    let total_documents: usize = if count_sql.is_empty() {
        0
    } else {
        let wrapped = format!("SELECT count(*) FROM ({count_sql})");
        conn.query_row(&wrapped, [], |r| r.get(0)).unwrap_or(0)
    };

    let mut stmt = match conn.prepare(&query_sql) {
        Ok(s) => s,
        Err(_) => {
            let _ = conn.execute_batch(crate::db::schema::CREATE_FTS5_TABLE);
            conn.prepare(&query_sql)?
        }
    };

    let rows = stmt.query_map([], |row| {
        Ok((
            row.get::<_, i64>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, Option<String>>(2)?.unwrap_or_default(),
            row.get::<_, Option<i64>>(3)?,
            row.get::<_, Option<i64>>(4)?.unwrap_or(0),
            row.get::<_, Option<String>>(5)?.unwrap_or_default(),
            row.get::<_, Option<String>>(6)?.unwrap_or_default(),
            row.get::<_, Option<String>>(7)?.unwrap_or_else(|| "pdf".to_string()),
        ))
    })?;

    let mut results = Vec::new();
    let norm_terms: Vec<String> = terms.iter().map(|t| normalize_text(t)).collect();
    for r in rows.flatten() {
        let (id, filename, title, doc_folder_id, total_pages, created_at, updated_at, doc_type) = r;
        let title_norm = normalize_text(&title);
        let bonus = if norm_terms.iter().any(|t| t == &title_norm) { 100.0 } else { 0.0 };
        results.push(DocumentSearchResult {
            id,
            filename,
            title,
            folder_id: doc_folder_id,
            total_pages,
            created_at,
            updated_at,
            doc_type,
            cover_url: format!("/api/cover/{}", id),
            vignettes: Vec::new(),
            occurrences_by_page: Vec::new(),
            total_occurrences: 0,
            relevance_score: 5000.0 + bonus,
            matched_all_terms: true,
        });
    }

    let total_pages = if total_documents > 0 && page_size > 0 {
        total_documents.div_ceil(page_size)
    } else {
        0
    };
    let has_more = current_offset + page_size < total_documents;
    let page = if page_size > 0 { (current_offset / page_size) + 1 } else { 1 };

    Ok(SearchResponse {
        query: query.to_string(),
        query_hash: get_query_hash(&terms),
        total_documents,
        total_occurrences: 0,
        results,
        page,
        limit: page_size,
        total_pages,
        has_more,
    })
}

// Type unifié RawSqlSearchRow importé directement de search_core

pub fn search_documents(
    conn: &Connection,
    query: &str,
    titles_only: bool,
    folder_id: Option<i64>,
    limit: Option<usize>,
    offset: Option<usize>,
) -> Result<SearchResponse> {
    if titles_only {
        return search_titles(conn, query, folder_id, limit, offset);
    }

    let terms = sanitize_fts_query(query);
    let page_size = limit.unwrap_or(15);
    let current_offset = offset.unwrap_or(0);

    if terms.is_empty() {
        return Ok(SearchResponse {
            query: query.to_string(),
            query_hash: String::new(),
            total_documents: 0,
            total_occurrences: 0,
            results: Vec::new(),
            page: 1,
            limit: page_size,
            total_pages: 0,
            has_more: false,
        });
    }

    let allowed_folder_ids: Option<Vec<i64>> = folder_id.map(|fid| {
        get_folder_and_subfolder_ids(conn, fid)
    });

    let search_sql_data = search_core::sql::build_search_query_sql(
        query,
        allowed_folder_ids.as_deref(),
        page_size,
        current_offset,
    );

    if search_sql_data.sql.is_empty() {
        return Ok(SearchResponse {
            query: query.to_string(),
            query_hash: String::new(),
            total_documents: 0,
            total_occurrences: 0,
            results: Vec::new(),
            page: 1,
            limit: page_size,
            total_pages: 0,
            has_more: false,
        });
    }

    let query_hash = search_sql_data.query_hash;

    let run_sql = |sql: &str| -> Result<Vec<RawSqlSearchRow>> {
        let mut stmt = conn.prepare(sql)?;
        let rows = stmt.query_map([], |r| {
            Ok(RawSqlSearchRow {
                doc_id: r.get(0)?,
                filename: r.get(1)?,
                title: r.get::<_, Option<String>>(2)?.unwrap_or_default(),
                folder_id: r.get(3)?,
                total_pages: r.get(4)?,
                created_at: r.get(5)?,
                updated_at: r.get(6)?,
                doc_relevance_score: r.get(7)?,
                matching_pages_count: r.get(8)?,
                page_number: r.get(9)?,
                words_json: r.get::<_, Option<String>>(10)?.unwrap_or_else(|| "[]".to_string()),
                page_bm25: r.get(11)?,
                total_docs: r.get::<_, i64>(12)? as usize,
                total_occurrences: r.get::<_, i64>(13)? as usize,
                doc_type: r.get::<_, Option<String>>(14)?.unwrap_or_else(|| "pdf".to_string()),
                page_text_content: r.get::<_, Option<String>>(15)?.unwrap_or_default(),
            })
        })?;
        let mut list = Vec::new();
        for item in rows {
            list.push(item?);
        }
        Ok(list)
    };

    let sql_rows = match run_sql(&search_sql_data.sql) {
        Ok(rows) => rows,
        Err(err) => {
            tracing::warn!("[Search] Requête FTS5 échouée, tentative auto-réparation schéma : {}", err);
            let _ = conn.execute_batch(crate::db::schema::CREATE_FTS5_TABLE);
            run_sql(&search_sql_data.sql)?
        }
    };

    if sql_rows.is_empty() {
        return Ok(SearchResponse {
            query: query.to_string(),
            query_hash,
            total_documents: 0,
            total_occurrences: 0,
            results: Vec::new(),
            page: if page_size > 0 { (current_offset / page_size) + 1 } else { 1 },
            limit: page_size,
            total_pages: 0,
            has_more: false,
        });
    }

    let total_documents = sql_rows[0].total_docs;

    // Traitement unifié par search-core (tri multi-critères, scoring Goodnotes, 25 vignettes)
    let final_results = process_search_results(&sql_rows, &search_sql_data.terms, &query_hash);

    // Pour les documents Markdown (et cas où les occurrences réelles dépassent le simple compte de pages matchées),
    // total_occurrences global doit refléter le nombre réel d'occurrences trouvées.
    let doc_occurrences_sum: usize = final_results.iter().map(|r| r.total_occurrences).sum();
    let total_occurrences = sql_rows[0].total_occurrences.max(doc_occurrences_sum);

    let total_pages = if total_documents > 0 && page_size > 0 {
        total_documents.div_ceil(page_size)
    } else {
        0
    };
    let has_more = current_offset + page_size < total_documents;
    let page = if page_size > 0 { (current_offset / page_size) + 1 } else { 1 };

    Ok(SearchResponse {
        query: query.to_string(),
        query_hash,
        total_documents,
        total_occurrences,
        results: final_results,
        page,
        limit: page_size,
        total_pages,
        has_more,
    })
}

pub fn search_within_document(
    conn: &Connection,
    doc_id: i64,
    query: &str,
    offset: Option<usize>,
    limit: Option<usize>,
) -> Result<DocSearchResponse> {
    let (sql, terms, query_hash) = search_core::sql::build_doc_search_sql(doc_id, query);
    if terms.is_empty() || sql.is_empty() {
        return Ok(DocSearchResponse {
            doc_id,
            query: query.to_string(),
            total_occurrences: 0,
            occurrences: Vec::new(),
        });
    }

    let encoded_terms = urlencoding::encode(&terms.join(",")).to_string();

    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map([], |row| {
        Ok((
            row.get::<_, i64>(0)?,
            row.get::<_, Option<String>>(1)?.unwrap_or_else(|| "[]".to_string()),
            row.get::<_, f64>(2)?,
            row.get::<_, Option<String>>(3)?.unwrap_or_default(),
        ))
    })?;

    let mut occurrences = Vec::new();

    for r in rows.flatten() {
        let (page_number, words_json, bm25_score, text_content) = r;
        let words_data: Vec<WordEntry> = serde_json::from_str(&words_json).unwrap_or_default();
        if !words_data.is_empty() {
            let occs = find_occurrences_on_page(
                &words_data,
                &terms,
                &query_hash,
                doc_id,
                page_number,
                bm25_score,
                &encoded_terms,
                842.0,
            );
            occurrences.extend(occs);
        } else if !text_content.trim().is_empty() {
            // Note Markdown ou document sans coordonnées géométriques
            let occs = search_core::matching::find_occurrences_in_text(
                &text_content,
                &terms,
                &query_hash,
                doc_id,
                page_number,
                bm25_score,
                &encoded_terms,
            );
            occurrences.extend(occs);
        }
    }

    let (total_occurrences, paged_occurrences) = search_core::process_doc_search_results(occurrences, offset, limit);

    Ok(DocSearchResponse {
        doc_id,
        query: query.to_string(),
        total_occurrences,
        occurrences: paged_occurrences,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn setup_titles_db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(&search_core::schema::get_full_schema_sql())
            .unwrap();
        for (id, filename, title) in [
            (1, "pathologie_du_fer.pdf", "219 - Pathologie du fer chez l'adulte et l'enfant Hémochromatose"),
            (2, "cardiologie.pdf", "Livre de Cardiologie"),
            (3, "pneumologie.pdf", "Traité de PNEUMOLOGIE"),
        ] {
            conn.execute(
                "INSERT INTO documents (id, filename, title, status, total_pages, created_at, updated_at) VALUES (?1, ?2, ?3, 'ready', 12, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)",
                rusqlite::params![id, filename, title],
            )
            .unwrap();
        }
        conn
    }

    #[test]
    fn test_title_search_accents_both_sides() {
        let conn = setup_titles_db();
        let resp = search_titles(&conn, "Hémochromatose", None, None, None).unwrap();
        assert_eq!(resp.total_documents, 1, "doit trouver le titre accentué exact");
        assert_eq!(resp.results[0].id, 1);
    }

    #[test]
    fn test_title_search_without_accents() {
        let conn = setup_titles_db();
        let resp = search_titles(&conn, "hemochromatose", None, None, None).unwrap();
        assert_eq!(resp.total_documents, 1, "doit trouver le titre accentué sans accents");
        assert_eq!(resp.results[0].id, 1);
    }

    #[test]
    fn test_title_search_case_insensitive() {
        let conn = setup_titles_db();
        let resp = search_titles(&conn, "pneumologie", None, None, None).unwrap();
        assert_eq!(resp.total_documents, 1);
        assert_eq!(resp.results[0].id, 3);
    }

    #[test]
    fn test_title_search_prefix_truncated() {
        let conn = setup_titles_db();
        let resp = search_titles(&conn, "hemoch", None, None, None).unwrap();
        assert_eq!(resp.total_documents, 1, "préfixe tronqué sans accent");
        assert_eq!(resp.results[0].id, 1);
    }

    #[test]
    fn test_title_search_multi_terms() {
        let conn = setup_titles_db();
        let resp = search_titles(&conn, "pathologie fer", None, None, None).unwrap();
        assert_eq!(resp.total_documents, 1);
    }

    #[test]
    fn test_title_search_no_result() {
        let conn = setup_titles_db();
        let resp = search_titles(&conn, "dermatologie", None, None, None).unwrap();
        assert_eq!(resp.total_documents, 0);
        assert!(resp.results.is_empty());
    }
}

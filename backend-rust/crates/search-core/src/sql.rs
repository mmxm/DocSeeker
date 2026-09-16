use crate::matching::sanitize_fts_query;
use crate::text_norm::normalize_text;

pub const INSERT_OR_REPLACE_DOC_SQL: &str = 
    "INSERT OR REPLACE INTO documents (id, filename, title, file_hash, folder_id, status, total_pages, file_size, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'ready', ?, ?, ?, ?)";

pub const DELETE_DOC_PAGES_SQL: &str = 
    "DELETE FROM pages WHERE doc_id = ?";
pub const DELETE_PAGES_FOR_DOC_SQL: &str = DELETE_DOC_PAGES_SQL;


pub const INSERT_PAGE_SQL: &str = 
    "INSERT INTO pages (doc_id, page_number, text_content, words_json) VALUES (?, ?, ?, ?)";

pub const DELETE_ALL_FOLDERS_SQL: &str = 
    "DELETE FROM folders";

pub const INSERT_OR_REPLACE_FOLDER_SQL: &str = 
    "INSERT OR REPLACE INTO folders (id, name, parent_id, color) VALUES (?, ?, ?, ?)";

pub const DELETE_DOC_SQL: &str = 
    "DELETE FROM documents WHERE id = ?";

pub const GET_CACHED_DOCS_SQL: &str = 
    "SELECT id, file_hash, updated_at FROM documents WHERE status = 'ready'";

pub const GET_SUBFOLDER_IDS_SQL: &str = 
    "WITH RECURSIVE subfolders AS (
        SELECT id FROM folders WHERE id = ?1
        UNION ALL
        SELECT f.id FROM folders f JOIN subfolders s ON f.parent_id = s.id
    )
    SELECT id FROM subfolders;";

pub struct SearchQuerySql {
    pub sql: String,
    pub terms: Vec<String>,
    pub query_hash: String,
}

/// Générateur unique de la requête SQL de recherche FTS5 + BM25 avec scoring Goodnotes
pub fn build_search_query_sql(
    query: &str,
    folder_ids: Option<&[i64]>,
    limit: usize,
    offset: usize,
) -> SearchQuerySql {
    let terms = sanitize_fts_query(query);
    if terms.is_empty() {
        return SearchQuerySql {
            sql: String::new(),
            terms: Vec::new(),
            query_hash: String::new(),
        };
    }

    let query_hash = crate::matching::get_query_hash(&terms);

    let fts_and_query = terms
        .iter()
        .map(|t| format!("{}*", normalize_text(t)))
        .collect::<Vec<_>>()
        .join(" AND ");

    let mut title_conds = Vec::new();
    for t in &terms {
        let norm_t = normalize_text(t);
        if !norm_t.is_empty() {
            let escaped = norm_t.replace('\'', "''");
            title_conds.push(format!(
                "(LOWER(d.filename) LIKE '%{esc}%' OR LOWER(d.title) LIKE '%{esc}%')",
                esc = escaped
            ));
        }
    }
    let title_sql_clause = if title_conds.is_empty() {
        "0".to_string()
    } else {
        title_conds.join(" OR ")
    };

    let folder_filter_sql = if let Some(ids) = folder_ids {
        if ids.is_empty() {
            "AND 0".to_string()
        } else if ids.len() == 1 {
            format!("AND (d.folder_id = {})", ids[0])
        } else {
            let id_strs: Vec<String> = ids.iter().map(|id| id.to_string()).collect();
            format!("AND (d.folder_id IN ({}))", id_strs.join(","))
        }
    } else {
        String::new()
    };


    let sql = format!(
        r#"
        WITH raw_matches AS MATERIALIZED (
            SELECT 
                p.doc_id,
                p.page_number,
                bm25(pages_fts) as page_bm25
            FROM pages_fts
            JOIN pages p ON p.id = pages_fts.rowid
            WHERE pages_fts MATCH '{match_query}'
        ),
        doc_summary AS (
            SELECT 
                count(DISTINCT doc_id) as total_docs,
                count(*) as total_occurrences
            FROM raw_matches r
            JOIN documents d ON d.id = r.doc_id
            WHERE COALESCE(d.status, 'ready') = 'ready' {folder_filter_sql}
        ),
        scored_docs AS (
            SELECT 
                r.doc_id,
                d.filename,
                d.title,
                d.folder_id,
                d.total_pages,
                d.created_at,
                COALESCE(d.updated_at, d.created_at) as updated_at,
                count(*) as matching_pages_count,
                min(r.page_bm25) as best_page_bm25,
                (
                    (CASE WHEN ({title_sql_clause}) THEN 1500.0 ELSE 0.0 END)
                    + (ABS(min(r.page_bm25)) * 100.0)
                    + MIN(count(*) * 5.0, 300.0)
                ) as doc_relevance_score
            FROM raw_matches r
            JOIN documents d ON d.id = r.doc_id
            WHERE COALESCE(d.status, 'ready') = 'ready' {folder_filter_sql}
            GROUP BY r.doc_id
            ORDER BY doc_relevance_score DESC
            LIMIT {limit} OFFSET {offset}
        ),
        ranked_pages AS (
            SELECT 
                rm.doc_id,
                rm.page_number,
                rm.page_bm25,
                sd.doc_relevance_score,
                sd.matching_pages_count,
                RANK() OVER (PARTITION BY rm.doc_id ORDER BY rm.page_bm25 ASC) as page_rank
            FROM raw_matches rm
            JOIN scored_docs sd ON sd.doc_id = rm.doc_id
        )
        SELECT 
            rp.doc_id,
            sd.filename,
            sd.title,
            sd.folder_id,
            sd.total_pages,
            sd.created_at,
            sd.updated_at,
            sd.doc_relevance_score,
            sd.matching_pages_count,
            rp.page_number,
            p.words_json,
            rp.page_bm25,
            COALESCE((SELECT total_docs FROM doc_summary), 0) as total_docs,
            COALESCE((SELECT total_occurrences FROM doc_summary), 0) as total_occurrences
        FROM ranked_pages rp
        JOIN scored_docs sd ON sd.doc_id = rp.doc_id
        JOIN pages p ON p.doc_id = rp.doc_id AND p.page_number = rp.page_number
        WHERE rp.page_rank <= 5
        ORDER BY sd.doc_relevance_score DESC, rp.doc_id, rp.page_bm25 ASC;
        "#,
        match_query = fts_and_query.replace('\'', "''"),
        folder_filter_sql = folder_filter_sql,
        title_sql_clause = title_sql_clause,
        limit = limit,
        offset = offset
    );

    SearchQuerySql {
        sql,
        terms,
        query_hash,
    }
}

/// Requête SQL pour la recherche dans les titres uniquement
pub fn build_title_search_sql(
    query: &str,
    folder_ids: Option<&[i64]>,
    limit: usize,
    offset: usize,
) -> (String, Vec<String>) {
    let terms = sanitize_fts_query(query);
    if terms.is_empty() {
        return (String::new(), Vec::new());
    }

    let where_clause = terms
        .iter()
        .map(|t| {
            let esc = normalize_text(t).replace('\'', "''");
            format!("(LOWER(filename) LIKE '%{esc}%' OR LOWER(title) LIKE '%{esc}%')")
        })
        .collect::<Vec<_>>()
        .join(" AND ");

    let folder_filter = if let Some(ids) = folder_ids {
        if ids.is_empty() {
            "AND 0".to_string()
        } else if ids.len() == 1 {
            format!("AND folder_id = {}", ids[0])
        } else {
            let id_strs: Vec<String> = ids.iter().map(|id| id.to_string()).collect();
            format!("AND folder_id IN ({})", id_strs.join(","))
        }
    } else {
        String::new()
    };

    let sql = format!(
        "SELECT id, filename, title, folder_id, total_pages, created_at, COALESCE(updated_at, created_at) \
         FROM documents \
         WHERE ({where_clause}) AND COALESCE(status, 'ready') = 'ready' {folder_filter} \
         ORDER BY title ASC LIMIT {limit} OFFSET {offset}"
    );

    (sql, terms)
}


/// Requête SQL pour la recherche interne à un document (Split View)
pub fn build_doc_search_sql(doc_id: i64, query: &str) -> (String, Vec<String>, String) {
    let terms = sanitize_fts_query(query);
    if terms.is_empty() {
        return (String::new(), Vec::new(), String::new());
    }

    let query_hash = crate::matching::get_query_hash(&terms);
    let fts_and_query = terms
        .iter()
        .map(|t| format!("{}*", normalize_text(t)))
        .collect::<Vec<_>>()
        .join(" AND ");

    let sql = format!(
        "SELECT p.page_number, p.words_json, bm25(pages_fts) as page_bm25 \
         FROM pages_fts \
         JOIN pages p ON p.id = pages_fts.rowid \
         WHERE pages_fts MATCH '{match_query}' AND p.doc_id = {doc_id} \
         ORDER BY p.page_number ASC",
        match_query = fts_and_query.replace('\'', "''"),
        doc_id = doc_id
    );

    (sql, terms, query_hash)
}

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

/// Miroir léger de la bibliothèque : upsert des métadonnées document sans
/// toucher aux pages (l'indexation FTS reste propre aux docs téléchargés).
/// Ne met PAS status='ready' : un doc miroir sans pages locales ne doit pas
/// passer pour consultable hors-ligne.
pub const UPSERT_DOC_META_SQL: &str =
    "INSERT INTO documents (id, filename, title, folder_id, status, total_pages, file_size, created_at, updated_at) \
     VALUES (?, ?, ?, ?, 'meta-only', ?, ?, COALESCE(?, CURRENT_TIMESTAMP), CURRENT_TIMESTAMP) \
     ON CONFLICT(id) DO UPDATE SET \
       filename = excluded.filename, \
       title = excluded.title, \
       folder_id = excluded.folder_id, \
       total_pages = excluded.total_pages, \
       file_size = excluded.file_size, \
       updated_at = CURRENT_TIMESTAMP \
     WHERE documents.status = 'meta-only'";

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
    let tokens = crate::matching::parse_search_query(query);
    let terms = sanitize_fts_query(query);
    if terms.is_empty() {
        return SearchQuerySql {
            sql: String::new(),
            terms: Vec::new(),
            query_hash: String::new(),
        };
    }

    let query_hash = crate::matching::get_query_hash(&terms);
    let fts_and_query = crate::matching::build_fts5_match_clause(&tokens);
    if fts_and_query.is_empty() {
        return SearchQuerySql {
            sql: String::new(),
            terms: Vec::new(),
            query_hash: String::new(),
        };
    }

    // Boost titre : termes tokenisés ou phrases sur l'index documents_fts
    let mut title_conds = Vec::new();
    for token in &tokens {
        match token {
            crate::matching::SearchToken::Word(w) => {
                let norm = normalize_text(w);
                if !norm.is_empty() {
                    let esc = norm.replace('"', "\"\"");
                    title_conds.push(format!(
                        "d.id IN (SELECT rowid FROM documents_fts WHERE documents_fts MATCH '{{title filename}} : \"{esc}\"*')",
                        esc = esc
                    ));
                }
            }
            crate::matching::SearchToken::Phrase(words) => {
                let norm_words: Vec<String> = words
                    .iter()
                    .map(|w| normalize_text(w))
                    .filter(|w| !w.is_empty())
                    .collect();
                if !norm_words.is_empty() {
                    let esc = norm_words.join(" ").replace('"', "\"\"");
                    title_conds.push(format!(
                        "d.id IN (SELECT rowid FROM documents_fts WHERE documents_fts MATCH '{{title filename}} : \"{esc}\"')",
                        esc = esc
                    ));
                }
            }
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
                COALESCE(d.doc_type, 'pdf') as doc_type,
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
            COALESCE((SELECT total_occurrences FROM doc_summary), 0) as total_occurrences,
            COALESCE(sd.doc_type, 'pdf') as doc_type,
            p.text_content
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
    let tokens = crate::matching::parse_search_query(query);
    let terms = sanitize_fts_query(query);
    if terms.is_empty() {
        return (String::new(), Vec::new());
    }

    // Recherche sur l'index documents_fts : normalisation (casse + accents)
    // assurée par le même tokenizer que le contenu (unicode61 remove_diacritics).
    // Les mots simples sont tokenisés avec préfixe (*), les phrases sont recherchées exactement.
    let where_clause = tokens
        .iter()
        .filter_map(|token| match token {
            crate::matching::SearchToken::Word(w) => {
                let norm = normalize_text(w);
                if norm.is_empty() {
                    None
                } else {
                    let esc = norm.replace('"', "\"\"");
                    Some(format!(
                        "id IN (SELECT rowid FROM documents_fts WHERE documents_fts MATCH '{{title filename}} : \"{esc}\"*')"
                    ))
                }
            }
            crate::matching::SearchToken::Phrase(words) => {
                let norm_words: Vec<String> = words
                    .iter()
                    .map(|w| normalize_text(w))
                    .filter(|w| !w.is_empty())
                    .collect();
                if norm_words.is_empty() {
                    None
                } else {
                    let esc = norm_words.join(" ").replace('"', "\"\"");
                    Some(format!(
                        "id IN (SELECT rowid FROM documents_fts WHERE documents_fts MATCH '{{title filename}} : \"{esc}\"')"
                    ))
                }
            }
        })
        .collect::<Vec<_>>()
        .join(" AND ");

    if where_clause.is_empty() {
        return (String::new(), Vec::new());
    }

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
        "SELECT id, filename, title, folder_id, total_pages, created_at, COALESCE(updated_at, created_at), COALESCE(doc_type, 'pdf') \
         FROM documents \
         WHERE ({where_clause}) AND COALESCE(status, 'ready') = 'ready' {folder_filter} \
         ORDER BY title ASC LIMIT {limit} OFFSET {offset}"
    );

    (sql, terms)
}


/// Requête SQL pour la recherche interne à un document (Split View)
pub fn build_doc_search_sql(doc_id: i64, query: &str) -> (String, Vec<String>, String) {
    let tokens = crate::matching::parse_search_query(query);
    let terms = sanitize_fts_query(query);
    if terms.is_empty() {
        return (String::new(), Vec::new(), String::new());
    }

    let query_hash = crate::matching::get_query_hash(&terms);
    let fts_and_query = crate::matching::build_fts5_match_clause(&tokens);
    if fts_and_query.is_empty() {
        return (String::new(), Vec::new(), String::new());
    }

    let sql = format!(
        "SELECT p.page_number, p.words_json, bm25(pages_fts) as page_bm25, p.text_content \
         FROM pages_fts \
         JOIN pages p ON p.id = pages_fts.rowid \
         WHERE pages_fts MATCH '{match_query}' AND p.doc_id = {doc_id} \
         ORDER BY p.page_number ASC",
        match_query = fts_and_query.replace('\'', "''"),
        doc_id = doc_id
    );

    (sql, terms, query_hash)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn setup_db() -> rusqlite::Connection {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.execute_batch(&crate::schema::get_full_schema_sql()).unwrap();
        for (id, filename, title) in [
            (1, "pathologie_du_fer.pdf", "219 - Pathologie du fer chez l'adulte et l'enfant Hémochromatose"),
            (2, "Cardiologie_2024.pdf", "Livre de Cardiologie"),
            (3, "pneumologie.pdf", "Traité de PNEUMOLOGIE"),
        ] {
            conn.execute(
                "INSERT INTO documents (id, filename, title, status, created_at, updated_at) VALUES (?1, ?2, ?3, 'ready', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)",
                rusqlite::params![id, filename, title],
            )
            .unwrap();
        }
        // Une page indexée pour le doc 1 (contenu accentué) : la recherche
        // globale matche sur le contenu (pages_fts), le boost titre s'y ajoute.
        conn.execute(
            "INSERT INTO pages (doc_id, page_number, text_content) VALUES (1, 1, 'Traitement de l''hémochromatose par saignées chez l''adulte')",
            [],
        )
        .unwrap();
        conn
    }

    fn ids(conn: &rusqlite::Connection, sql: &str) -> Vec<i64> {
        conn.prepare(sql)
            .unwrap()
            .query_map([], |r| r.get::<_, i64>(0))
            .unwrap()
            .flatten()
            .collect()
    }

    #[test]
    fn test_title_search_accents_both_sides() {
        let conn = setup_db();
        let (sql, _) = build_title_search_sql("Hémochromatose", None, 10, 0);
        assert_eq!(ids(&conn, &sql), vec![1], "accents de part et d'autre");
    }

    #[test]
    fn test_title_search_without_accents() {
        let conn = setup_db();
        let (sql, _) = build_title_search_sql("hemochromatose", None, 10, 0);
        assert_eq!(ids(&conn, &sql), vec![1], "sans accents côté requête");
    }

    #[test]
    fn test_title_search_prefix_truncated() {
        let conn = setup_db();
        let (sql, _) = build_title_search_sql("hemoch", None, 10, 0);
        assert_eq!(ids(&conn, &sql), vec![1], "préfixe tronqué sans accent");
    }

    #[test]
    fn test_title_search_case_and_accent_on_query_side() {
        let conn = setup_db();
        let (sql, _) = build_title_search_sql("HÉMoch", None, 10, 0);
        assert_eq!(ids(&conn, &sql), vec![1], "casse + accents tronqués");
    }

    #[test]
    fn test_title_search_multi_terms_and_sql_injection_safe() {
        let conn = setup_db();
        // Multi-termes = AND ; le guillemet est échappé pour FTS5 (pas d'injection)
        let (sql, _) = build_title_search_sql("pathologie fer", None, 10, 0);
        assert_eq!(ids(&conn, &sql), vec![1]);
        let (sql2, _) = build_title_search_sql("hem\"chromatose", None, 10, 0);
        assert_eq!(ids(&conn, &sql2), Vec::<i64>::new());
    }

    #[test]
    fn test_title_search_matches_filename_too() {
        let conn = setup_db();
        let (sql, _) = build_title_search_sql("cardiologie_2024", None, 10, 0);
        assert_eq!(ids(&conn, &sql), vec![2], "filename indexé également");
    }

    #[test]
    fn test_global_search_title_boost_clause() {
        let conn = setup_db();
        let data = build_search_query_sql("hemochromatose", None, 10, 0);
        // La recherche globale ne doit pas échouer avec la clause boost titre
        let results = ids(&conn, &data.sql);
        assert_eq!(results, vec![1], "doc trouvé + boost titre appliqué");
    }

    #[test]
    fn test_search_titles_no_result() {
        let conn = setup_db();
        let (sql, _) = build_title_search_sql("dermatologie", None, 10, 0);
        assert!(ids(&conn, &sql).is_empty());
    }

    #[test]
    fn test_phrase_search_contiguous_vs_disjoint() {
        let conn = setup_db();
        // Doc 10 : contient « normale grossesse » contigu
        conn.execute(
            "INSERT INTO documents (id, filename, title, status, created_at, updated_at) VALUES (10, 'doc10.pdf', 'Doc Contigu', 'ready', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)",
            [],
        ).unwrap();
        conn.execute(
            "INSERT INTO pages (doc_id, page_number, text_content) VALUES (10, 1, 'Observation sur une normale grossesse chez une patiente')",
            [],
        ).unwrap();

        // Doc 20 : contient « grossesse » et « normale » disjoints / ordre inverse
        conn.execute(
            "INSERT INTO documents (id, filename, title, status, created_at, updated_at) VALUES (20, 'doc20.pdf', 'Doc Disjoint', 'ready', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)",
            [],
        ).unwrap();
        conn.execute(
            "INSERT INTO pages (doc_id, page_number, text_content) VALUES (20, 1, 'Suivi de la grossesse avec évolution tout à fait normale')",
            [],
        ).unwrap();

        // 1. Recherche avec phrase exacte entre guillemets : seul doc 10 matche
        let phrase_search = build_search_query_sql("\"normale grossesse\"", None, 10, 0);
        let phrase_results = ids(&conn, &phrase_search.sql);
        assert_eq!(phrase_results, vec![10], "Phrase exacte doit matcher uniquement doc 10");

        // 2. Recherche sans guillemets : les deux documents matchent
        let unquoted_search = build_search_query_sql("normale grossesse", None, 10, 0);
        let mut unquoted_results = ids(&conn, &unquoted_search.sql);
        unquoted_results.sort();
        assert_eq!(unquoted_results, vec![10, 20], "Sans guillemets, les deux docs matchent");

        // 3. Phrase inversée entre guillemets "grossesse normale" : ni doc 10 ni doc 20 ne matche
        let rev_phrase_search = build_search_query_sql("\"grossesse normale\"", None, 10, 0);
        let rev_results = ids(&conn, &rev_phrase_search.sql);
        assert!(rev_results.is_empty(), "Phrase inversée ne doit pas matcher 'normale grossesse'");
    }
}

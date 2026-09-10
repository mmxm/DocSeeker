use std::collections::{HashMap, HashSet};
use rusqlite::{params, Connection, Result};
use regex::Regex;
use lazy_static::lazy_static;
use sha2::{Digest, Sha256};

use crate::db::text_norm::normalize_text;
use super::types::{DocSearchResponse, DocumentSearchResult, OccurrenceResult, SearchResponse, WordEntry};

const MAX_OCCURRENCES_PER_DOC: usize = 25;

lazy_static! {
    static ref RE_WORDS: Regex = Regex::new(r"[\w]+").unwrap();
    static ref RE_PUNCT_BOUNDARIES: Regex = Regex::new(r"^\W+|\W+$").unwrap();
}

pub fn sanitize_fts_query(query: &str) -> Vec<String> {
    RE_WORDS
        .find_iter(query)
        .map(|m| m.as_str().to_string())
        .filter(|w| !w.trim().is_empty())
        .collect()
}

pub fn get_query_hash(query_terms: &[String]) -> String {
    let mut norm_terms: Vec<String> = query_terms
        .iter()
        .filter(|t| t.trim().len() > 1)
        .map(|t| normalize_text(t))
        .collect();
    norm_terms.sort();

    let joined = format!("v6_{}", norm_terms.join("_"));
    let mut hasher = Sha256::new();
    hasher.update(joined.as_bytes());
    let hex_str = hex::encode(hasher.finalize());
    hex_str.chars().take(8).collect()
}

pub fn match_word(norm_w: &str, term: &str) -> bool {
    if norm_w.is_empty() || term.is_empty() {
        return false;
    }
    // 1. Correspondance exacte ou préfixe direct (>95% des cas)
    if norm_w == term || norm_w.starts_with(term) {
        return true;
    }
    if norm_w.chars().all(|c| c.is_alphanumeric()) {
        return term.len() >= 4 && norm_w.contains(term);
    }

    // 2. Nettoyage de la ponctuation entourant le mot
    let clean_w = RE_PUNCT_BOUNDARIES.replace_all(norm_w, "");
    if clean_w == term || clean_w.starts_with(term) {
        return true;
    }

    // 3. Décomposition en sous-mots
    for sub in RE_WORDS.find_iter(norm_w) {
        let sub_str = sub.as_str();
        if sub_str == term || sub_str.starts_with(term) {
            return true;
        }
        if term.len() >= 4 && sub_str.contains(term) {
            return true;
        }
    }

    if term.len() >= 4 && clean_w.contains(term) {
        return true;
    }
    false
}

#[derive(Clone, Debug)]
struct RawMatchedWord {
    rect: [f64; 4],
    highlight_rect: [f64; 4],
    word: String,
    block_no: i64,
    line_no: i64,
    matched_terms: Vec<String>,
}

pub fn find_occurrences_on_page(
    words_data: &[WordEntry],
    query_terms: &[String],
    query_hash: &str,
    doc_id: i64,
    page_number: i64,
    bm25_score: f64,
    encoded_terms: &str,
    page_height: f64,
) -> Vec<OccurrenceResult> {
    let norm_terms: Vec<String> = query_terms
        .iter()
        .filter(|t| t.trim().len() > 1)
        .map(|t| normalize_text(t))
        .collect();

    if norm_terms.is_empty() {
        return Vec::new();
    }

    let mut matched_words: Vec<RawMatchedWord> = Vec::new();

    // words_data format: WordEntry(x0, y0, x1, y1, word, block_no, line_no)
    for w in words_data {
        let WordEntry(x0, y0, x1, y1, ref word, block_no, line_no) = *w;
        let norm_w = normalize_text(word);
        let mut matched_terms_in_word: Vec<String> = Vec::new();
        let mut min_pos = usize::MAX;
        let mut max_end_pos = 0;

        for term in &norm_terms {
            if match_word(&norm_w, term) {
                matched_terms_in_word.push(term.clone());
                if let Some(pos) = norm_w.find(term.as_str()) {
                    let char_pos = norm_w[..pos].chars().count();
                    let char_len = term.chars().count();
                    min_pos = min_pos.min(char_pos);
                    max_end_pos = max_end_pos.max(char_pos + char_len);
                }
            }
        }

        if !matched_terms_in_word.is_empty() {
            let total_chars = norm_w.chars().count().max(1);
            // Si plusieurs termes de la requête correspondent (ex: "extra" et "utérine" dans "extra-utérine")
            // ou si les termes couvrent la quasi-totalité du mot, surligner tout le mot [x0, x1]
            let (sub_x0, sub_x1) = if matched_terms_in_word.len() > 1
                || (min_pos == 0 && max_end_pos >= total_chars.saturating_sub(2))
                || min_pos == usize::MAX
            {
                (x0, x1)
            } else {
                let total_w = (x1 - x0).max(0.0);
                let char_count = total_chars as f64;
                (
                    x0 + total_w * (min_pos as f64 / char_count),
                    (x0 + total_w * (max_end_pos as f64 / char_count)).min(x1),
                )
            };

            matched_words.push(RawMatchedWord {
                rect: [x0, y0, x1, y1],
                highlight_rect: [sub_x0, y0, sub_x1, y1],
                word: word.clone(),
                block_no,
                line_no,
                matched_terms: matched_terms_in_word,
            });
        }
    }

    if matched_words.is_empty() {
        return Vec::new();
    }

    // Regrouper les mots contigus d'une même expression sur la même ligne
    let mut occurrences: Vec<Vec<RawMatchedWord>> = Vec::new();
    let mut current_occ: Vec<RawMatchedWord> = vec![matched_words[0].clone()];

    for next_w in matched_words.into_iter().skip(1) {
        let prev_w = current_occ.last().unwrap();
        let horizontal_diff = next_w.rect[0] - prev_w.rect[2];

        if next_w.block_no == prev_w.block_no
            && next_w.line_no == prev_w.line_no
            && horizontal_diff >= 0.0
            && horizontal_diff < 25.0
        {
            current_occ.push(next_w);
        } else {
            occurrences.push(current_occ);
            current_occ = vec![next_w];
        }
    }
    if !current_occ.is_empty() {
        occurrences.push(current_occ);
    }

    let mut results = Vec::new();
    for (occ_idx, group) in occurrences.into_iter().enumerate() {
        let x0 = group.iter().map(|w| w.rect[0]).fold(f64::INFINITY, f64::min);
        let y0 = group.iter().map(|w| w.rect[1]).fold(f64::INFINITY, f64::min);
        let x1 = group.iter().map(|w| w.rect[2]).fold(f64::NEG_INFINITY, f64::max);
        let y1 = group.iter().map(|w| w.rect[3]).fold(f64::NEG_INFINITY, f64::max);

        let occ_text = group.iter().map(|w| w.word.as_str()).collect::<Vec<_>>().join(" ");
        let mut distinct_terms = HashSet::new();
        for w in &group {
            for t in &w.matched_terms {
                distinct_terms.insert(t.clone());
            }
        }

        let y_ratio = if page_height > 0.0 {
            (y0 / page_height).clamp(0.0, 1.0)
        } else {
            0.0
        };

        let crop_url = format!(
            "/api/crop/{}/{}/{}?h={}&terms={}",
            doc_id, page_number, occ_idx, query_hash, encoded_terms
        );
        let highlight_rects: Vec<[f64; 4]> = group.iter().map(|w| w.highlight_rect).collect();

        results.push(OccurrenceResult {
            page_number,
            occ_id: occ_idx,
            crop_url,
            text_snippet: occ_text,
            distinct_terms_count: distinct_terms.len(),
            matched_terms: distinct_terms.into_iter().collect(),
            y_ratio: (y_ratio * 1000.0).round() / 1000.0,
            y_pos: (y0 * 10.0).round() / 10.0,
            rect: [x0, y0, x1, y1],
            highlight_rects,
            bm25_score,
        });
    }

    results
}

pub fn get_folder_and_subfolder_ids(conn: &Connection, folder_id: i64) -> Vec<i64> {
    let sql = r#"
        WITH RECURSIVE subfolders AS (
            SELECT id FROM folders WHERE id = ?1
            UNION ALL
            SELECT f.id FROM folders f JOIN subfolders s ON f.parent_id = s.id
        )
        SELECT id FROM subfolders;
    "#;

    let mut stmt = match conn.prepare(sql) {
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

    let allowed_folder_ids: Option<HashSet<i64>> = folder_id.map(|fid| {
        get_folder_and_subfolder_ids(conn, fid).into_iter().collect()
    });

    let mut stmt = conn.prepare(
        "SELECT id, filename, title, folder_id, total_pages, created_at, COALESCE(updated_at, created_at) AS updated_at \
         FROM documents WHERE COALESCE(status, 'ready') = 'ready'",
    )?;

    let norm_terms: Vec<String> = terms.iter().map(|t| normalize_text(t)).collect();
    let mut results = Vec::new();

    let rows = stmt.query_map([], |row| {
        Ok((
            row.get::<_, i64>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, Option<String>>(2)?.unwrap_or_default(),
            row.get::<_, Option<i64>>(3)?,
            row.get::<_, i64>(4)?,
            row.get::<_, String>(5)?,
            row.get::<_, String>(6)?,
        ))
    })?;

    for r in rows.flatten() {
        let (id, filename, title, doc_folder_id, total_pages, created_at, updated_at) = r;

        if let Some(ref allowed) = allowed_folder_ids {
            if let Some(fid) = doc_folder_id {
                if !allowed.contains(&fid) {
                    continue;
                }
            } else {
                continue;
            }
        }

        let title_norm = normalize_text(&title);
        let filename_norm = normalize_text(&filename);

        let mut matched_count = 0;
        for t in &norm_terms {
            if term_matches_text(t, &title_norm) || term_matches_text(t, &filename_norm) {
                matched_count += 1;
            }
        }

        if matched_count == norm_terms.len() {
            let bonus = if norm_terms.iter().any(|t| t == &title_norm) { 100.0 } else { 0.0 };
            results.push(DocumentSearchResult {
                id,
                filename,
                title,
                folder_id: doc_folder_id,
                total_pages,
                created_at,
                updated_at,
                cover_url: format!("/api/cover/{}", id),
                vignettes: Vec::new(),
                occurrences_by_page: Vec::new(),
                total_occurrences: 0,
                relevance_score: 5000.0 + bonus,
                matched_all_terms: true,
            });
        }
    }

    results.sort_by(|a, b| b.relevance_score.partial_cmp(&a.relevance_score).unwrap_or(std::cmp::Ordering::Equal));

    let total_documents = results.len();
    let total_pages = if total_documents > 0 && page_size > 0 {
        total_documents.div_ceil(page_size)
    } else {
        0
    };
    let has_more = current_offset + page_size < total_documents;
    let page = if page_size > 0 { (current_offset / page_size) + 1 } else { 1 };

    let paged_results = if current_offset < total_documents {
        results.into_iter().skip(current_offset).take(page_size).collect()
    } else {
        Vec::new()
    };

    Ok(SearchResponse {
        query: query.to_string(),
        query_hash: get_query_hash(&terms),
        total_documents,
        total_occurrences: 0,
        results: paged_results,
        page,
        limit: page_size,
        total_pages,
        has_more,
    })
}

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

    let allowed_folder_ids: Option<HashSet<i64>> = folder_id.map(|fid| {
        get_folder_and_subfolder_ids(conn, fid).into_iter().collect()
    });

    let query_hash = get_query_hash(&terms);
    let encoded_terms = urlencoding::encode(&terms.join(",")).to_string();

    let fts_and_query = terms
        .iter()
        .map(|t| format!("{}*", normalize_text(t)))
        .collect::<Vec<_>>()
        .join(" AND ");

    let fts_or_query = terms
        .iter()
        .map(|t| format!("{}*", normalize_text(t)))
        .collect::<Vec<_>>()
        .join(" OR ");

    let sql = r#"
        SELECT 
            p.doc_id,
            p.page_number,
            p.words_json,
            d.filename,
            d.title,
            d.folder_id,
            d.total_pages,
            d.created_at,
            COALESCE(d.updated_at, d.created_at) as updated_at,
            bm25(pages_fts) as bm25_score
        FROM pages_fts
        JOIN pages p ON p.id = pages_fts.rowid
        JOIN documents d ON d.id = p.doc_id
        WHERE pages_fts MATCH ?1
        ORDER BY bm25_score ASC;
    "#;

    let mut stmt = conn.prepare(sql)?;

    struct GroupedDoc {
        id: i64,
        filename: String,
        title: String,
        folder_id: Option<i64>,
        total_pages: i64,
        created_at: String,
        updated_at: String,
        best_bm25: f64,
        matched_all_terms: bool,
        all_occurrences: Vec<OccurrenceResult>,
    }

    let mut doc_groups: HashMap<i64, GroupedDoc> = HashMap::new();
    let mut matched_doc_ids_and: HashSet<i64> = HashSet::new();
    let mut seen_keys: HashSet<(i64, i64)> = HashSet::new();
    let mut total_rows_and = 0usize;

    {
        let mut rows = stmt.query(params![fts_and_query])?;
        while let Some(row) = rows.next()? {
            let doc_id: i64 = row.get(0)?;
            let page_number: i64 = row.get(1)?;
            let doc_folder_id: Option<i64> = row.get(5)?;

            if let Some(ref allowed) = allowed_folder_ids {
                if let Some(fid) = doc_folder_id {
                    if !allowed.contains(&fid) {
                        continue;
                    }
                } else {
                    continue;
                }
            }

            let words_json: String = row.get(2)?;
            let filename: String = row.get(3)?;
            let title: String = row.get::<_, Option<String>>(4)?.unwrap_or_default();
            let total_pages: i64 = row.get(6)?;
            let created_at: String = row.get(7)?;
            let updated_at: String = row.get(8)?;
            let bm25_score: f64 = row.get(9)?;

            seen_keys.insert((doc_id, page_number));
            matched_doc_ids_and.insert(doc_id);
            total_rows_and += 1;

            let entry = doc_groups.entry(doc_id).or_insert_with(|| GroupedDoc {
                id: doc_id,
                filename,
                title,
                folder_id: doc_folder_id,
                total_pages,
                created_at,
                updated_at,
                best_bm25: bm25_score,
                matched_all_terms: true,
                all_occurrences: Vec::new(),
            });

            if bm25_score < entry.best_bm25 {
                entry.best_bm25 = bm25_score;
            }

            let words_data: Vec<WordEntry> = serde_json::from_str(&words_json).unwrap_or_default();
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
            entry.all_occurrences.extend(occs);
        }
    }

    // Fallback OR si moins de 8 résultats et plusieurs termes
    if total_rows_and < 8 && terms.len() > 1 {
        let mut rows = stmt.query(params![fts_or_query])?;
        while let Some(row) = rows.next()? {
            let doc_id: i64 = row.get(0)?;
            let page_number: i64 = row.get(1)?;
            let key = (doc_id, page_number);
            if seen_keys.contains(&key) {
                continue;
            }

            let doc_folder_id: Option<i64> = row.get(5)?;
            if let Some(ref allowed) = allowed_folder_ids {
                if let Some(fid) = doc_folder_id {
                    if !allowed.contains(&fid) {
                        continue;
                    }
                } else {
                    continue;
                }
            }

            seen_keys.insert(key);

            let words_json: String = row.get(2)?;
            let filename: String = row.get(3)?;
            let title: String = row.get::<_, Option<String>>(4)?.unwrap_or_default();
            let total_pages: i64 = row.get(6)?;
            let created_at: String = row.get(7)?;
            let updated_at: String = row.get(8)?;
            let bm25_score: f64 = row.get(9)?;

            let entry = doc_groups.entry(doc_id).or_insert_with(|| GroupedDoc {
                id: doc_id,
                filename,
                title,
                folder_id: doc_folder_id,
                total_pages,
                created_at,
                updated_at,
                best_bm25: bm25_score,
                matched_all_terms: matched_doc_ids_and.contains(&doc_id),
                all_occurrences: Vec::new(),
            });

            if bm25_score < entry.best_bm25 {
                entry.best_bm25 = bm25_score;
            }

            let words_data: Vec<WordEntry> = serde_json::from_str(&words_json).unwrap_or_default();
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
            entry.all_occurrences.extend(occs);
        }
    }

    if doc_groups.is_empty() {
        return Ok(SearchResponse {
            query: query.to_string(),
            query_hash,
            total_documents: 0,
            total_occurrences: 0,
            results: Vec::new(),
            page: 1,
            limit: page_size,
            total_pages: 0,
            has_more: false,
        });
    }

    let mut final_results = Vec::new();
    let mut total_matches_count = 0;

    for (_doc_id, mut doc_info) in doc_groups {
        let total_doc_occs = doc_info.all_occurrences.len();
        total_matches_count += total_doc_occs;

        let mut doc_matched_terms = HashSet::new();
        for o in &doc_info.all_occurrences {
            for mt in &o.matched_terms {
                doc_matched_terms.insert(mt.clone());
            }
        }
        if terms.len() > 1 && doc_matched_terms.len() >= terms.len() {
            doc_info.matched_all_terms = true;
        }

        // Ruban horizontal (les 25 meilleures occurrences au départ, scrollable pour le reste)
        let mut relevant_ribbon = doc_info.all_occurrences.clone();
        relevant_ribbon.sort_by(|a, b| {
            b.distinct_terms_count
                .cmp(&a.distinct_terms_count)
                .then_with(|| a.bm25_score.partial_cmp(&b.bm25_score).unwrap_or(std::cmp::Ordering::Equal))
                .then_with(|| a.page_number.cmp(&b.page_number))
        });
        relevant_ribbon.truncate(MAX_OCCURRENCES_PER_DOC);

        // Split view & parcours exhaustif : 100% ordonnées chronologiquement
        let mut chronological_occs = doc_info.all_occurrences;
        chronological_occs.sort_by(|a, b| {
            a.page_number.cmp(&b.page_number).then_with(|| a.occ_id.cmp(&b.occ_id))
        });

        let mut relevance_score = 0.0;
        if doc_info.matched_all_terms {
            relevance_score += 1000.0;
        }
        relevance_score += total_doc_occs as f64 * 10.0;
        relevance_score += doc_info.best_bm25.abs() * 100.0;

        final_results.push(DocumentSearchResult {
            id: doc_info.id,
            filename: doc_info.filename,
            title: doc_info.title,
            folder_id: doc_info.folder_id,
            total_pages: doc_info.total_pages,
            created_at: doc_info.created_at,
            updated_at: doc_info.updated_at,
            cover_url: format!("/api/cover/{}", doc_info.id),
            vignettes: relevant_ribbon,
            occurrences_by_page: chronological_occs,
            total_occurrences: total_doc_occs,
            relevance_score: (relevance_score * 100.0).round() / 100.0,
            matched_all_terms: doc_info.matched_all_terms,
        });
    }

    final_results.sort_by(|a, b| b.relevance_score.partial_cmp(&a.relevance_score).unwrap_or(std::cmp::Ordering::Equal));

    let total_documents = final_results.len();
    let total_pages = if total_documents > 0 && page_size > 0 {
        total_documents.div_ceil(page_size)
    } else {
        0
    };
    let has_more = current_offset + page_size < total_documents;
    let page = if page_size > 0 { (current_offset / page_size) + 1 } else { 1 };

    let paged_results = if current_offset < total_documents {
        final_results.into_iter().skip(current_offset).take(page_size).collect()
    } else {
        Vec::new()
    };

    Ok(SearchResponse {
        query: query.to_string(),
        query_hash,
        total_documents,
        total_occurrences: total_matches_count,
        results: paged_results,
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
) -> Result<DocSearchResponse> {
    let terms = sanitize_fts_query(query);
    if terms.is_empty() {
        return Ok(DocSearchResponse {
            doc_id,
            query: query.to_string(),
            total_occurrences: 0,
            occurrences: Vec::new(),
        });
    }

    let query_hash = get_query_hash(&terms);
    let encoded_terms = urlencoding::encode(&terms.join(",")).to_string();
    let fts_and_query = terms
        .iter()
        .map(|t| format!("{}*", normalize_text(t)))
        .collect::<Vec<_>>()
        .join(" AND ");

    let sql = r#"
        SELECT 
            p.page_number,
            p.words_json,
            bm25(pages_fts) as bm25_score
        FROM pages_fts
        JOIN pages p ON p.id = pages_fts.rowid
        WHERE p.doc_id = ?1 AND pages_fts MATCH ?2
        ORDER BY p.page_number ASC;
    "#;

    let mut stmt = conn.prepare(sql)?;
    let rows = stmt.query_map(params![doc_id, fts_and_query], |row| {
        Ok((
            row.get::<_, i64>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, f64>(2)?,
        ))
    })?;

    let mut occurrences = Vec::new();
    for r in rows.flatten() {
        let (page_number, words_json, bm25_score) = r;
        let words_data: Vec<WordEntry> = serde_json::from_str(&words_json).unwrap_or_default();
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
    }

    Ok(DocSearchResponse {
        doc_id,
        query: query.to_string(),
        total_occurrences: occurrences.len(),
        occurrences,
    })
}

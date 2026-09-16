use std::collections::HashSet;
use regex::Regex;
use lazy_static::lazy_static;
use sha2::{Digest, Sha256};

use crate::text_norm::normalize_text;
use crate::types::{OccurrenceResult, WordEntry};

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
    if norm_w == term || norm_w.starts_with(term) {
        return true;
    }
    if norm_w.chars().all(|c| c.is_alphanumeric()) {
        return term.len() >= 4 && norm_w.contains(term);
    }

    let clean_w = RE_PUNCT_BOUNDARIES.replace_all(norm_w, "");
    if clean_w == term || clean_w.starts_with(term) {
        return true;
    }

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
        let font_size = group
            .iter()
            .map(|w| (w.rect[3] - w.rect[1]).max(0.0))
            .fold(0.0, f64::max);

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
            font_size: (font_size * 10.0).round() / 10.0,
        });
    }

    results
}

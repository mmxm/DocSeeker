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

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SearchToken {
    Word(String),
    Phrase(Vec<String>),
}

pub fn parse_search_query(query: &str) -> Vec<SearchToken> {
    let mut tokens = Vec::new();
    let mut in_quote = false;
    let mut quote_opener = '"';
    let mut buf = String::new();

    let is_quote = |c: char| matches!(c, '"' | '“' | '”' | '«' | '»');
    let is_quote_pair = |open: char, close: char| match open {
        '«' => close == '»',
        '“' => close == '”' || close == '“',
        _ => close == open || matches!(close, '"' | '“' | '”' | '«' | '»'),
    };

    for c in query.chars() {
        if !in_quote {
            if is_quote(c) {
                for w in RE_WORDS.find_iter(&buf) {
                    let s = w.as_str().trim();
                    if !s.is_empty() {
                        tokens.push(SearchToken::Word(s.to_string()));
                    }
                }
                buf.clear();
                in_quote = true;
                quote_opener = c;
            } else {
                buf.push(c);
            }
        } else {
            if is_quote_pair(quote_opener, c) {
                let words: Vec<String> = RE_WORDS
                    .find_iter(&buf)
                    .map(|m| m.as_str().trim().to_string())
                    .filter(|s| !s.is_empty())
                    .collect();
                if !words.is_empty() {
                    tokens.push(SearchToken::Phrase(words));
                }
                buf.clear();
                in_quote = false;
            } else {
                buf.push(c);
            }
        }
    }

    if in_quote {
        let words: Vec<String> = RE_WORDS
            .find_iter(&buf)
            .map(|m| m.as_str().trim().to_string())
            .filter(|s| !s.is_empty())
            .collect();
        if !words.is_empty() {
            tokens.push(SearchToken::Phrase(words));
        }
    } else {
        for w in RE_WORDS.find_iter(&buf) {
            let s = w.as_str().trim();
            if !s.is_empty() {
                tokens.push(SearchToken::Word(s.to_string()));
            }
        }
    }

    tokens
}

pub fn build_fts5_match_clause(tokens: &[SearchToken]) -> String {
    build_fts5_match_clause_with_vocab(tokens, None)
}

pub fn build_fts5_match_clause_with_vocab(
    tokens: &[SearchToken],
    vocab_map: Option<&std::collections::HashMap<String, Vec<String>>>,
) -> String {
    let clauses: Vec<String> = tokens
        .iter()
        .filter_map(|t| match t {
            SearchToken::Word(w) => {
                let norm = normalize_text(w);
                if norm.is_empty() {
                    None
                } else if let Some(map) = vocab_map {
                    if let Some(subwords) = map.get(&norm) {
                        if !subwords.is_empty() {
                            let mut all_terms = vec![format!("{}*", norm)];
                            for sw in subwords {
                                if sw != &norm && !sw.starts_with(&norm) {
                                    all_terms.push(format!("{}*", sw));
                                }
                            }
                            if all_terms.len() > 1 {
                                Some(format!("({})", all_terms.join(" OR ")))
                            } else {
                                Some(format!("{}*", norm))
                            }
                        } else {
                            Some(format!("{}*", norm))
                        }
                    } else {
                        Some(format!("{}*", norm))
                    }
                } else {
                    Some(format!("{}*", norm))
                }
            }
            SearchToken::Phrase(words) => {
                let norm_words: Vec<String> = words
                    .iter()
                    .map(|w| normalize_text(w))
                    .filter(|w| !w.is_empty())
                    .collect();
                if norm_words.is_empty() {
                    None
                } else {
                    let phrase_str = norm_words.join(" ").replace('"', "\"\"");
                    Some(format!("\"{}\"", phrase_str))
                }
            }
        })
        .collect();

    clauses.join(" AND ")
}

/// Construit un motif SQLite GLOB insensible à la casse et aux accents français.
/// Ex: "calce" -> "[cC][aAàáâãäåAÀÁÂÃÄÅ][lL][cC][eéèêëEÉÈÊË]"
pub fn build_glob_pattern(term: &str) -> String {
    let norm = normalize_text(term);
    if norm.is_empty() {
        return String::new();
    }
    let mut pattern = String::with_capacity(norm.len() * 16);
    for ch in norm.chars() {
        match ch {
            'a' => pattern.push_str("[aàáâãäåAÀÁÂÃÄÅ]"),
            'e' => pattern.push_str("[eéèêëEÉÈÊË]"),
            'i' => pattern.push_str("[iìíîïIÌÍÎÏ]"),
            'o' => pattern.push_str("[oòóôõöOÒÓÔÕÖ]"),
            'u' => pattern.push_str("[uùúûüUÙÚÛÜ]"),
            'c' => pattern.push_str("[cçCÇ]"),
            'n' => pattern.push_str("[nñNÑ]"),
            '\'' => pattern.push_str("''"),
            '*' | '?' | '[' | ']' => {
                pattern.push('[');
                pattern.push(ch);
                pattern.push(']');
            }
            c if c.is_alphabetic() => {
                pattern.push('[');
                for lower in c.to_lowercase() {
                    pattern.push(lower);
                }
                for upper in c.to_uppercase() {
                    pattern.push(upper);
                }
                pattern.push(']');
            }
            c => {
                pattern.push(c);
            }
        }
    }
    pattern
}

pub fn sanitize_fts_query(query: &str) -> Vec<String> {
    parse_search_query(query)
        .into_iter()
        .map(|token| match token {
            SearchToken::Word(w) => w,
            SearchToken::Phrase(words) => words.join(" "),
        })
        .filter(|t| !t.trim().is_empty())
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

    // Pré-fusion des micro-fragments de mots (coupures de glyphes/styles PDF où gap <= 2.2px)
    let mut merged_words_data: Vec<WordEntry> = Vec::with_capacity(words_data.len());
    for w in words_data {
        if let Some(prev) = merged_words_data.last_mut() {
            let WordEntry(_prev_x0, ref mut prev_y0, ref mut prev_x1, ref mut prev_y1, ref mut prev_word, _prev_block, _prev_line) = *prev;
            let WordEntry(next_x0, next_y0, next_x1, next_y1, ref next_word, _next_block, _next_line) = *w;
            let gap = next_x0 - *prev_x1;
            let y_diff = (next_y0 - *prev_y0).abs();
            let is_not_punct = !matches!(prev_word.as_str(), ":" | "-" | "/" | "+" | "." | "," | ";" | "!" | "?")
                && !matches!(next_word.as_str(), ":" | "-" | "/" | "+" | "." | "," | ";" | "!" | "?");

            if y_diff < 3.5 && gap >= -1.0 && gap <= 2.5 && is_not_punct {
                *prev_x1 = next_x1;
                *prev_y0 = prev_y0.min(next_y0);
                *prev_y1 = prev_y1.max(next_y1);
                prev_word.push_str(next_word);
                continue;
            }
        }
        merged_words_data.push(w.clone());
    }

    let mut phrase_terms: Vec<(String, Vec<String>)> = Vec::new();
    let mut word_terms: Vec<String> = Vec::new();

    for t in &norm_terms {
        if t.contains(' ') {
            let p_words: Vec<String> = t.split_whitespace().map(|s| s.to_string()).collect();
            if !p_words.is_empty() {
                phrase_terms.push((t.clone(), p_words));
            }
        } else {
            word_terms.push(t.clone());
        }
    }

    let mut phrase_matches_by_word_idx: Vec<Vec<String>> = vec![Vec::new(); merged_words_data.len()];

    for (phrase_str, p_words) in &phrase_terms {
        let p_len = p_words.len();
        if merged_words_data.len() < p_len {
            continue;
        }
        for i in 0..=(merged_words_data.len() - p_len) {
            let mut matches = true;
            for (k, target_word) in p_words.iter().enumerate() {
                let norm_w = normalize_text(&merged_words_data[i + k].4);
                if !match_word(&norm_w, target_word) {
                    matches = false;
                    break;
                }
                if k > 0 {
                    let prev = &merged_words_data[i + k - 1];
                    let curr = &merged_words_data[i + k];
                    let horizontal_diff = curr.0 - prev.2;
                    let vertical_overlap = (curr.3.min(prev.3) - curr.1.max(prev.1)).max(0.0);
                    let min_height = (curr.3 - curr.1).min(prev.3 - prev.1);
                    let is_same_line = (curr.6 == prev.6)
                        || (min_height > 0.0 && vertical_overlap / min_height >= 0.6);
                    if !is_same_line || horizontal_diff < -2.0 || horizontal_diff > 35.0 {
                        matches = false;
                        break;
                    }
                }
            }
            if matches {
                for k in 0..p_len {
                    phrase_matches_by_word_idx[i + k].push(phrase_str.clone());
                }
            }
        }
    }

    let mut matched_words: Vec<RawMatchedWord> = Vec::new();

    for (idx, w) in merged_words_data.iter().enumerate() {
        let WordEntry(x0, y0, x1, y1, ref word, _block_no, line_no) = *w;
        let norm_w = normalize_text(word);
        let mut matched_terms_in_word: Vec<String> = Vec::new();
        let mut min_pos = usize::MAX;
        let mut max_end_pos = 0;

        for p_str in &phrase_matches_by_word_idx[idx] {
            if !matched_terms_in_word.contains(p_str) {
                matched_terms_in_word.push(p_str.clone());
            }
            min_pos = 0;
            max_end_pos = norm_w.chars().count();
        }

        for term in &word_terms {
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

        let vertical_overlap = (next_w.rect[3].min(prev_w.rect[3]) - next_w.rect[1].max(prev_w.rect[1])).max(0.0);
        let min_height = (next_w.rect[3] - next_w.rect[1]).min(prev_w.rect[3] - prev_w.rect[1]);
        let is_same_visual_line = (next_w.line_no == prev_w.line_no)
            || (min_height > 0.0 && vertical_overlap / min_height >= 0.6);

        if is_same_visual_line
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

pub fn find_occurrences_in_text(
    text: &str,
    query_terms: &[String],
    query_hash: &str,
    doc_id: i64,
    page_number: i64,
    bm25_score: f64,
    encoded_terms: &str,
) -> Vec<OccurrenceResult> {
    let norm_terms: Vec<String> = query_terms
        .iter()
        .filter(|t| t.trim().len() > 1)
        .map(|t| normalize_text(t))
        .collect();

    if norm_terms.is_empty() || text.is_empty() {
        return Vec::new();
    }

    let mut results = Vec::new();
    let mut occ_idx = 0;
    let lines: Vec<&str> = text.lines().collect();
    let total_len = text.len().max(1) as f64;
    let mut current_offset = 0;

    for (line_idx, line) in lines.iter().enumerate() {
        let norm_line = normalize_text(line);
        if norm_line.trim().is_empty() {
            current_offset += line.len() + 1;
            continue;
        }

        let mut matched_terms_in_line = Vec::new();
        for term in &norm_terms {
            if match_word(&norm_line, term) || norm_line.contains(term.as_str()) {
                matched_terms_in_line.push(term.clone());
            }
        }

        if !matched_terms_in_line.is_empty() {
            matched_terms_in_line.sort();
            matched_terms_in_line.dedup();

            let y_ratio = (current_offset as f64 / total_len).clamp(0.0, 1.0);

            // Extrait textuel enrichi : ligne du mot-clé + les 2 lignes NON VIDES les
            // plus proches au-dessus et en dessous (on saute les lignes vides, sinon le
            // contexte disparaît dès qu'une ligne séparatrice existe). Le client rend
            // cet extrait en vignette HTML native pour les notes Markdown — aucun crop
            // image : économie de bande passante et de CPU côté serveur.
            let truncate = |s: &str, max: usize| -> String {
                if s.chars().count() <= max {
                    s.to_string()
                } else {
                    let cut: String = s.chars().take(max).collect();
                    format!("{}…", cut.trim_end())
                }
            };
            let mut above: Vec<&str> = Vec::new();
            let mut li = line_idx;
            while li > 0 && above.len() < 2 {
                li -= 1;
                let t = lines[li].trim();
                if !t.is_empty() {
                    above.push(t);
                }
            }
            above.reverse();
            let mut below: Vec<&str> = Vec::new();
            let mut li = line_idx;
            while li + 1 < lines.len() && below.len() < 2 {
                li += 1;
                let t = lines[li].trim();
                if !t.is_empty() {
                    below.push(t);
                }
            }
            let mut ctx_parts: Vec<String> = above.iter().map(|t| truncate(t, 120)).collect();
            ctx_parts.push(truncate(lines[line_idx].trim(), 200));
            ctx_parts.extend(below.iter().map(|t| truncate(t, 120)));
            let snippet = ctx_parts.join("\n");

            let crop_url = format!(
                "/api/crop/{}/{}/{}?h={}&terms={}",
                doc_id, page_number, occ_idx, query_hash, encoded_terms
            );

            results.push(OccurrenceResult {
                page_number,
                occ_id: occ_idx,
                crop_url,
                text_snippet: snippet,
                distinct_terms_count: matched_terms_in_line.len(),
                matched_terms: matched_terms_in_line,
                y_ratio: (y_ratio * 1000.0).round() / 1000.0,
                y_pos: (line_idx as f64 * 20.0),
                rect: [0.0, (line_idx as f64 * 20.0), 500.0, ((line_idx + 1) as f64 * 20.0)],
                highlight_rects: vec![],
                bm25_score,
                font_size: 14.0,
            });

            occ_idx += 1;
        }

        current_offset += line.len() + 1;
    }

    results
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_search_query_simple_and_quoted() {
        let tokens = parse_search_query("normale grossesse");
        assert_eq!(
            tokens,
            vec![
                SearchToken::Word("normale".to_string()),
                SearchToken::Word("grossesse".to_string())
            ]
        );

        let tokens_quoted = parse_search_query("\"normale grossesse\"");
        assert_eq!(
            tokens_quoted,
            vec![SearchToken::Phrase(vec![
                "normale".to_string(),
                "grossesse".to_string()
            ])]
        );

        let tokens_curly = parse_search_query("“normale grossesse”");
        assert_eq!(
            tokens_curly,
            vec![SearchToken::Phrase(vec![
                "normale".to_string(),
                "grossesse".to_string()
            ])]
        );

        let tokens_guillemets = parse_search_query("«normale grossesse»");
        assert_eq!(
            tokens_guillemets,
            vec![SearchToken::Phrase(vec![
                "normale".to_string(),
                "grossesse".to_string()
            ])]
        );

        let tokens_mixed = parse_search_query("traitement \"normale grossesse\" fœtus");
        assert_eq!(
            tokens_mixed,
            vec![
                SearchToken::Word("traitement".to_string()),
                SearchToken::Phrase(vec![
                    "normale".to_string(),
                    "grossesse".to_string()
                ]),
                SearchToken::Word("fœtus".to_string()),
            ]
        );
    }

    #[test]
    fn test_build_fts5_match_clause() {
        let tokens = parse_search_query("normale grossesse");
        assert_eq!(build_fts5_match_clause(&tokens), "normale* AND grossesse*");

        let phrase_tokens = parse_search_query("\"normale grossesse\"");
        assert_eq!(build_fts5_match_clause(&phrase_tokens), "\"normale grossesse\"");

        let mixed_tokens = parse_search_query("traitement \"grossesse normale\"");
        assert_eq!(
            build_fts5_match_clause(&mixed_tokens),
            "traitement* AND \"grossesse normale\""
        );

        let mut vocab = std::collections::HashMap::new();
        vocab.insert("stigmine".to_string(), vec!["neostigmine".to_string(), "prostigmine".to_string()]);
        let stig_tokens = parse_search_query("stigmine");
        assert_eq!(
            build_fts5_match_clause_with_vocab(&stig_tokens, Some(&vocab)),
            "(stigmine* OR neostigmine* OR prostigmine*)"
        );
    }

    #[test]
    fn test_find_occurrences_on_page_phrase() {
        let words = vec![
            WordEntry(10.0, 10.0, 50.0, 25.0, "Normale".to_string(), 0, 1),
            WordEntry(55.0, 10.0, 110.0, 25.0, "grossesse".to_string(), 0, 1),
            WordEntry(10.0, 40.0, 60.0, 55.0, "grossesse".to_string(), 0, 2),
        ];

        let phrase_terms = vec!["normale grossesse".to_string()];
        let occs = find_occurrences_on_page(&words, &phrase_terms, "hash", 1, 1, 1.0, "", 842.0);
        assert_eq!(occs.len(), 1, "Doit matcher uniquement la séquence contiguë");
        assert_eq!(occs[0].matched_terms, vec!["normale grossesse"]);

        let unquoted_terms = vec!["normale".to_string(), "grossesse".to_string()];
        let occs_unquoted = find_occurrences_on_page(&words, &unquoted_terms, "hash", 1, 1, 1.0, "", 842.0);
        assert_eq!(occs_unquoted.len(), 2, "Doit matcher les deux lignes sans guillemets");
    }

    #[test]
    fn test_find_occurrences_in_text_phrase() {
        let text = "Première ligne avec normale grossesse ici.\nDeuxième ligne avec grossesse seule.\nTroisième ligne normale.";
        let phrase_terms = vec!["normale grossesse".to_string()];
        let occs = find_occurrences_in_text(text, &phrase_terms, "hash", 1, 1, 1.0, "");
        assert_eq!(occs.len(), 1, "Doit matcher uniquement la ligne contenant la phrase");
        assert_eq!(occs[0].page_number, 1);
    }
}

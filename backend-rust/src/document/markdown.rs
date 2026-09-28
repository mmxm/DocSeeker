use std::fs;
use std::path::Path;
use image::{ImageBuffer, ImageFormat, Rgba};
use unicode_normalization::UnicodeNormalization;
use crate::document::processor::{DocumentMetadata, DocumentProcessor, ExtractedPage};

pub struct MarkdownProcessor;

impl MarkdownProcessor {
    pub fn new() -> Self {
        Self
    }
}

impl Default for MarkdownProcessor {
    fn default() -> Self {
        Self::new()
    }
}

/// Dérive un titre propre à partir du nom de fichier
pub fn derive_title_from_filename(filename: &str) -> String {
    let stem = Path::new(filename)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or(filename);

    let clean: String = stem.nfc().collect();
    clean.replace('_', " ").trim().to_string()
}

/// Supprime la syntaxe Markdown pour ne garder que le texte brut indexable par FTS5
pub fn strip_markdown(content: &str) -> String {
    let mut result = Vec::new();
    let mut in_code_block = false;

    for line in content.lines() {
        let trimmed = line.trim();

        // Gestion des blocs de code ```
        if trimmed.starts_with("```") {
            in_code_block = !in_code_block;
            continue;
        }

        if in_code_block {
            result.push(trimmed.to_string());
            continue;
        }

        // Ignorer les séparateurs horizontaux (--- ou ***)
        if trimmed == "---" || trimmed == "***" || trimmed == "___" {
            continue;
        }

        let mut cleaned = trimmed.to_string();

        // Enlever les préfixes de titres (#, ##, etc.)
        if cleaned.starts_with('#') {
            cleaned = cleaned.trim_start_matches('#').trim_start().to_string();
        }

        // Enlever les puces de listes (- , * , 1. )
        if cleaned.starts_with("- ") || cleaned.starts_with("* ") || cleaned.starts_with("+ ") {
            cleaned = cleaned[2..].trim_start().to_string();
        } else if let Some(idx) = cleaned.find(". ") {
            if cleaned[..idx].chars().all(|c| c.is_ascii_digit()) {
                cleaned = cleaned[idx + 2..].trim_start().to_string();
            }
        }

        // Enlever les blockquotes (> )
        while cleaned.starts_with('>') {
            cleaned = cleaned.trim_start_matches('>').trim_start().to_string();
        }

        // Nettoyer les liens et images: ![alt](url) -> alt, [text](url) -> text
        cleaned = clean_links_and_images(&cleaned);

        // Nettoyer gras et italique (**text**, *text*, __text__, _text_)
        cleaned = cleaned.replace("**", "").replace("__", "");
        cleaned = cleaned.replace("~~", ""); // barré
        cleaned = cleaned.replace('`', ""); // inline code

        if !cleaned.trim().is_empty() {
            result.push(cleaned);
        }
    }

    result.join("\n")
}

/// Helper pour convertir `[texte](lien)` et `![image](lien)` en `texte`
fn clean_links_and_images(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let chars: Vec<char> = input.chars().collect();
    let len = chars.len();
    let mut i = 0;

    while i < len {
        if chars[i] == '!' && i + 1 < len && chars[i + 1] == '[' {
            // Image ![alt](url) -> ignorer url, garder alt
            i += 2;
            let start_alt = i;
            while i < len && chars[i] != ']' {
                i += 1;
            }
            let alt: String = chars[start_alt..i].iter().collect();
            if i < len && chars[i] == ']' {
                i += 1; // skip ']'
                if i < len && chars[i] == '(' {
                    while i < len && chars[i] != ')' {
                        i += 1;
                    }
                    if i < len && chars[i] == ')' {
                        i += 1; // skip ')'
                    }
                }
            }
            if !alt.is_empty() {
                out.push_str(&alt);
            }
        } else if chars[i] == '[' {
            // Lien [texte](url) -> garder texte
            i += 1;
            let start_text = i;
            while i < len && chars[i] != ']' {
                i += 1;
            }
            let text: String = chars[start_text..i].iter().collect();
            if i < len && chars[i] == ']' {
                i += 1; // skip ']'
                if i < len && chars[i] == '(' {
                    while i < len && chars[i] != ')' {
                        i += 1;
                    }
                    if i < len && chars[i] == ')' {
                        i += 1; // skip ')'
                    }
                }
            }
            out.push_str(&text);
        } else {
            out.push(chars[i]);
            i += 1;
        }
    }

    out
}

impl DocumentProcessor for MarkdownProcessor {
    fn doc_type(&self) -> &'static str {
        "markdown"
    }

    fn supported_extensions(&self) -> &[&str] {
        &["md", "markdown"]
    }

    fn extract_metadata(&self, _file_path: &Path, original_filename: &str) -> Result<DocumentMetadata, String> {
        let title = derive_title_from_filename(original_filename);
        Ok(DocumentMetadata {
            total_pages: 1, // 1 note = 1 page
            title,
        })
    }

    fn extract_pages(&self, file_path: &Path) -> Result<Vec<ExtractedPage>, String> {
        let content = fs::read_to_string(file_path)
            .map_err(|e| format!("Impossible de lire le fichier Markdown {:?} : {}", file_path, e))?;

        let plain_text = strip_markdown(&content);

        Ok(vec![ExtractedPage {
            page_number: 1,
            text_content: plain_text,
            words_json: None, // Pas de coordonnées géométriques pour le Markdown
        }])
    }

    fn generate_cover(&self, file_path: &Path, cover_path: &Path, _doc_id: i64) -> Result<(), String> {
        // Dimensions standard des vignettes couverture (300 x 420)
        let width = 300u32;
        let height = 420u32;

        let content = fs::read_to_string(file_path).unwrap_or_default();
        let title = file_path
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("Note")
            .to_string();

        let mut img: ImageBuffer<Rgba<u8>, Vec<u8>> = ImageBuffer::new(width, height);

        // Palette moderne et premium
        // Fond : blanc doux / ivoire moderne (#f8fafc)
        let bg_color = Rgba([248, 250, 252, 255]);
        // Bordure (#e2e8f0)
        let border_color = Rgba([226, 232, 240, 255]);
        // Bandeau d'en-tête bleu/indigo moderne (#3b82f6)
        let header_color = Rgba([59, 130, 246, 255]);
        // Badge Markdown (#2563eb)
        let badge_bg = Rgba([37, 99, 235, 255]);
        // Lignes de texte stylisées (#94a3b8)
        let text_line_color = Rgba([148, 163, 184, 255]);
        let text_line_alt = Rgba([203, 213, 225, 255]);

        for (x, y, pixel) in img.enumerate_pixels_mut() {
            // Bordure externe
            if x == 0 || x == width - 1 || y == 0 || y == height - 1 {
                *pixel = border_color;
            } else if y < 50 {
                // Bandeau d'en-tête
                *pixel = header_color;
            } else if y >= 55 && y < 75 && x >= 20 && x < 85 {
                // Badge "MD"
                *pixel = badge_bg;
            } else {
                *pixel = bg_color;
            }
        }

        // Dessiner des barres de simulation de texte Markdown
        // Titre : barre plus épaisse
        for y in 95..105 {
            for x in 20..(width - 40) {
                img.put_pixel(x, y, Rgba([30, 41, 59, 255])); // Slate-800
            }
        }

        // Lignes de contenu stylisées
        let lines: Vec<&str> = content.lines().take(12).collect();
        let num_lines = lines.len().max(6).min(14);
        let mut curr_y = 125u32;

        for (idx, line) in lines.iter().enumerate().take(num_lines) {
            let is_heading = line.trim().starts_with('#');
            let line_len = if is_heading {
                width.saturating_sub(60)
            } else {
                let proportion = ((line.len() * 3).max(40) as u32).min(width - 50);
                20 + proportion
            };

            let thickness = if is_heading { 6 } else { 4 };
            let color = if is_heading {
                Rgba([71, 85, 105, 255])
            } else if idx % 2 == 0 {
                text_line_color
            } else {
                text_line_alt
            };

            for y in curr_y..(curr_y + thickness).min(height - 20) {
                for x in 20..line_len.min(width - 20) {
                    img.put_pixel(x, y, color);
                }
            }
            curr_y += thickness + 12;
            if curr_y >= height - 30 {
                break;
            }
        }

        if let Some(parent) = cover_path.parent() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }

        img.save_with_format(cover_path, ImageFormat::WebP)
            .map_err(|e| format!("Erreur génération couverture WebP pour {:?} : {}", title, e))?;

        Ok(())
    }
}

/// Indexe un fichier Markdown dans la base SQLite dérivée
pub fn index_markdown_file(
    conn: &rusqlite::Connection,
    config: &crate::config::Config,
    file_path: &Path,
    original_filename: &str,
) -> Result<i64, String> {
    use rusqlite::params;
    use crate::document::trash::resolve_file_path;
    use crate::pdf::indexer::compute_file_hash;

    let path = resolve_file_path(&config.documents_dir, original_filename)
        .unwrap_or_else(|| file_path.to_path_buf());

    let file_size = fs::metadata(&path).map(|m| m.len() as i64).unwrap_or(0);
    let file_hash = compute_file_hash(&path).unwrap_or_default();

    let processor = MarkdownProcessor::new();
    let meta = processor.extract_metadata(&path, original_filename)?;
    let pages = processor.extract_pages(&path)?;

    // Vérifier si le document existe déjà
    let existing_id: Option<i64> = conn
        .query_row(
            "SELECT id FROM documents WHERE filename = ?1",
            params![original_filename],
            |row| row.get(0),
        )
        .ok();

    let inferred_folder_id: Option<i64> = Path::new(original_filename)
        .parent()
        .and_then(|p| p.to_str())
        .filter(|p| !p.is_empty())
        .and_then(|sub_dir| {
            conn.query_row("SELECT id FROM folders WHERE name = ?1", params![sub_dir], |r| r.get(0)).ok()
                .or_else(|| {
                    conn.execute("INSERT INTO folders (name, color) VALUES (?1, '#3b82f6')", params![sub_dir])
                        .ok()
                        .map(|_| conn.last_insert_rowid())
                })
        });

    let doc_id = if let Some(id) = existing_id {
        conn.execute("DELETE FROM pages WHERE doc_id = ?1", params![id]).map_err(|e| e.to_string())?;
        conn.execute(
            "UPDATE documents SET title = ?1, file_hash = ?2, total_pages = 1, file_size = ?3, folder_id = COALESCE(folder_id, ?4), doc_type = 'markdown', status = 'ready', error_message = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?5",
            params![meta.title, file_hash, file_size, inferred_folder_id, id],
        ).map_err(|e| e.to_string())?;
        id
    } else {
        conn.execute(
            "INSERT INTO documents (filename, title, file_hash, total_pages, file_size, folder_id, doc_type, status, error_message) VALUES (?1, ?2, ?3, 1, ?4, ?5, 'markdown', 'ready', NULL)",
            params![original_filename, meta.title, file_hash, file_size, inferred_folder_id],
        ).map_err(|e| e.to_string())?;
        conn.last_insert_rowid()
    };

    // Génération de la couverture WebP
    let cover_webp = config.covers_dir.join(format!("{}.webp", doc_id));
    let _ = processor.generate_cover(&path, &cover_webp, doc_id);

    // Insertion atomique de la page dans SQLite FTS5
    {
        let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
        {
            let mut insert_page = tx
                .prepare("INSERT INTO pages (doc_id, page_number, text_content, words_json) VALUES (?1, ?2, ?3, ?4)")
                .map_err(|e| e.to_string())?;

            for page in pages {
                insert_page
                    .execute(params![doc_id, page.page_number, page.text_content, page.words_json])
                    .map_err(|e| e.to_string())?;
            }
        }
        tx.commit().map_err(|e| e.to_string())?;
    }

    Ok(doc_id)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_strip_markdown() {
        let md = "# Titre Principal\n\nVoici un **texte en gras** et un *texte en italique*.\n\n- Liste 1\n- Liste 2\n\n```rust\nlet x = 42;\n```\n\n[Lien](https://example.com) et ![Image](image.png)";
        let stripped = strip_markdown(md);
        assert!(stripped.contains("Titre Principal"));
        assert!(stripped.contains("Voici un texte en gras"));
        assert!(stripped.contains("Liste 1"));
        assert!(stripped.contains("let x = 42;"));
        assert!(stripped.contains("Lien"));
        assert!(stripped.contains("Image"));
        assert!(!stripped.contains("# "));
        assert!(!stripped.contains("**"));
    }

    #[test]
    fn test_derive_title() {
        assert_eq!(derive_title_from_filename("cours_cardiologie.md"), "cours cardiologie");
        assert_eq!(derive_title_from_filename("subfolder/ma note.markdown"), "ma note");
    }
}

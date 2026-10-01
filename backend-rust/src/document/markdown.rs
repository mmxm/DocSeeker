use std::fs;
use std::path::Path;
use image::{ImageBuffer, ImageFormat, Rgba};
use unicode_normalization::UnicodeNormalization;

/// Dimensions des vignettes d'extrait Markdown (ratio 3:1)
const MD_CROP_WIDTH: u32 = 420;
const MD_CROP_HEIGHT: u32 = 140;

/// Vérifie si un fichier image est lisible avec succès (guard anti-image-corrompue).
/// La génération des vignettes s'exécute sur le pool bloquant du serveur : une
/// image illisible (0 octet, téléchargement interrompu...) ferait planter le worker.
fn is_readable_image(path: &Path) -> bool {
    image::image_dimensions(path).is_ok()
}

/// Tente de trouver une image utilisable pour illustrer une note Markdown,
/// en ignorant les entrées illisibles/corrompues et les références blob: locales.
fn find_first_readable_image(content: &str, file_path: &Path) -> Option<std::path::PathBuf> {
    let candidates = find_first_image_in_markdown(content, file_path)?;
    candidates.into_iter().find(|p| is_readable_image(p))
}
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
    // Normalisation des séquences échappées (\[ \] \( \) \!) : le MD sérialisé
    // en texte brut produit des refs `!\[image.png\](assets/…)` que le parseur
    // ci-dessous ne reconnaît pas sinon — la syntaxe brute polluerait la recherche.
    let mut normalized = String::with_capacity(input.len());
    let mut it = input.chars().peekable();
    while let Some(c) = it.next() {
        if c == '\\' {
            if let Some(&n) = it.peek() {
                if matches!(n, '[' | ']' | '(' | ')' | '!') {
                    continue; // avaler l'antislash, garder le caractère
                }
            }
        }
        normalized.push(c);
    }

    let mut out = String::with_capacity(normalized.len());
    let chars: Vec<char> = normalized.chars().collect();
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
                    let mut depth = 1;
                    i += 1;
                    while i < len && depth > 0 {
                        if chars[i] == '(' {
                            depth += 1;
                        } else if chars[i] == ')' {
                            depth -= 1;
                        }
                        i += 1;
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
                    let mut depth = 1;
                    i += 1;
                    while i < len && depth > 0 {
                        if chars[i] == '(' {
                            depth += 1;
                        } else if chars[i] == ')' {
                            depth -= 1;
                        }
                        i += 1;
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

use ab_glyph::{Font, FontRef, PxScale, ScaleFont};
use imageproc::drawing::{draw_filled_rect_mut, draw_text_mut};
use imageproc::rect::Rect;

const FONT_REGULAR_BYTES: &[u8] = include_bytes!("../../assets/fonts/regular.ttf");
const FONT_BOLD_BYTES: &[u8] = include_bytes!("../../assets/fonts/bold.ttf");

fn measure_text(font: &FontRef, text: &str, scale: PxScale) -> f32 {
    let scaled = font.as_scaled(scale);
    let mut width = 0.0;
    for c in text.chars() {
        let g = scaled.glyph_id(c);
        width += scaled.h_advance(g);
    }
    width
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

        // Pas de words_json pour les notes Markdown : leurs occurrences passent par le
        // chemin "par lignes" (find_occurrences_in_text) qui produit des extraits texte
        // enrichis (mot-clé + contexte) rendus nativement en HTML par le client — plus
        // de crops image (économie bande passante / CPU).

        Ok(vec![ExtractedPage {
            page_number: 1,
            text_content: plain_text,
            words_json: None,
        }])
    }

    fn generate_cover(&self, file_path: &Path, cover_path: &Path, _doc_id: i64) -> Result<(), String> {
        let img = render_cover_image(file_path)?;
        if let Some(parent) = cover_path.parent() {
            let _ = fs::create_dir_all(parent);
        }
        img.save_with_format(cover_path, ImageFormat::WebP)
            .map_err(|e| format!("Erreur génération couverture WebP : {}", e))?;
        Ok(())
    }
}

/// Dessine la couverture d'une note Markdown (300x420) entièrement en mémoire.
/// Le rendu est recalculé à chaque appel depuis l'état courant de la note et de
/// ses assets : aucune vignette n'est mise en cache sur disque.
fn render_cover_image(file_path: &Path) -> Result<ImageBuffer<Rgba<u8>, Vec<u8>>, String> {
    // Dimensions standard des vignettes couverture (300 x 420)
    let width = 300u32;
    let height = 420u32;

    let content = fs::read_to_string(file_path).unwrap_or_default();
    let title = derive_title_from_filename(
        file_path.file_name().and_then(|s| s.to_str()).unwrap_or("Note")
    );

    let font_bold = FontRef::try_from_slice(FONT_BOLD_BYTES).map_err(|e| e.to_string())?;
    let font_reg = FontRef::try_from_slice(FONT_REGULAR_BYTES).map_err(|e| e.to_string())?;

    // Fond feuille blanche pure avec bordure discrète
    let mut img: ImageBuffer<Rgba<u8>, Vec<u8>> = ImageBuffer::from_pixel(width, height, Rgba([255, 255, 255, 255]));
        let border_color = Rgba([226, 232, 240, 255]); // slate-200
        for x in 0..width {
            img.put_pixel(x, 0, border_color);
            img.put_pixel(x, height - 1, border_color);
        }
        for y in 0..height {
            img.put_pixel(0, y, border_color);
            img.put_pixel(width - 1, y, border_color);
        }

        // Bandeau haut d'accent coloré discret
        draw_filled_rect_mut(&mut img, Rect::at(1, 1).of_size(width - 2, 4), Rgba([59, 130, 246, 255]));

        // Badge pillule "NOTE MD"
        let badge_bg = Rgba([241, 245, 249, 255]); // slate-100
        draw_filled_rect_mut(&mut img, Rect::at(20, 16).of_size(68, 20), badge_bg);
        draw_text_mut(&mut img, Rgba([71, 85, 105, 255]), 27, 20, PxScale::from(10.0), &font_bold, "NOTE MD");

        // Sous-titre "Note Markdown • 1 page"
        draw_text_mut(&mut img, Rgba([148, 163, 184, 255]), 98, 21, PxScale::from(10.0), &font_reg, "Note Markdown");

        // Titre réel de la note en typographie bold
        let display_title = if title.chars().count() > 24 {
            let truncated: String = title.chars().take(22).collect();
            format!("{}...", truncated)
        } else {
            title.clone()
        };
        draw_text_mut(&mut img, Rgba([15, 23, 42, 255]), 20, 44, PxScale::from(17.0), &font_bold, &display_title);

        // Ligne de séparation élégante
        draw_filled_rect_mut(&mut img, Rect::at(20, 70).of_size(width - 40, 1), Rgba([241, 245, 249, 255]));

        // Vérifier si la note a une image (capture d'écran ou illustration)
        let maybe_img = find_first_readable_image(&content, file_path);

        let mut curr_y = 80i32;

        if let Some(ref img_path) = maybe_img {
            if let Ok(dyn_img) = image::open(img_path) {
                let frame_w = width - 40; // 260px
                let frame_h = 160u32;     // 160px
                let resized = dyn_img.resize(frame_w, frame_h, image::imageops::FilterType::Lanczos3);

                let offset_x = 20 + ((frame_w.saturating_sub(resized.width())) / 2);
                let offset_y = curr_y as u32 + ((frame_h.saturating_sub(resized.height())) / 2);

                draw_filled_rect_mut(&mut img, Rect::at(20, curr_y).of_size(frame_w, frame_h), Rgba([248, 250, 252, 255]));
                image::imageops::overlay(&mut img, &resized, offset_x as i64, offset_y as i64);

                // Bordure fine du cadre d'image
                for x in 20..(20 + frame_w) {
                    img.put_pixel(x, curr_y as u32, border_color);
                    img.put_pixel(x, curr_y as u32 + frame_h - 1, border_color);
                }
                for y in (curr_y as u32)..(curr_y as u32 + frame_h) {
                    img.put_pixel(20, y, border_color);
                    img.put_pixel(20 + frame_w - 1, y, border_color);
                }

                curr_y += frame_h as i32 + 15;
            }
        }

        // Rendu des vraies lignes de texte de la note
        let lines: Vec<&str> = content
            .lines()
            .map(|l| l.trim())
            .filter(|l| !l.is_empty() && !l.starts_with("# ") && !l.starts_with("![") && !l.starts_with("<br") && !l.starts_with("<img"))
            .collect();

        for line in lines.iter().take(if maybe_img.is_some() { 6 } else { 14 }) {
            if curr_y >= (height - 25) as i32 {
                break;
            }

            let is_h2 = line.starts_with("##");
            let is_bullet = line.starts_with("- ") || line.starts_with("* ");

            let clean_line = clean_preview_line(line);
            let max_chars = if is_h2 { 28 } else { 38 };
            let line_text: String = if clean_line.chars().count() > max_chars {
                clean_line.chars().take(max_chars - 2).collect::<String>() + "..."
            } else {
                clean_line
            };

            if is_h2 {
                curr_y += 4;
                draw_text_mut(&mut img, Rgba([30, 41, 59, 255]), 20, curr_y, PxScale::from(14.0), &font_bold, &line_text);
                curr_y += 20;
            } else if is_bullet {
                draw_filled_rect_mut(&mut img, Rect::at(22, curr_y + 4).of_size(3, 3), Rgba([100, 116, 139, 255]));
                draw_text_mut(&mut img, Rgba([51, 65, 85, 255]), 30, curr_y, PxScale::from(11.5), &font_reg, &line_text);
                curr_y += 18;
            } else {
                draw_text_mut(&mut img, Rgba([51, 65, 85, 255]), 20, curr_y, PxScale::from(11.5), &font_reg, &line_text);
                curr_y += 18;
            }
        }

    Ok(img)
}

/// Helper pour afficher une ligne Markdown dans les aperçus/crops de façon propre et sans syntaxe brute
fn clean_preview_line(line: &str) -> String {
    let t = line.trim();
    let mut s = if let Some(rest) = t.strip_prefix('#') {
        rest.trim_start_matches('#').trim().to_string()
    } else if let Some(rest) = t.strip_prefix("- ") {
        format!("• {}", rest.trim())
    } else if let Some(rest) = t.strip_prefix("* ") {
        format!("• {}", rest.trim())
    } else if let Some(rest) = t.strip_prefix("> ") {
        rest.trim().to_string()
    } else {
        t.to_string()
    };
    s = s.replace("**", "").replace("__", "").replace('`', "").replace("~~", "");
    s
}

impl MarkdownProcessor {
    /// Génère une vignette d'extrait intra-document (crop) pour une occurrence de recherche Markdown (420 x 140 px)
    pub fn generate_crop(
        file_path: &Path,
        crop_path: &Path,
        occ_id: usize,
        terms: &[String],
        _doc_id: i64,
    ) -> Result<(), String> {
        let img = render_crop_image(file_path, occ_id, terms)?;
        if let Some(parent) = crop_path.parent() {
            let _ = fs::create_dir_all(parent);
        }
        img.save_with_format(crop_path, ImageFormat::WebP)
            .map_err(|e| format!("Erreur génération vignette extrait WebP : {}", e))
    }

    /// Génère la vignette d'extrait Markdown entièrement en mémoire (octets WebP).
    /// Aucun cache disque : le rendu reflète toujours le contenu courant de la note.
    pub fn generate_crop_bytes(
        file_path: &Path,
        occ_id: usize,
        terms: &[String],
    ) -> Result<Vec<u8>, String> {
        let img = render_crop_image(file_path, occ_id, terms)?;
        let mut buffer = std::io::Cursor::new(Vec::new());
        image::DynamicImage::ImageRgba8(img)
            .write_to(&mut buffer, ImageFormat::WebP)
            .map_err(|e| format!("Encodage WebP crop mémoire : {}", e))?;
        Ok(buffer.into_inner())
    }
}

/// Dessine la vignette d'extrait d'une note Markdown (420x140) entièrement en mémoire.
fn render_crop_image(
    file_path: &Path,
    occ_id: usize,
    terms: &[String],
) -> Result<ImageBuffer<Rgba<u8>, Vec<u8>>, String> {
        let width = MD_CROP_WIDTH;
        let height = MD_CROP_HEIGHT;

        let content = fs::read_to_string(file_path).unwrap_or_default();
        let font_bold = FontRef::try_from_slice(FONT_BOLD_BYTES).map_err(|e| e.to_string())?;
        let font_reg = FontRef::try_from_slice(FONT_REGULAR_BYTES).map_err(|e| e.to_string())?;

        let mut img: ImageBuffer<Rgba<u8>, Vec<u8>> = ImageBuffer::from_pixel(width, height, Rgba([255, 255, 255, 255]));
        let border_color = Rgba([226, 232, 240, 255]);
        for x in 0..width {
            img.put_pixel(x, 0, border_color);
            img.put_pixel(x, height - 1, border_color);
        }
        for y in 0..height {
            img.put_pixel(0, y, border_color);
            img.put_pixel(width - 1, y, border_color);
        }

        // Barre d'accent gauche
        draw_filled_rect_mut(&mut img, Rect::at(1, 1).of_size(4, height - 2), Rgba([59, 130, 246, 255]));

        let lines: Vec<&str> = content.lines().collect();
        let lower_terms: Vec<String> = terms.iter().map(|t| t.to_lowercase()).collect();

        let mut matched_line_idx = None;
        let mut current_occ = 0usize;

        for (idx, line) in lines.iter().enumerate() {
            let l_lower = line.to_lowercase();
            if lower_terms.iter().any(|t| l_lower.contains(t.as_str())) {
                if current_occ == occ_id {
                    matched_line_idx = Some(idx);
                    break;
                }
                current_occ += 1;
            }
        }

        let line_idx = matched_line_idx.unwrap_or(0);
        let target_line = lines.get(line_idx).copied().unwrap_or("");

        // En-tête : "Extrait Note • Ligne X"
        let header_str = format!("Extrait Note • Ligne {}", line_idx + 1);
        draw_text_mut(&mut img, Rgba([148, 163, 184, 255]), 16, 8, PxScale::from(9.5), &font_reg, &header_str);

        // Si la ligne contient ou précède une image
        let is_image_line = target_line.contains("![") || target_line.contains("<img");
        if is_image_line {
            if let Some(img_path) = find_first_readable_image(target_line, file_path)
                .or_else(|| find_first_readable_image(&content, file_path))
            {
                if let Ok(dyn_img) = image::open(&img_path) {
                    let thumb = dyn_img.resize(100, 85, image::imageops::FilterType::Lanczos3);
                    image::imageops::overlay(&mut img, &thumb, 16, 30);
                    draw_text_mut(&mut img, Rgba([30, 41, 59, 255]), 130, 46, PxScale::from(12.5), &font_bold, "Image attachée");
                    draw_text_mut(&mut img, Rgba([100, 116, 139, 255]), 130, 66, PxScale::from(10.5), &font_reg, "Aperçu de la capture");

                    return Ok(img);
                }
            }
        }

        // Ligne précédente pour contexte visuel
        if line_idx > 0 {
            if let Some(pl) = lines.get(line_idx - 1) {
                let clean_p = clean_preview_line(pl);
                if !clean_p.is_empty() {
                    let trunc_p = clean_p.chars().take(42).collect::<String>();
                    draw_text_mut(&mut img, Rgba([148, 163, 184, 255]), 16, 26, PxScale::from(10.5), &font_reg, &trunc_p);
                }
            }
        }

        // Ligne de l'occurrence avec SURBRILLANCE JAUNE GoodNotes
        let clean_target = clean_preview_line(target_line);
        let target_y = 48i32;

        let mut drawn_any_term = false;
        let lower_clean_target = clean_target.to_lowercase();
        for term in &lower_terms {
            if let Some(byte_pos) = lower_clean_target.find(term.as_str()) {
                let char_pos = lower_clean_target[..byte_pos].chars().count();
                let term_char_len = term.chars().count();
                let prefix: String = clean_target.chars().take(char_pos).collect();
                let term_match: String = clean_target.chars().skip(char_pos).take(term_char_len).collect();
                let suffix: String = clean_target.chars().skip(char_pos + term_char_len).take(30).collect();

                let prefix_w = measure_text(&font_reg, &prefix, PxScale::from(13.0));
                let term_w = measure_text(&font_bold, &term_match, PxScale::from(13.0));
                let term_x = 16 + prefix_w.round() as i32;

                // Surlignage jaune pastel vif (#fef08a)
                let hl_rect = Rect::at(term_x - 2, target_y - 2).of_size((term_w.round() as u32 + 4).min(width - term_x as u32 - 10), 18);
                draw_filled_rect_mut(&mut img, hl_rect, Rgba([254, 240, 138, 255]));

                draw_text_mut(&mut img, Rgba([30, 41, 59, 255]), 16, target_y, PxScale::from(13.0), &font_reg, &prefix);
                draw_text_mut(&mut img, Rgba([15, 23, 42, 255]), term_x, target_y, PxScale::from(13.0), &font_bold, &term_match);
                let suffix_x = term_x + term_w.round() as i32;
                draw_text_mut(&mut img, Rgba([30, 41, 59, 255]), suffix_x, target_y, PxScale::from(13.0), &font_reg, &suffix);

                drawn_any_term = true;
                break;
            }
        }

        if !drawn_any_term {
            let trunc_line = clean_target.chars().take(38).collect::<String>();
            draw_text_mut(&mut img, Rgba([30, 41, 59, 255]), 16, target_y, PxScale::from(13.0), &font_reg, &trunc_line);
        }

        // Ligne suivante pour contexte visuel
        if let Some(nl) = lines.get(line_idx + 1) {
            let clean_n = clean_preview_line(nl);
            if !clean_n.is_empty() {
                let trunc_n = clean_n.chars().take(42).collect::<String>();
                draw_text_mut(&mut img, Rgba([148, 163, 184, 255]), 16, 76, PxScale::from(10.5), &font_reg, &trunc_n);
            }
        }

    Ok(img)
}

/// Cherche les images locales candidates pour une note Markdown (dossier assets ou liens du contenu).
/// Retourne une liste ordonnée par priorité : la première lisible sera retenue.
fn find_first_image_in_markdown(content: &str, file_path: &Path) -> Option<Vec<std::path::PathBuf>> {
    use unicode_normalization::UnicodeNormalization;

    let parent_dir = file_path.parent()?;
    let current_stem = file_path.file_stem().and_then(|s| s.to_str()).unwrap_or("");

    let is_img_ext = |p: &Path| -> bool {
        if let Some(ext) = p.extension().and_then(|e| e.to_str()) {
            let lext = ext.to_lowercase();
            matches!(lext.as_str(), "png" | "jpg" | "jpeg" | "webp" | "gif" | "bmp")
        } else {
            false
        }
    };

    let mut candidates: Vec<std::path::PathBuf> = Vec::new();

    // 1. Recherche prioritaire dans le dossier Solution 1 : parent_dir/.assets/<current_stem>/
    if !current_stem.is_empty() {
        let s1_assets = parent_dir.join(".assets").join(current_stem);
        if s1_assets.is_dir() {
            if let Ok(entries) = fs::read_dir(&s1_assets) {
                let mut img_files = Vec::new();
                for entry in entries.flatten() {
                    let p = entry.path();
                    if p.is_file() && is_img_ext(&p) {
                        let mtime = fs::metadata(&p).and_then(|m| m.modified()).ok();
                        img_files.push((p, mtime));
                    }
                }
                img_files.sort_by(|a, b| b.1.cmp(&a.1));
                for (best_img, _) in img_files {
                    candidates.push(best_img);
                }
            }
        }
    }

    // 2. Recherche dans le dossier assets direct de la note (ancien format bundle : nom_de_la_note/assets/)
    let direct_note_assets = parent_dir.join("assets");
    if direct_note_assets.is_dir() {
        if let Ok(entries) = fs::read_dir(&direct_note_assets) {
            let mut img_files = Vec::new();
            for entry in entries.flatten() {
                let p = entry.path();
                if p.is_file() && is_img_ext(&p) {
                    let mtime = fs::metadata(&p).and_then(|m| m.modified()).ok();
                    img_files.push((p, mtime));
                }
            }
            img_files.sort_by(|a, b| b.1.cmp(&a.1));
            for (best_img, _) in img_files {
                candidates.push(best_img);
            }
        }
    }

    // Fallback rétrocompatible dans l'ancien format assets_base (ex. assets/Ma note pref 1/)
    if !current_stem.is_empty() {
        let current_stem_nfc: String = current_stem.nfc().collect();
        let current_stem_nfd: String = current_stem.nfd().collect();

        let assets_base = parent_dir.join("assets");
        if assets_base.is_dir() {
            let mut candidate_folders = vec![assets_base.join(current_stem)];
            if let Ok(entries) = fs::read_dir(&assets_base) {
                for entry in entries.flatten() {
                    let dname = entry.file_name().to_string_lossy().to_string();
                    let dnfc: String = dname.nfc().collect();
                    let dnfd: String = dname.nfd().collect();
                    if dnfc == current_stem_nfc || dnfd == current_stem_nfd {
                        let p = entry.path();
                        if p.is_dir() && !candidate_folders.contains(&p) {
                            candidate_folders.push(p);
                        }
                    }
                }
            }

            for folder in candidate_folders {
                if folder.is_dir() {
                    if let Ok(entries) = fs::read_dir(&folder) {
                        let mut img_files = Vec::new();
                        for entry in entries.flatten() {
                            let p = entry.path();
                            if p.is_file() && is_img_ext(&p) {
                                let mtime = fs::metadata(&p).and_then(|m| m.modified()).ok();
                                img_files.push((p, mtime));
                            }
                        }
                        // Trier par date de modification décroissante (la plus récente d'abord)
                        img_files.sort_by(|a, b| b.1.cmp(&a.1));
                        for (best_img, _) in img_files {
                            candidates.push(best_img);
                        }
                    }
                }
            }
        }
    }

    // 3. Recherche dans le contenu Markdown (liens ![alt](url), !\[alt\]\(url\), <img src="url">)
    let re = regex::Regex::new(r#"(?:!\\?\[.*?\\?\]\\?\((.+?)\)|<img[^>]+src=["']([^"']+)["'])"#).ok()?;

    for cap in re.captures_iter(content) {
        let raw_target = match cap.get(1).or_else(|| cap.get(2)) {
            Some(m) => m.as_str().trim(),
            None => continue,
        };

        if raw_target.starts_with("blob:")
            || raw_target.starts_with("http://")
            || raw_target.starts_with("https://")
            || raw_target.starts_with("data:")
        {
            continue;
        }

        let decoded = urlencoding::decode(raw_target).unwrap_or(std::borrow::Cow::Borrowed(raw_target));
        let mut clean_target = decoded.trim();
        // Nettoyer les préfixes d'API éventuels
        if let Some(stripped) = clean_target.strip_prefix("/api/assets/") {
            clean_target = stripped;
        } else if let Some(stripped) = clean_target.strip_prefix("api/assets/") {
            clean_target = stripped;
        } else if let Some(stripped) = clean_target.strip_prefix("/api/documents/") {
            clean_target = stripped;
        } else if let Some(stripped) = clean_target.strip_prefix("api/documents/") {
            clean_target = stripped;
        } else if let Some(stripped) = clean_target.strip_prefix("./") {
            clean_target = stripped;
        } else if let Some(stripped) = clean_target.strip_prefix("/") {
            clean_target = stripped;
        }

        // Test chemin direct relatif au dossier parent
        let direct_path = parent_dir.join(clean_target);
        if direct_path.is_file() && is_img_ext(&direct_path) {
            candidates.push(direct_path);
        }

        // Test Solution 1 : parent_dir/.assets/<clean_target> (ex: parent/.assets/HTA/radio.png)
        let s1_target_path = parent_dir.join(".assets").join(clean_target);
        if s1_target_path.is_file() && is_img_ext(&s1_target_path) {
            candidates.push(s1_target_path);
        }

        // Test Solution 1 dans le sous-dossier de la note : parent_dir/.assets/<current_stem>/<clean_target>
        if !current_stem.is_empty() {
            let s1_stem_path = parent_dir.join(".assets").join(current_stem).join(clean_target);
            if s1_stem_path.is_file() && is_img_ext(&s1_stem_path) {
                candidates.push(s1_stem_path);
            }
        }

        // Test avec préfixe assets/
        let assets_path = parent_dir.join("assets").join(clean_target);
        if assets_path.is_file() && is_img_ext(&assets_path) {
            candidates.push(assets_path);
        }
    }

    // Dédupliquer en préservant l'ordre (images réelles du contenu d'abord, assets ensuite)
    candidates.dedup();

    Some(candidates)
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
            "SELECT id FROM documents WHERE filename = ?1 OR filename LIKE ?2",
            params![original_filename, format!("%/{}", original_filename)],
            |row| row.get(0),
        )
        .ok();

    let inferred_folder_id: Option<i64> = Path::new(original_filename)
        .parent()
        .and_then(|p| p.to_str())
        // 'assets' (et ses sous-chemins) est le stockage des pièces jointes, pas un dossier utilisateur
        .filter(|p| !p.is_empty() && !p.split('/').any(|seg| seg.eq_ignore_ascii_case("assets")))
        .and_then(|sub_dir| {
            conn.query_row("SELECT id FROM folders WHERE name = ?1", params![sub_dir], |r| r.get(0)).ok()
                .or_else(|| {
                    tracing::warn!("[FolderInfer-MD] Création dossier '{}' depuis fichier '{}'", sub_dir, original_filename);
                    conn.execute("INSERT INTO folders (name, color) VALUES (?1, '#3b82f6')", params![sub_dir])
                        .ok()
                        .map(|_| conn.last_insert_rowid())
                })
        });

    let doc_id = if let Some(id) = existing_id {
        let _ = conn.execute("DELETE FROM pages WHERE doc_id = ?1", params![id]);
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

    // Plus de couverture pré-générée sur disque : /api/cover rend à la volée.

    // Insertion atomique de la page dans SQLite FTS5
    {
        let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
        let _ = tx.execute("DELETE FROM pages WHERE doc_id = ?1", params![doc_id]);
        {
            let mut insert_page = tx
                .prepare("INSERT OR REPLACE INTO pages (doc_id, page_number, text_content, words_json) VALUES (?1, ?2, ?3, ?4)")
                .map_err(|e| e.to_string())?;

            for page in pages {
                insert_page
                    .execute(params![doc_id, page.page_number, page.text_content, page.words_json.as_deref().unwrap_or("")])
                    .map_err(|e| e.to_string())?;
            }
        }
        tx.commit().map_err(|e| e.to_string())?;
    }

    Ok(doc_id)
}

impl MarkdownProcessor {
    /// Génère la couverture Markdown en mémoire et retourne les octets WebP.
    ///
    /// Les vignettes ne sont plus mises en cache : chaque requête /api/cover
    /// re-rend l'image depuis l'état courant de la note, ce qui garantit que les
    /// captures d'écran collées en pièces jointes apparaissent immédiatement.
    pub fn generate_cover_bytes(file_path: &Path) -> Result<Vec<u8>, String> {
        let img = render_cover_image(file_path)?;
        let mut buffer = std::io::Cursor::new(Vec::new());
        image::DynamicImage::ImageRgba8(img)
            .write_to(&mut buffer, ImageFormat::WebP)
            .map_err(|e| format!("Encodage WebP couverture mémoire : {}", e))?;
        Ok(buffer.into_inner())
    }
}

/// Détermine si un répertoire est un dossier de note Markdown (`nom_de_la_note/`).
/// Un tel dossier contient :
/// - `nom_de_la_note.md` (ou `.markdown`)
/// - `assets/` (dossier des pièces jointes et images)
/// Ce dossier ne doit pas être affiché comme un sous-dossier de navigation dans l'UI.
pub fn is_markdown_note_dir(dir: &Path) -> bool {
    if !dir.is_dir() {
        return false;
    }
    let folder_name = match dir.file_name().and_then(|s| s.to_str()) {
        Some(n) => n,
        None => return false,
    };
    if folder_name.starts_with('.') || folder_name.eq_ignore_ascii_case("assets") {
        return false;
    }

    let folder_nfc: String = folder_name.nfc().collect();
    let folder_lower = folder_nfc.to_lowercase();

    // 1. Tester fichier direct [folder_name].md ou [folder_name].markdown
    if dir.join(format!("{}.md", folder_name)).is_file()
        || dir.join(format!("{}.markdown", folder_name)).is_file()
    {
        return true;
    }

    // 2. Tester avec normalisation Unicode insensible à la casse
    if let Ok(entries) = fs::read_dir(dir) {
        let mut md_count = 0;
        let mut has_matching_name = false;
        for entry in entries.flatten() {
            let p = entry.path();
            if p.is_file() {
                if let Some(ext) = p.extension().and_then(|e| e.to_str()) {
                    let lext = ext.to_lowercase();
                    if lext == "md" || lext == "markdown" {
                        md_count += 1;
                        if let Some(stem) = p.file_stem().and_then(|s| s.to_str()) {
                            let stem_nfc: String = stem.nfc().collect();
                            if stem_nfc.to_lowercase() == folder_lower {
                                has_matching_name = true;
                                break;
                            }
                        }
                    }
                }
            }
        }
        if has_matching_name || (dir.join("assets").is_dir() && md_count == 1) {
            return true;
        }
    }

    false
}

/// Trouve le fichier Markdown principal au sein d'un dossier de note
pub fn find_markdown_file_in_note_dir(dir: &Path) -> Option<std::path::PathBuf> {
    if !dir.is_dir() {
        return None;
    }
    let folder_name = dir.file_name().and_then(|s| s.to_str())?;
    let direct_md = dir.join(format!("{}.md", folder_name));
    if direct_md.is_file() {
        return Some(direct_md);
    }
    let direct_markdown = dir.join(format!("{}.markdown", folder_name));
    if direct_markdown.is_file() {
        return Some(direct_markdown);
    }

    let folder_nfc: String = folder_name.nfc().collect();
    let folder_lower = folder_nfc.to_lowercase();

    let mut first_md = None;
    if let Ok(entries) = fs::read_dir(dir) {
        for entry in entries.flatten() {
            let p = entry.path();
            if p.is_file() {
                if let Some(ext) = p.extension().and_then(|e| e.to_str()) {
                    let lext = ext.to_lowercase();
                    if lext == "md" || lext == "markdown" {
                        if let Some(stem) = p.file_stem().and_then(|s| s.to_str()) {
                            let stem_nfc: String = stem.nfc().collect();
                            if stem_nfc.to_lowercase() == folder_lower {
                                return Some(p);
                            }
                        }
                        if first_md.is_none() {
                            first_md = Some(p);
                        }
                    }
                }
            }
        }
    }

    first_md
}

/// Recherche le dossier d'une note dans base_dir en comparant le nom du dossier ou le stem
pub fn find_note_dir_by_stem(base_dir: &Path, stem: &str) -> Option<std::path::PathBuf> {
    let clean_stem = stem.trim_start_matches('/').trim_end_matches(".md").trim_end_matches(".markdown");
    let stem_nfc: String = clean_stem.nfc().collect();
    let stem_lower = stem_nfc.to_lowercase();

    // 1. Test direct dans base_dir
    let direct = base_dir.join(clean_stem);
    if is_markdown_note_dir(&direct) {
        return Some(direct);
    }

    // 2. Recherche récursive dans les sous-dossiers
    fn search_rec(dir: &Path, target_lower: &str) -> Option<std::path::PathBuf> {
        let entries = fs::read_dir(dir).ok()?;
        for entry in entries.flatten() {
            let p = entry.path();
            if p.is_dir() {
                let name = p.file_name().and_then(|s| s.to_str())?;
                if name.starts_with('.') || name.eq_ignore_ascii_case("assets") {
                    continue;
                }
                let name_nfc: String = name.nfc().collect();
                if is_markdown_note_dir(&p) {
                    if name_nfc.to_lowercase() == target_lower {
                        return Some(p);
                    }
                } else if let Some(found) = search_rec(&p, target_lower) {
                    return Some(found);
                }
            }
        }
        None
    }

    search_rec(base_dir, &stem_lower)
}

/// Nettoie les pièces jointes orphelines : si un fichier dans le dossier d'assets
/// n'est plus référencé dans le contenu Markdown de la note, il est supprimé physiquement du serveur.
/// Tolérant : accepte soit directement le dossier d'assets (ex: parent/.assets/stem), soit le dossier de note (note_dir).
pub fn clean_orphan_markdown_assets(assets_or_note_dir: &Path, content: &str) -> Vec<String> {
    let assets_dir = if assets_or_note_dir.join("assets").is_dir() {
        assets_or_note_dir.join("assets")
    } else {
        assets_or_note_dir.to_path_buf()
    };
    if !assets_dir.is_dir() {
        return Vec::new();
    }

    let entries = match fs::read_dir(&assets_dir) {
        Ok(e) => e,
        Err(_) => return Vec::new(),
    };

    let mut deleted = Vec::new();

    let content_nfc: String = content.nfc().collect();
    let content_lower = content_nfc.to_lowercase();

    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }

        let file_name = match path.file_name().and_then(|s| s.to_str()) {
            Some(n) => n,
            None => continue,
        };

        if file_name.starts_with('.') {
            continue;
        }

        let name_nfc: String = file_name.nfc().collect();
        let name_encoded = urlencoding::encode(&name_nfc).to_string();
        let name_lower = name_nfc.to_lowercase();
        let encoded_lower = name_encoded.to_lowercase();

        // Référencé soit en nom brut, soit en URL-encodé
        let is_referenced = content_lower.contains(&name_lower)
            || content_lower.contains(&encoded_lower);

        if !is_referenced {
            if let Ok(()) = fs::remove_file(&path) {
                tracing::info!(
                    "[Markdown Assets GC] Pièce jointe orpheline supprimée du serveur : {:?}",
                    path
                );
                deleted.push(file_name.to_string());
            }
        }
    }

    deleted
}

/// Crée une archive zip contenant la note Markdown et ses assets (Solution 1).
/// Structure de l'archive :
/// <stem>/
/// <stem>/<stem>.md
/// <stem>/assets/
/// <stem>/assets/<asset_files...>
pub fn create_note_zip(md_file: &Path, assets_dir: Option<&Path>, note_stem: &str) -> Result<Vec<u8>, String> {
    use std::io::{Cursor, Write};
    use zip::write::SimpleFileOptions;
    use zip::ZipWriter;

    let mut zip = ZipWriter::new(Cursor::new(Vec::new()));

    let dir_opt = SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated)
        .unix_permissions(0o755);

    let file_opt = SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated)
        .unix_permissions(0o644);

    let root_entry = format!("{}/", note_stem);
    zip.add_directory(&root_entry, dir_opt)
        .map_err(|e| format!("Erreur création dossier racine zip: {}", e))?;

    // Assurer la présence du dossier assets/ dans l'archive zip
    let assets_entry = format!("{}assets/", root_entry);
    zip.add_directory(&assets_entry, dir_opt)
        .map_err(|e| format!("Erreur création dossier assets zip: {}", e))?;

    // Ajouter le fichier markdown
    if md_file.is_file() {
        let data = fs::read(md_file).map_err(|e| e.to_string())?;
        let entry_name = format!("{}{}.md", root_entry, note_stem);
        zip.start_file(&entry_name, file_opt).map_err(|e| e.to_string())?;
        zip.write_all(&data).map_err(|e| e.to_string())?;
    }

    // Ajouter les assets
    if let Some(adir) = assets_dir {
        if adir.is_dir() {
            if let Ok(entries) = fs::read_dir(adir) {
                for entry in entries.flatten() {
                    let path = entry.path();
                    if path.is_file() {
                        let fname = match path.file_name().and_then(|s| s.to_str()) {
                            Some(n) => n,
                            None => continue,
                        };
                        if fname.starts_with('.') {
                            continue;
                        }
                        let data = fs::read(&path).map_err(|e| e.to_string())?;
                        let zip_path = format!("{}{}", assets_entry, fname);
                        zip.start_file(&zip_path, file_opt).map_err(|e| e.to_string())?;
                        zip.write_all(&data).map_err(|e| e.to_string())?;
                    }
                }
            }
        }
    }

    let cursor = zip.finish().map_err(|e| format!("Erreur finalisation zip: {}", e))?;
    Ok(cursor.into_inner())
}

/// Crée une archive zip contenant l'intégralité du dossier d'une note Markdown (rétrocompatibilité format bundle)
pub fn create_note_dir_zip(note_dir: &Path, note_stem: &str) -> Result<Vec<u8>, String> {
    use std::io::{Cursor, Write};
    use zip::write::SimpleFileOptions;
    use zip::ZipWriter;

    let mut zip = ZipWriter::new(Cursor::new(Vec::new()));

    let dir_opt = SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated)
        .unix_permissions(0o755);

    let file_opt = SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated)
        .unix_permissions(0o644);

    let root_entry = format!("{}/", note_stem);
    zip.add_directory(&root_entry, dir_opt)
        .map_err(|e| format!("Erreur création dossier racine zip: {}", e))?;

    // Assurer la présence du dossier assets/ dans l'archive zip
    let assets_dir = note_dir.join("assets");
    if !assets_dir.exists() {
        let assets_entry = format!("{}assets/", root_entry);
        zip.add_directory(&assets_entry, dir_opt)
            .map_err(|e| format!("Erreur création dossier assets zip: {}", e))?;
    }

    fn add_dir_contents<W: Write + std::io::Seek>(
        zip: &mut ZipWriter<W>,
        current_dir: &Path,
        zip_prefix: &str,
        dir_opt: SimpleFileOptions,
        file_opt: SimpleFileOptions,
    ) -> Result<(), String> {
        let entries = match fs::read_dir(current_dir) {
            Ok(e) => e,
            Err(_) => return Ok(()),
        };
        for entry in entries.flatten() {
            let path = entry.path();
            let file_name = entry.file_name().to_string_lossy().to_string();
            if file_name.starts_with('.') {
                continue;
            }
            let zip_path = format!("{}{}", zip_prefix, file_name);
            if path.is_dir() {
                let dir_path = format!("{}/", zip_path);
                zip.add_directory(&dir_path, dir_opt)
                    .map_err(|e| e.to_string())?;
                add_dir_contents(zip, &path, &dir_path, dir_opt, file_opt)?;
            } else if path.is_file() {
                let data = fs::read(&path).map_err(|e| e.to_string())?;
                zip.start_file(&zip_path, file_opt).map_err(|e| e.to_string())?;
                zip.write_all(&data).map_err(|e| e.to_string())?;
            }
        }
        Ok(())
    }

    add_dir_contents(&mut zip, note_dir, &root_entry, dir_opt, file_opt)?;

    let cursor = zip.finish().map_err(|e| format!("Erreur finalisation zip: {}", e))?;
    Ok(cursor.into_inner())
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

    #[test]
    fn test_solution1_assets_and_clean_orphan_assets() {
        let temp_dir = tempfile::tempdir().unwrap();
        let md_file = temp_dir.path().join("Ma Note.md");
        let assets_dir = temp_dir.path().join(".assets").join("Ma Note");
        fs::create_dir_all(&assets_dir).unwrap();

        fs::write(&md_file, "# Ma Note\n\n![Radio](/api/assets/Ma%20Note/radio.png)").unwrap();

        // Créer deux assets : un référencé (radio.png), un orphelin (unused.png)
        fs::write(assets_dir.join("radio.png"), b"PNG1").unwrap();
        fs::write(assets_dir.join("unused.png"), b"PNG2").unwrap();

        // 1. Nettoyage des assets orphelins
        let content = fs::read_to_string(&md_file).unwrap();
        let deleted = clean_orphan_markdown_assets(&assets_dir, &content);
        assert_eq!(deleted, vec!["unused.png".to_string()]);

        // Vérifier que radio.png est conservé et unused.png est supprimé
        assert!(assets_dir.join("radio.png").exists());
        assert!(!assets_dir.join("unused.png").exists());

        // 2. Si on supprime la référence à radio.png du markdown
        let updated_content = "# Ma Note\n\nTexte sans images.";
        let deleted_second = clean_orphan_markdown_assets(&assets_dir, updated_content);
        assert_eq!(deleted_second, vec!["radio.png".to_string()]);
        assert!(!assets_dir.join("radio.png").exists());
    }
}

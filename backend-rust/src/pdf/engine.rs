use image::{ImageFormat, Rgba};
use pdfium_render::prelude::*;
use std::num::NonZeroUsize;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use tracing::info;
use lru::LruCache;

pub struct PdfEngine {
    pdfium: Arc<Mutex<Pdfium>>,
    page_cache: Arc<Mutex<LruCache<(PathBuf, i64), Arc<(f64, f64, image::RgbaImage)>>>>,
}

// Pdfium est enveloppé dans un Mutex, garantissant qu'un seul thread y accède à la fois.
unsafe impl Send for PdfEngine {}
unsafe impl Sync for PdfEngine {}

impl PdfEngine {
    pub fn new() -> Result<Self, String> {
        // Tentative de chargement : bibliothèque locale ./lib ou système
        let lib_candidates = [
            PathBuf::from("lib/libpdfium.dylib"),
            PathBuf::from("backend-rust/lib/libpdfium.dylib"),
            PathBuf::from("../backend-rust/lib/libpdfium.dylib"),
            PathBuf::from("lib/libpdfium.so"),
            PathBuf::from("/usr/lib/libpdfium.so"),
            PathBuf::from("/usr/local/lib/libpdfium.dylib"),
        ];

        let mut pdfium_instance = None;
        for path in &lib_candidates {
            if path.exists() {
                let resolved_path = std::fs::canonicalize(path).unwrap_or_else(|_| path.clone());
                if let Ok(bindings) = Pdfium::bind_to_library(&resolved_path) {
                    info!("Pdfium lié avec succès depuis : {:?}", resolved_path);
                    pdfium_instance = Some(Pdfium::new(bindings));
                    break;
                }
            }
        }

        // Vérifier également dans le répertoire de l'exécutable courant
        if pdfium_instance.is_none() {
            if let Ok(exe_path) = std::env::current_exe() {
                if let Some(exe_dir) = exe_path.parent() {
                    for name in &["libpdfium.dylib", "libpdfium.so", "lib/libpdfium.dylib", "lib/libpdfium.so"] {
                        let candidate = exe_dir.join(name);
                        if candidate.exists() {
                            if let Ok(bindings) = Pdfium::bind_to_library(&candidate) {
                                info!("Pdfium lié avec succès depuis le répertoire exécutable : {:?}", candidate);
                                pdfium_instance = Some(Pdfium::new(bindings));
                                break;
                            }
                        }
                    }
                }
            }
        }

        let pdfium = match pdfium_instance {
            Some(p) => p,
            None => {
                // Fallback sur la bibliothèque système
                match Pdfium::bind_to_system_library() {
                    Ok(bindings) => Pdfium::new(bindings),
                    Err(e) => return Err(format!("Impossible de charger libpdfium : {}", e)),
                }
            }
        };

        Ok(Self {
            pdfium: Arc::new(Mutex::new(pdfium)),
            page_cache: Arc::new(Mutex::new(LruCache::new(NonZeroUsize::new(8).unwrap()))),
        })
    }

    /// Extrait les informations d'un PDF : nombre de pages, métadonnées, texte et mots par page.
    pub fn extract_document_data(&self, file_path: &Path) -> Result<ExtractedPdfData, String> {
        let pdfium = self.pdfium.lock().map_err(|e| e.to_string())?;
        let doc = pdfium
            .load_pdf_from_file(file_path, None)
            .map_err(|e| format!("Erreur chargement PDF : {}", e))?;

        let total_pages = doc.pages().len() as i64;
        let meta_title = doc
            .metadata()
            .get(PdfDocumentMetadataTagType::Title)
            .map(|s| s.value().trim().to_string())
            .unwrap_or_default();

        let mut pages_data = Vec::new();

        for page_idx in 0..total_pages as u16 {
            if let Ok(page) = doc.pages().get(page_idx) {
                let page_number = (page_idx + 1) as i64;
                let page_height = page.height().value as f64;

                let (text_content, words) = if let Ok(text_page) = page.text() {
                    let full_text = text_page.all();
                    let mut words_list = Vec::new();

                    for (seg_idx, seg) in text_page.segments().iter().enumerate() {
                        let seg_text = seg.text();
                        let bounds = seg.bounds();
                        let left = bounds.left().value as f64;
                        let right = bounds.right().value as f64;
                        let top = bounds.top().value as f64;
                        let bottom = bounds.bottom().value as f64;

                        // Conversion coordonnées PDF (bas-gauche) en coordonnées écran (haut-gauche)
                        let y0 = (page_height - top).max(0.0);
                        let y1 = (page_height - bottom).max(0.0);
                        let (y_min, y_max) = if y0 < y1 { (y0, y1) } else { (y1, y0) };

                        let words_in_seg: Vec<&str> = seg_text.split_whitespace().collect();
                        if words_in_seg.len() <= 1 {
                            let trimmed = seg_text.trim();
                            if !trimmed.is_empty() {
                                let word_val = serde_json::json!([
                                    (left * 10.0).round() / 10.0,
                                    (y_min * 10.0).round() / 10.0,
                                    (right * 10.0).round() / 10.0,
                                    (y_max * 10.0).round() / 10.0,
                                    trimmed,
                                    0,
                                    seg_idx as i64
                                ]);
                                words_list.push(word_val);
                            }
                        } else {
                            let total_chars = seg_text.chars().count().max(1) as f64;
                            let width = (right - left).max(1.0);
                            let char_width = width / total_chars;
                            let mut current_offset = 0.0;

                            for (w_idx, w) in words_in_seg.iter().enumerate() {
                                let w_len = w.chars().count() as f64;
                                let w_x0 = left + current_offset;
                                let w_x1 = w_x0 + (w_len * char_width);
                                current_offset += (w_len + 1.0) * char_width;

                                let word_val = serde_json::json!([
                                    (w_x0 * 10.0).round() / 10.0,
                                    (y_min * 10.0).round() / 10.0,
                                    (w_x1.min(right) * 10.0).round() / 10.0,
                                    (y_max * 10.0).round() / 10.0,
                                    w,
                                    0,
                                    (seg_idx * 100 + w_idx) as i64
                                ]);
                                words_list.push(word_val);
                            }
                        }
                    }
                    (full_text, words_list)
                } else {
                    (String::new(), Vec::new())
                };

                pages_data.push(ExtractedPageData {
                    page_number,
                    text_content,
                    words_json: serde_json::to_string(&words).unwrap_or_else(|_| "[]".to_string()),
                });
            }
        }

        Ok(ExtractedPdfData {
            total_pages,
            meta_title,
            pages: pages_data,
        })
    }

    /// Génère la vignette de couverture (première page) au format WebP.
    pub fn render_cover(
        &self,
        file_path: &Path,
        output_webp: &Path,
    ) -> Result<(), String> {
        let pdfium = self.pdfium.lock().map_err(|e| e.to_string())?;
        let doc = pdfium
            .load_pdf_from_file(file_path, None)
            .map_err(|e| e.to_string())?;

        if doc.pages().is_empty() {
            return Err("PDF sans page".to_string());
        }

        let first_page = doc.pages().get(0).map_err(|e| e.to_string())?;
        let width = first_page.width().value as f64;
        let scale = if width > 0.0 { 180.0 / width } else { 1.0 };
        let target_width = (width * scale).round() as i32;

        let render_config = PdfRenderConfig::new().set_target_width(target_width);
        let pixmap = first_page.render_with_config(&render_config).map_err(|e| e.to_string())?;
        let img = pixmap.as_image();

        if let Some(parent) = output_webp.parent() {
            std::fs::create_dir_all(parent).ok();
        }

        img.save_with_format(output_webp, ImageFormat::WebP)
            .map_err(|e| e.to_string())?;

        Ok(())
    }

    fn render_page_internal(
        &self,
        file_path: &Path,
        page_number: i64,
        render_scale: f64,
    ) -> Result<(f64, f64, image::RgbaImage), String> {
        let pdfium = self.pdfium.lock().map_err(|e| e.to_string())?;
        let doc = pdfium
            .load_pdf_from_file(file_path, None)
            .map_err(|e| e.to_string())?;
        let page_idx = (page_number - 1) as u16;
        let page = doc.pages().get(page_idx).map_err(|e| e.to_string())?;
        let pw = page.width().value as f64;
        let ph = page.height().value as f64;
        let target_w = (pw * render_scale).round() as i32;
        let render_config = PdfRenderConfig::new().set_target_width(target_w);
        let pixmap = page.render_with_config(&render_config).map_err(|e| e.to_string())?;
        let rendered = pixmap.as_image().to_rgba8();
        Ok((pw, ph, rendered))
    }

    /// Génère une vignette cropée avec surbrillance jaune translucide autour de l'occurrence.
    pub fn render_crop(
        &self,
        file_path: &Path,
        page_number: i64,
        rect: [f64; 4],
        output_webp: &Path,
        highlight_rects: &[[f64; 4]],
    ) -> Result<(), String> {
        let render_scale = 1.5;

        // Récupération de la page rendue (depuis le cache LRU en RAM ou rendu Pdfium)
        let page_data = {
            let mut cache = self.page_cache.lock().map_err(|e| e.to_string())?;
            let key = (file_path.to_path_buf(), page_number);
            if let Some(cached) = cache.get(&key) {
                Arc::clone(cached)
            } else {
                let (pw, ph, rendered) = self.render_page_internal(file_path, page_number, render_scale)?;
                let entry = Arc::new((pw, ph, rendered));
                cache.put(key, Arc::clone(&entry));
                entry
            }
        };

        let page_width = page_data.0;
        let page_height = page_data.1;
        let raw_img = &page_data.2;

        let bounds = search_core::crop::calculate_crop_bounds(rect, page_width, page_height, None, None);
        let crop_x0 = bounds.x0;
        let crop_y0 = bounds.y0;
        let crop_x1 = bounds.x1;
        let crop_y1 = bounds.y1;

        // Découpe immédiate du rectangle de crop depuis l'image source brute en RAM
        let cx = (crop_x0 * render_scale).round() as u32;
        let cy = (crop_y0 * render_scale).round() as u32;
        let cw = (((crop_x1 - crop_x0) * render_scale).round() as u32).max(1);
        let ch = (((crop_y1 - crop_y0) * render_scale).round() as u32).max(1);

        // Cloner uniquement le rectangle découpé (ex: 250x120 px au lieu de 1200x1600 px !)
        let mut cropped = image::imageops::crop_imm(raw_img, cx, cy, cw, ch).to_image();

        // Incrustation du surlignage jaune semi-transparent uniquement sur la zone découpée
        let yellow_color = Rgba(search_core::crop::GOODNOTES_YELLOW_RGBA);
        let all_hl = if highlight_rects.is_empty() {
            vec![rect]
        } else {
            highlight_rects.to_vec()
        };

        for hl in all_hl {
            let hx0 = (hl[0] * render_scale).round() as i64;
            let hy0 = (hl[1] * render_scale).round() as i64;
            let hx1 = (hl[2] * render_scale).round() as i64;
            let hy1 = (hl[3] * render_scale).round() as i64;

            // Coordonnées relatives à la vignette découpée
            let rx0 = (hx0 - cx as i64).clamp(0, cw as i64) as u32;
            let ry0 = (hy0 - cy as i64).clamp(0, ch as i64) as u32;
            let rx1 = (hx1 - cx as i64).clamp(0, cw as i64) as u32;
            let ry1 = (hy1 - cy as i64).clamp(0, ch as i64) as u32;

            for py in ry0..ry1 {
                for px in rx0..rx1 {
                    let current = cropped.get_pixel(px, py);
                    let r = ((current[0] as u32 * 127 + yellow_color[0] as u32 * 128) / 255).min(255) as u8;
                    let g = ((current[1] as u32 * 127 + yellow_color[1] as u32 * 128) / 255).min(255) as u8;
                    let b = ((current[2] as u32 * 127 + yellow_color[2] as u32 * 128) / 255).min(255) as u8;
                    cropped.put_pixel(px, py, Rgba([r, g, b, 255]));
                }
            }
        }

        if let Some(parent) = output_webp.parent() {
            if !parent.exists() {
                std::fs::create_dir_all(parent).ok();
            }
        }

        cropped
            .save_with_format(output_webp, ImageFormat::WebP)
            .map_err(|e| e.to_string())?;

        Ok(())
    }
}

pub struct ExtractedPageData {
    pub page_number: i64,
    pub text_content: String,
    pub words_json: String,
}

pub struct ExtractedPdfData {
    pub total_pages: i64,
    pub meta_title: String,
    pub pages: Vec<ExtractedPageData>,
}

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
            // 150 pages en cache : couvre 15 docs × 5 pages/doc + marge pour le scroll infini
            // (était 32, saturé dès la première recherche retournant >32 pages distinctes)
            page_cache: Arc::new(Mutex::new(LruCache::new(NonZeroUsize::new(150).unwrap()))),
        })
    }

    /// Métadonnées rapides (nombre de pages + titre) sans itérer sur les pages.
    pub fn extract_document_metadata(&self, file_path: &Path) -> Result<StreamedPdfMetadata, String> {
        let pdfium = self.pdfium.lock().map_err(|e| e.to_string())?;
        let doc = pdfium
            .load_pdf_from_file(file_path, None)
            .map_err(|e| format!("Erreur chargement PDF : {}", e))?;

        Ok(StreamedPdfMetadata {
            total_pages: doc.pages().len() as i64,
            meta_title: doc
                .metadata()
                .get(PdfDocumentMetadataTagType::Title)
                .map(|s| s.value().trim().to_string())
                .unwrap_or_default(),
        })
    }

    /// Extrait le document page par page en flux : chaque page est transmise au callback
    /// (typiquement une insertion DB) puis libérée — la RAM reste bornée à une seule page,
    /// quel que soit le nombre de pages (correctif OOM sur les livres de 900+ pages).
    pub fn extract_pages_streaming(
        &self,
        file_path: &Path,
        mut on_page: impl FnMut(i64, String, String) -> Result<(), String>,
    ) -> Result<i64, String> {
        let pdfium = self.pdfium.lock().map_err(|e| e.to_string())?;
        let doc = pdfium
            .load_pdf_from_file(file_path, None)
            .map_err(|e| format!("Erreur chargement PDF : {}", e))?;

        let total_pages = doc.pages().len() as i64;

        for page_idx in 0..total_pages as u16 {
            if let Ok(page) = doc.pages().get(page_idx) {
                let page_number = (page_idx + 1) as i64;
                let page_height = page.height().value as f64;

                // Spécification PDF ISO 32000-1 (section 14.11.2) :
                // Les segments de texte sont rapportés dans le repère MediaBox, tandis que le rendu
                // (Pdfium et PDF.js) s'effectue dans la boîte visible CropBox (ou son intersection avec MediaBox).
                // On calcule l'origine (c_min_x, c_max_y) de la zone visible pour aligner exactement
                // les coordonnées extraites avec l'image rendue à l'écran.
                let mb_opt = page.boundaries().media().ok().map(|m| {
                    let b = &m.bounds;
                    let l = b.left().value as f64;
                    let r = b.right().value as f64;
                    let btm = b.bottom().value as f64;
                    let tp = b.top().value as f64;
                    (l.min(r), btm.min(tp), l.max(r), btm.max(tp))
                });
                let cb_opt = page.boundaries().crop().ok().map(|c| {
                    let b = &c.bounds;
                    let l = b.left().value as f64;
                    let r = b.right().value as f64;
                    let btm = b.bottom().value as f64;
                    let tp = b.top().value as f64;
                    (l.min(r), btm.min(tp), l.max(r), btm.max(tp))
                });
                let (c_min_x, c_max_y) = match (mb_opt, cb_opt) {
                    (Some(mb), Some(cb)) => {
                        let box_left = mb.0.max(cb.0);
                        let box_top = mb.3.min(cb.3);
                        (box_left, box_top)
                    }
                    (Some(mb), None) => (mb.0, mb.3),
                    (None, Some(cb)) => (cb.0, cb.3),
                    (None, None) => (0.0, page_height),
                };

                let (text_content, words_list) = if let Ok(text_page) = page.text() {
                    let full_text = text_page.all();
                    let mut words_list = Vec::new();

                    for (seg_idx, seg) in text_page.segments().iter().enumerate() {
                        let seg_text = seg.text();
                        let bounds = seg.bounds();
                        let raw_left = bounds.left().value as f64;
                        let raw_right = bounds.right().value as f64;
                        let raw_top = bounds.top().value as f64;
                        let raw_bottom = bounds.bottom().value as f64;

                        // Coordonnées X décalées dans le repère de la zone visible
                        let left = (raw_left - c_min_x).max(0.0);
                        let right = (raw_right - c_min_x).max(0.0);

                        // Conversion coordonnées PDF Y (bas-gauche) en coordonnées écran (haut-gauche dans CropBox)
                        let y0 = (c_max_y - raw_top).max(0.0);
                        let y1 = (c_max_y - raw_bottom).max(0.0);
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

                let words_json = serde_json::to_string(&words_list).unwrap_or_else(|_| "[]".to_string());
                drop(words_list);
                on_page(page_number, text_content, words_json)?;
            }
        }

        Ok(total_pages)
    }

    /// Génère la vignette de couverture (première page) au format WebP.
    /// Rend la couverture (1ère page) en mémoire et retourne les octets WebP.
    /// Aucun cache disque : l'image reflète toujours le fichier courant.
    pub fn render_cover(
        &self,
        file_path: &Path,
    ) -> Result<Vec<u8>, String> {
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

        let mut buffer = std::io::Cursor::new(Vec::new());
        img.write_to(&mut buffer, ImageFormat::WebP)
            .map_err(|e| e.to_string())?;

        Ok(buffer.into_inner())
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

    pub fn get_or_render_page(
        &self,
        file_path: &Path,
        page_number: i64,
        render_scale: f64,
    ) -> Result<Arc<(f64, f64, image::RgbaImage)>, String> {
        let key = (file_path.to_path_buf(), page_number);

        // 1. Consultation rapide sans maintenir le verrou pendant le rendu
        {
            let mut cache = self.page_cache.lock().map_err(|e| e.to_string())?;
            if let Some(cached) = cache.get(&key) {
                return Ok(Arc::clone(cached));
            }
        }

        // 2. Rendu Pdfium en dehors du verrou page_cache (permet aux autres threads de lire le cache librement)
        let (pw, ph, rendered) = self.render_page_internal(file_path, page_number, render_scale)?;
        let entry = Arc::new((pw, ph, rendered));

        // 3. Réinsertion sous verrou court
        {
            let mut cache = self.page_cache.lock().map_err(|e| e.to_string())?;
            cache.put(key, Arc::clone(&entry));
        }

        Ok(entry)
    }

    /// Découpe et applique le surlignage sur une image de page déjà rendue en mémoire
    pub fn crop_from_rendered_page(
        page_data: &(f64, f64, image::RgbaImage),
        render_scale: f64,
        rect: [f64; 4],
        highlight_rects: &[[f64; 4]],
    ) -> Result<Vec<u8>, String> {
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

        let mut buffer = std::io::Cursor::new(Vec::new());
        cropped
            .write_to(&mut buffer, ImageFormat::WebP)
            .map_err(|e| e.to_string())?;

        Ok(buffer.into_inner())
    }

    /// Génère une vignette cropée avec surbrillance jaune translucide autour de l'occurrence.
    pub fn render_crop(
        &self,
        file_path: &Path,
        page_number: i64,
        rect: [f64; 4],
        highlight_rects: &[[f64; 4]],
    ) -> Result<Vec<u8>, String> {
        let render_scale = 1.5;
        let page_data = self.get_or_render_page(file_path, page_number, render_scale)?;
        Self::crop_from_rendered_page(&page_data, render_scale, rect, highlight_rects)
    }

    /// Génère plusieurs vignettes d'une même page en effectuant le rendu Pdfium une seule fois.
    pub fn render_crops_for_page_multi(
        &self,
        file_path: &Path,
        page_number: i64,
        targets: &[(usize, [f64; 4], Vec<[f64; 4]>)],
    ) -> Result<Vec<(usize, Vec<u8>)>, String> {
        let render_scale = 1.5;
        let page_data = self.get_or_render_page(file_path, page_number, render_scale)?;
        let mut results = Vec::with_capacity(targets.len());
        for (occ_id, rect, hl) in targets {
            if let Ok(bytes) = Self::crop_from_rendered_page(&page_data, render_scale, *rect, hl) {
                results.push((*occ_id, bytes));
            }
        }
        Ok(results)
    }
}

pub struct StreamedPdfMetadata {
    pub total_pages: i64,
    pub meta_title: String,
}

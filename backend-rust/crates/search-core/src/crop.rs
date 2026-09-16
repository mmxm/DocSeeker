use serde::{Deserialize, Serialize};
pub use crate::constants::{DEFAULT_CROP_HEIGHT, DEFAULT_CROP_WIDTH, GOODNOTES_YELLOW_RGBA, GOODNOTES_YELLOW_CSS, CROP_RENDER_SCALE};

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub struct CropBounds {
    pub x0: f64,
    pub y0: f64,
    pub x1: f64,
    pub y1: f64,
    pub width: f64,
    pub height: f64,
}

/// Calcule la sous-région (crop box) d'une occurrence centrée et limitée aux bords de la page.
/// Logique STRICTEMENT partagée entre le backend Rust (Pdfium) et le frontend (PDF.js / Wasm).
pub fn calculate_crop_bounds(
    rect: [f64; 4],
    page_width: f64,
    page_height: f64,
    crop_width: Option<f64>,
    crop_height: Option<f64>,
) -> CropBounds {
    let [x0, y0, x1, y1] = rect;
    let occ_center_x = (x0 + x1) / 2.0;
    let occ_center_y = (y0 + y1) / 2.0;

    let target_w = crop_width.unwrap_or(DEFAULT_CROP_WIDTH);
    let target_h = crop_height.unwrap_or(DEFAULT_CROP_HEIGHT);

    let mut crop_x0 = (occ_center_x - target_w / 2.0).max(0.0);
    let crop_x1 = (crop_x0 + target_w).min(page_width);
    if crop_x1 == page_width {
        crop_x0 = (crop_x1 - target_w).max(0.0);
    }

    let mut crop_y0 = (occ_center_y - target_h / 2.0).max(0.0);
    let crop_y1 = (crop_y0 + target_h).min(page_height);
    if crop_y1 == page_height {
        crop_y0 = (crop_y1 - target_h).max(0.0);
    }

    let width = (crop_x1 - crop_x0).max(1.0);
    let height = (crop_y1 - crop_y0).max(1.0);

    CropBounds {
        x0: crop_x0,
        y0: crop_y0,
        x1: crop_x1,
        y1: crop_y1,
        width,
        height,
    }
}

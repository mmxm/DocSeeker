/// Constantes algorithmiques et visuelles partagées strictement entre le serveur Rust distant et le client WebAssembly local.

/// Nombre maximum d'occurrences / vignettes exposées dans le ruban horizontal d'un document lors d'une recherche globale
pub const MAX_OCCURRENCES_PER_DOC: usize = 25;

/// Dimensions standardisées des vignettes d'extraits (crops)
pub const DEFAULT_CROP_WIDTH: f64 = 300.0;
pub const DEFAULT_CROP_HEIGHT: f64 = 120.0;

/// Échelle de rendu raster (1.5x pour netteté haute résolution Retina sans surcharger la mémoire)
pub const CROP_RENDER_SCALE: f64 = 1.5;

/// Couleur de surlignage Goodnotes (Jaune semi-transparent)
pub const GOODNOTES_YELLOW_RGBA: [u8; 4] = [255, 224, 51, 128]; // [R, G, B, A=0.5]
pub const GOODNOTES_YELLOW_CSS: &str = "rgba(255, 224, 51, 0.5)";

/// Nombre maximum de pages renvoyées par document lors de la requête SQL FTS5
pub const MAX_MATCHING_PAGES_PER_DOC: usize = 5;

/// Bonus de score de pertinence pour titre de document
pub const TITLE_MATCH_BONUS: f64 = 1500.0;

/// Bonus de grand titre de chapitre dans le corps du texte (police > 10 pt)
pub const FONT_SIZE_BONUS_THRESHOLD: f64 = 10.0;
pub const FONT_SIZE_BONUS_MULTIPLIER: f64 = 25.0;
pub const FONT_SIZE_BONUS_MAX: f64 = 400.0;

/// Bonus multi-termes
pub const MULTI_TERMS_ALL_MATCHED_BONUS: f64 = 5000.0;
pub const MULTI_TERMS_PARTIAL_MATCHED_BONUS: f64 = 2000.0;

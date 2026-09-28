use std::path::Path;

#[derive(Debug, Clone)]
pub struct ExtractedPage {
    pub page_number: i32,
    pub text_content: String,
    pub words_json: Option<String>,
}

#[derive(Debug, Clone)]
pub struct DocumentMetadata {
    pub total_pages: i32,
    pub title: String,
}

pub trait DocumentProcessor: Send + Sync {
    fn doc_type(&self) -> &'static str;
    fn supported_extensions(&self) -> &[&str];
    fn extract_metadata(&self, file_path: &Path, original_filename: &str) -> Result<DocumentMetadata, String>;
    fn extract_pages(&self, file_path: &Path) -> Result<Vec<ExtractedPage>, String>;
    fn generate_cover(&self, file_path: &Path, cover_path: &Path, doc_id: i64) -> Result<(), String>;
}

/// Détecte le type de document à partir de l'extension
pub fn detect_doc_type(path: &Path) -> &'static str {
    match path.extension().and_then(|e| e.to_str()).map(|s| s.to_ascii_lowercase()) {
        Some(ext) if ext == "pdf" => "pdf",
        Some(ext) if ext == "md" || ext == "markdown" => "markdown",
        Some(ext) if ext == "txt" => "text",
        _ => "pdf",
    }
}

/// Vérifie si un fichier est un document pris en charge
pub fn is_supported_document(path: &Path) -> bool {
    matches!(
        path.extension().and_then(|e| e.to_str()).map(|s| s.to_ascii_lowercase()),
        Some(ext) if ext == "pdf" || ext == "md" || ext == "markdown" || ext == "txt"
    )
}

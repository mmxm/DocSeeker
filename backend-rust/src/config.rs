use std::path::PathBuf;

#[derive(Clone, Debug)]
pub struct Config {
    pub host: String,
    pub port: u16,
    pub data_dir: PathBuf,
    pub documents_dir: PathBuf,
    pub cache_dir: PathBuf,
    pub covers_dir: PathBuf,
    pub db_path: PathBuf,
    pub max_upload_size: usize,
    pub session_duration_days: i64,
    pub default_admin_password: Option<String>,
}

impl Config {
    pub fn from_env() -> Self {
        dotenvy::dotenv().ok();

        let host = std::env::var("HOST").unwrap_or_else(|_| "0.0.0.0".to_string());
        let port = std::env::var("PORT")
            .ok()
            .and_then(|p| p.parse().ok())
            .unwrap_or(8080);

        let base_data_dir = std::env::var("DATA_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|_| {
                // Si exécuté depuis la racine ou backend-rust, pointer vers data/
                if std::path::Path::new("data").exists() {
                    PathBuf::from("data")
                } else if std::path::Path::new("../data").exists() {
                    PathBuf::from("../data")
                } else {
                    PathBuf::from("data")
                }
            });

        let documents_dir = base_data_dir.join("documents");
        let cache_dir = base_data_dir.join("cache_crops");
        let covers_dir = cache_dir.join("covers");
        let db_path = base_data_dir.join("db.sqlite");

        // Taille d'upload max par défaut : 2 Go
        let max_upload_size = std::env::var("MAX_UPLOAD_SIZE")
            .ok()
            .and_then(|s| {
                let s = s.trim().to_uppercase();
                if let Some(num) = s.strip_suffix("GB") {
                    num.parse::<usize>().ok().map(|n| n * 1024 * 1024 * 1024)
                } else if let Some(num) = s.strip_suffix("MB") {
                    num.parse::<usize>().ok().map(|n| n * 1024 * 1024)
                } else {
                    s.parse::<usize>().ok()
                }
            })
            .unwrap_or(2 * 1024 * 1024 * 1024);

        let session_duration_days = std::env::var("SESSION_DURATION_DAYS")
            .ok()
            .and_then(|d| d.parse().ok())
            .unwrap_or(30);

        let default_admin_password = std::env::var("ADMIN_PASSWORD")
            .or_else(|_| std::env::var("BASIC_AUTH_PASSWORD"))
            .ok()
            .filter(|p| !p.trim().is_empty());

        Self {
            host,
            port,
            data_dir: base_data_dir,
            documents_dir,
            cache_dir,
            covers_dir,
            db_path,
            max_upload_size,
            session_duration_days,
            default_admin_password,
        }
    }

    pub fn ensure_directories(&self) -> std::io::Result<()> {
        std::fs::create_dir_all(&self.data_dir)?;
        std::fs::create_dir_all(&self.documents_dir)?;
        std::fs::create_dir_all(&self.cache_dir)?;
        std::fs::create_dir_all(&self.covers_dir)?;
        Ok(())
    }
}

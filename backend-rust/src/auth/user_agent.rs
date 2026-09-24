use serde::Serialize;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct ParsedUserAgent {
    pub os: String,
    pub browser: String,
    pub device_type: String, // "desktop", "mobile", "tablet", "unknown"
}

impl ParsedUserAgent {
    pub fn parse(ua: &str) -> Self {
        let ua_lower = ua.to_lowercase();

        // 1. Détection de l'appareil (Device Type) & de l'OS
        let (os, device_type) = if ua_lower.contains("ipad") {
            ("iPadOS".to_string(), "tablet".to_string())
        } else if ua_lower.contains("iphone") {
            ("iOS".to_string(), "mobile".to_string())
        } else if ua_lower.contains("android") {
            if ua_lower.contains("mobile") {
                ("Android".to_string(), "mobile".to_string())
            } else {
                ("Android".to_string(), "tablet".to_string())
            }
        } else if ua_lower.contains("macintosh") || ua_lower.contains("mac os x") {
            ("macOS".to_string(), "desktop".to_string())
        } else if ua_lower.contains("windows") {
            ("Windows".to_string(), "desktop".to_string())
        } else if ua_lower.contains("cros") {
            ("ChromeOS".to_string(), "desktop".to_string())
        } else if ua_lower.contains("linux") {
            ("Linux".to_string(), "desktop".to_string())
        } else {
            ("Système inconnu".to_string(), "unknown".to_string())
        };

        // 2. Détection du Navigateur
        // Ordre d'évaluation important car Chrome et Safari figurent souvent dans d'autres UA
        let browser = if ua_lower.contains("edg/") || ua_lower.contains("edge/") {
            "Microsoft Edge".to_string()
        } else if ua_lower.contains("opr/") || ua_lower.contains("opera") {
            "Opera".to_string()
        } else if ua_lower.contains("firefox/") || ua_lower.contains("fxios/") {
            "Firefox".to_string()
        } else if ua_lower.contains("crios/") {
            "Chrome".to_string()
        } else if ua_lower.contains("chrome/") {
            "Chrome".to_string()
        } else if ua_lower.contains("safari/") && !ua_lower.contains("chrome") {
            "Safari".to_string()
        } else if ua_lower.contains("playwright") || ua_lower.contains("headless") {
            "Navigateur automatisé".to_string()
        } else if ua.trim().is_empty() {
            "Inconnu".to_string()
        } else {
            "Navigateur Web".to_string()
        };

        Self {
            os,
            browser,
            device_type,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_mac_safari() {
        let ua = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15";
        let parsed = ParsedUserAgent::parse(ua);
        assert_eq!(parsed.os, "macOS");
        assert_eq!(parsed.browser, "Safari");
        assert_eq!(parsed.device_type, "desktop");
    }

    #[test]
    fn test_iphone_safari() {
        let ua = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";
        let parsed = ParsedUserAgent::parse(ua);
        assert_eq!(parsed.os, "iOS");
        assert_eq!(parsed.browser, "Safari");
        assert_eq!(parsed.device_type, "mobile");
    }

    #[test]
    fn test_windows_chrome() {
        let ua = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
        let parsed = ParsedUserAgent::parse(ua);
        assert_eq!(parsed.os, "Windows");
        assert_eq!(parsed.browser, "Chrome");
        assert_eq!(parsed.device_type, "desktop");
    }

    #[test]
    fn test_android_mobile() {
        let ua = "Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36";
        let parsed = ParsedUserAgent::parse(ua);
        assert_eq!(parsed.os, "Android");
        assert_eq!(parsed.browser, "Chrome");
        assert_eq!(parsed.device_type, "mobile");
    }

    #[test]
    fn test_ipad() {
        let ua = "Mozilla/5.0 (iPad; CPU OS 16_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.5 Mobile/15E148 Safari/604.1";
        let parsed = ParsedUserAgent::parse(ua);
        assert_eq!(parsed.os, "iPadOS");
        assert_eq!(parsed.browser, "Safari");
        assert_eq!(parsed.device_type, "tablet");
    }
}

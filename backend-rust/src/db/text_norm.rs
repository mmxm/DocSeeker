use unicode_normalization::UnicodeNormalization;

/// Supprime les accents et convertit en minuscules pour comparaison uniforme (identique au Python).
pub fn normalize_text(text: &str) -> String {
    if text.is_empty() {
        return String::new();
    }
    // Fast path ultra-rapide pour l'ASCII pur (>85% des mots)
    if text.is_ascii() {
        return text.to_ascii_lowercase();
    }

    // Décomposition canonique NFD et filtrage des diacritiques (combining marks)
    text.nfd()
        .filter(|&c| !is_diacritic_combining_mark(c))
        .collect::<String>()
        .to_lowercase()
}

/// Détecte si un caractère Unicode est une marque diacritique combinatoire (Unicode Category Mn).
fn is_diacritic_combining_mark(c: char) -> bool {
    matches!(c,
        '\u{0300}'..='\u{036F}' | // Combining Diacritical Marks
        '\u{1AB0}'..='\u{1AFF}' | // Combining Diacritical Marks Extended
        '\u{1DC0}'..='\u{1DFF}' | // Combining Diacritical Marks Supplement
        '\u{20D0}'..='\u{20FF}' | // Combining Diacritical Marks for Symbols
        '\u{FE20}'..='\u{FE2F}'   // Combining Half Marks
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_normalize_text() {
        assert_eq!(normalize_text(""), "");
        assert_eq!(normalize_text("Hémorragie"), "hemorragie");
        assert_eq!(normalize_text("ÉTÉ"), "ete");
        assert_eq!(normalize_text("général"), "general");
        assert_eq!(normalize_text("accentué"), "accentue");
        assert_eq!(normalize_text("Hello World"), "hello world");
        assert_eq!(normalize_text("L'utérus"), "l'uterus");
    }
}

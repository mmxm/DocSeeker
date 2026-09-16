use unicode_normalization::UnicodeNormalization;

/// Supprime les accents et convertit en minuscules pour comparaison uniforme.
pub fn normalize_text(text: &str) -> String {
    if text.is_empty() {
        return String::new();
    }
    if text.is_ascii() {
        return text.to_ascii_lowercase();
    }

    text.nfd()
        .filter(|&c| !is_diacritic_combining_mark(c))
        .collect::<String>()
        .to_lowercase()
}

fn is_diacritic_combining_mark(c: char) -> bool {
    matches!(c,
        '\u{0300}'..='\u{036F}' |
        '\u{1AB0}'..='\u{1AFF}' |
        '\u{1DC0}'..='\u{1DFF}' |
        '\u{20D0}'..='\u{20FF}' |
        '\u{FE20}'..='\u{FE2F}'
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
    }
}

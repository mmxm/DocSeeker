use argon2::{
    password_hash::{rand_core::OsRng, PasswordHash, PasswordHasher, PasswordVerifier, SaltString},
    Argon2, Params,
};

pub fn hash_password(password: &str) -> Result<String, String> {
    let salt = SaltString::generate(&mut OsRng);
    // Paramètres Argon2id robustes et calibrés (64 Mo de RAM, 3 itérations, 2 threads)
    let params = Params::new(65536, 3, 2, None).map_err(|e| e.to_string())?;
    let argon2 = Argon2::new(argon2::Algorithm::Argon2id, argon2::Version::V0x13, params);

    argon2
        .hash_password(password.as_bytes(), &salt)
        .map(|h| h.to_string())
        .map_err(|e| e.to_string())
}

pub fn verify_password(password: &str, password_hash: &str) -> bool {
    let parsed_hash = match PasswordHash::new(password_hash) {
        Ok(h) => h,
        Err(_) => return false,
    };

    Argon2::default()
        .verify_password(password.as_bytes(), &parsed_hash)
        .is_ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_argon2id_hashing_and_verification() {
        let password = "SuperSecretPassword123!";
        let hash = hash_password(password).expect("Le hachage a échoué");

        assert!(hash.starts_with("$argon2id$"));
        assert!(verify_password(password, &hash));
        assert!(!verify_password("WrongPassword", &hash));
    }
}

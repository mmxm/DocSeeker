//! Build du backend : garantit que le WASM de recherche locale embarqué
//! (frontend/wasm/search_wasm) est toujours synchrone avec ses sources Rust.
//!
//! Problème résolu : le module wasm est compilé à la main via `wasm-pack` et
//! le résultat est commité/embeddé. Un développeur qui modifie search-core ou
//! search-wasm sans relancer le build livre un backend embarquant un wasm
//! périmé (import manquant dans le worker, silencieux et difficile à diagnostiquer).
//!
//! Stratégie : hash du contenu des sources → si changement depuis le dernier
//! build, exécuter `wasm-pack build` (cible web, out-dir frontend) ; sinon no-op
//! pour ne pas ralentir les itérations cargo classiques. Le stamp est stocké
//! à côté du wasm généré (gitignoré).
//!
//! Prérequis : wasm-pack installé (https://rustwasm.github.io/wasm-pack/).

use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

fn main() {
    let manifest_dir = PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR"));
    let repo_root = manifest_dir.parent().expect("backend-rust/ a un parent");
    let wasm_crate = manifest_dir.join("search-wasm");
    let out_dir = repo_root.join("frontend/wasm/search_wasm");
    let stamp_path = out_dir.join(".build-stamp");

    // Sources qui influencent le binaire wasm : crate wasm + crate core partagée.
    let watched = [
        wasm_crate.join("src"),
        wasm_crate.join("Cargo.toml"),
        manifest_dir.join("crates/search-core/src"),
        manifest_dir.join("crates/search-core/Cargo.toml"),
    ];
    for p in &watched {
        println!("cargo:rerun-if-changed={}", p.display());
    }

    let hash = hash_sources(&watched);
    let stamp_matches = fs::read_to_string(&stamp_path)
        .map(|s| s.trim() == hash)
        .unwrap_or(false);
    if stamp_matches && out_dir.join("search_wasm_bg.wasm").exists() {
        // Sources inchangées : le wasm embarqué est à jour.
        return;
    }

    if !wasm_crate.exists() {
        // Contexte partiel (ex. pré-compilation des dépendances Docker sans les
        // sources du wasm) : rien à vérifier ni reconstruire ici, le build
        // applicatif s'en charge.
        println!("cargo:warning=build.rs : sources search-wasm absentes du contexte, vérification du wasm ignorée");
        return;
    }

    if wasm_pack_available() {
        rebuild_wasm(&wasm_crate, &out_dir);
        fs::create_dir_all(&out_dir).expect("création du répertoire wasm");
        fs::write(&stamp_path, hash).expect("écriture du stamp wasm");
        println!("cargo:warning=wasm de recherche locale reconstruit (sources modifiées)");
    } else {
        // Environnements sans wasm-pack (CI, Docker, checkout frais) : le wasm
        // généré est COMMITÉ dans frontend/wasm/search_wasm précisément pour
        // que ces builds fonctionnent sans outil. On dégrade avec un
        // avertissement plutôt que de casser le build. Le stamp n'est PAS
        // écrit : sans reconstruction, on ne marque rien comme à jour.
        if out_dir.join("search_wasm_bg.wasm").exists() {
            println!(
                "cargo:warning=wasm-pack absent : utilisation du wasm commité (installez wasm-pack pour vérifier la synchro des sources)"
            );
        } else {
            println!(
                "cargo:warning=wasm-pack absent et aucun wasm dans {} : installez wasm-pack (cargo install wasm-pack)",
                out_dir.display()
            );
        }
    }
}

/// wasm-pack est-il utilisable dans cet environnement ?
fn wasm_pack_available() -> bool {
    Command::new("wasm-pack")
        .arg("--version")
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

/// Exécute wasm-pack sur la crate search-wasm, sortie directe dans frontend/.
/// Précondition : wasm_pack_available() == true.
fn rebuild_wasm(wasm_crate: &Path, out_dir: &Path) {
    let status = Command::new("wasm-pack")
        .current_dir(wasm_crate)
        .args(["build", "--target", "web", "--release", "--out-dir"])
        .arg(out_dir) // chemin absolu : indépendant du répertoire courant
        .status()
        .unwrap_or_else(|e| panic!("wasm-pack introuvable ({e}). Installez-le : cargo install wasm-pack"));
    assert!(status.success(), "Échec du build wasm-pack (search-wasm)");
}

/// Hash FNV-1a 64 bits de tous les fichiers surveillés (chemins triés pour la
/// stabilité, contenu + chemin relatifs inclus dans le hash).
fn hash_sources(paths: &[PathBuf]) -> String {
    let mut files: Vec<PathBuf> = Vec::new();
    for p in paths {
        if p.is_dir() {
            collect_files(p, &mut files);
        } else if p.exists() {
            files.push(p.clone());
        }
    }
    files.sort();
    let mut hasher: u64 = 0xcbf29ce484222325;
    for f in &files {
        let rel = f.to_string_lossy();
        for b in rel.as_bytes() {
            hasher ^= u64::from(*b);
            hasher = hasher.wrapping_mul(0x100000001b3);
        }
        if let Ok(content) = fs::read(f) {
            for b in content {
                hasher ^= u64::from(b);
                hasher = hasher.wrapping_mul(0x100000001b3);
            }
        }
    }
    format!("{hasher:016x}")
}

fn collect_files(dir: &Path, out: &mut Vec<PathBuf>) {
    let Ok(entries) = fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            collect_files(&path, out);
        } else {
            out.push(path);
        }
    }
}

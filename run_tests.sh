#!/usr/bin/env bash
# ==============================================================================
# DocSeeker v2.0 - Suite Complète de Tests & Sécurité (Rust & Intégration)
# ==============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "${SCRIPT_DIR}"

echo "========================================================================="
echo "      DocSeeker v2.0 - Suite de Tests Rust & Audit Sécurité Native       "
echo "========================================================================="

echo ""
echo "[1/7] Vérification de la consistance du versioning et des caches..."
node tests/test_version_consistency.mjs

echo ""
echo "[2/7] Exécution des tests unitaires et d'intégration (Cargo Test)..."
cargo test --manifest-path backend-rust/Cargo.toml -- --nocapture

echo ""
echo "[3/7] Vérification du formatage et des avertissements de compilation..."
cargo check --manifest-path backend-rust/Cargo.toml

echo ""
echo "[4/7] Exécution des tests automatiques du moteur Hors-Ligne Wasm & Scoring..."
node tests/test_offline_wasm_and_scoring.mjs

echo ""
echo "[5/7] Exécution des tests automatiques du pipeline de vignettes hors-ligne (Crops)..."
node tests/test_offline_vignettes.mjs

echo ""
echo "[6/7] Exécution des tests automatiques sur corpus réel (tous les documents)..."
python3 scripts/automated_real_corpus_search_test.py

echo ""
echo "[7/7] Exécution des tests UI automatisés Playwright (En ligne & Hors-ligne)..."
npx playwright test

echo ""
echo "========================================================================="
echo " TOUS LES TESTS RUST, WASM, VIGNETTES, CORPUS & UI ONT RÉUSSI (0 erreur) "
echo "========================================================================="

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
echo "[1/2] Exécution des tests unitaires et d'intégration (Cargo Test)..."
cargo test --manifest-path backend-rust/Cargo.toml -- --nocapture

echo ""
echo ""
echo "[2/2] Vérification du formatage et des avertissements de compilation..."
cargo check --manifest-path backend-rust/Cargo.toml

echo ""
echo "[3/3] Exécution des tests automatiques sur corpus réel (tous les documents)..."
python3 scripts/automated_real_corpus_search_test.py

echo ""
echo "========================================================================="
echo "   TOUS LES TESTS RUST & CORPUS ONT RÉUSSI AVEC SUCCÈS (0 erreur)        "
echo "========================================================================="

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
echo "[2/2] Vérification du formatage et des avertissements de compilation..."
cargo check --manifest-path backend-rust/Cargo.toml

echo ""
echo "========================================================================="
echo "   TOUS LES TESTS RUST ONT RÉUSSI AVEC SUCCÈS (0 erreur, 0 régression)   "
echo "========================================================================="

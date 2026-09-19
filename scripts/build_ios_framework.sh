#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
CRATE_DIR="$ROOT_DIR/backend-rust/crates/search-ios"
OUTPUT_DIR="$ROOT_DIR/ios-app/Frameworks"

echo "=================================================================="
echo " 🛠️  COMPILATION DU FRAMEWORK RUST NATIF POUR IOS & IPADOS       "
echo "=================================================================="

# 1. Vérifier les cibles Rust installées
rustup target add aarch64-apple-ios aarch64-apple-ios-sim

# 2. Compiler pour iPhone physique (aarch64-apple-ios)
echo "📦 Compilation pour iPhone / iPad physique (aarch64-apple-ios)..."
cargo build --release --manifest-path "$CRATE_DIR/Cargo.toml" --target aarch64-apple-ios

# 3. Compiler pour simulateur Xcode (aarch64-apple-ios-sim)
echo "📦 Compilation pour Simulateur iOS Mac Apple Silicon (aarch64-apple-ios-sim)..."
cargo build --release --manifest-path "$CRATE_DIR/Cargo.toml" --target aarch64-apple-ios-sim

# 4. Préparer le dossier de sortie
mkdir -p "$OUTPUT_DIR"
rm -rf "$OUTPUT_DIR/DocSeekerCore.xcframework"

# 5. Créer le XCFramework universel avec xcodebuild
echo "🔨 Création de DocSeekerCore.xcframework..."
xcodebuild -create-xcframework \
  -library "$CRATE_DIR/target/aarch64-apple-ios/release/libsearch_ios.a" \
  -headers "$CRATE_DIR/include" \
  -library "$CRATE_DIR/target/aarch64-apple-ios-sim/release/libsearch_ios.a" \
  -headers "$CRATE_DIR/include" \
  -output "$OUTPUT_DIR/DocSeekerCore.xcframework"

echo "=================================================================="
echo " ✅ DocSeekerCore.xcframework généré avec succès dans :           "
echo "    $OUTPUT_DIR/DocSeekerCore.xcframework                        "
echo "=================================================================="

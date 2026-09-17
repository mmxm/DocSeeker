#!/usr/bin/env bash
# ==============================================================================
# DocSeeker - Script d'Incrémentation Automatique & Consistante de Version
# Usage: ./scripts/bump_version.sh <nouvelle_version>
# Exemple: ./scripts/bump_version.sh 8.7
# ==============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

if [ $# -lt 1 ]; then
  echo "❌ Erreur : Veuillez spécifier la nouvelle version."
  echo "Usage: $0 <version>"
  echo "Exemple: $0 8.7"
  exit 1
fi

NEW_VERSION="$1"
echo "🚀 Incrémentation de la version de DocSeeker vers: ${NEW_VERSION}"

# 1. Mise à jour de sw.js
SW_FILE="${ROOT_DIR}/frontend/sw.js"
if [ -f "${SW_FILE}" ]; then
  sed -i '' -E "s/const APP_VERSION = '[^']+'/const APP_VERSION = '${NEW_VERSION}'/" "${SW_FILE}"
  echo "  ✓ Mis à jour frontend/sw.js (APP_VERSION = '${NEW_VERSION}')"
fi

# 2. Mise à jour de index.html
INDEX_FILE="${ROOT_DIR}/frontend/index.html"
if [ -f "${INDEX_FILE}" ]; then
  sed -i '' -E "s/<meta name=\"app-version\" content=\"[^\"]+\">/<meta name=\"app-version\" content=\"${NEW_VERSION}\">/" "${INDEX_FILE}"
  sed -i '' -E "s#/style\.css\?v=[^\"']+#/style.css?v=${NEW_VERSION}#g" "${INDEX_FILE}"
  sed -i '' -E "s#/pdf-cache\.js\?v=[^\"']+#/pdf-cache.js?v=${NEW_VERSION}#g" "${INDEX_FILE}"
  sed -i '' -E "s#/download-queue-manager\.js\?v=[^\"']+#/download-queue-manager.js?v=${NEW_VERSION}#g" "${INDEX_FILE}"
  sed -i '' -E "s#/app\.js\?v=[^\"']+#/app.js?v=${NEW_VERSION}#g" "${INDEX_FILE}"
  echo "  ✓ Mis à jour frontend/index.html (meta app-version & assets ?v=${NEW_VERSION})"
fi

# 3. Mise à jour de package.json
PKG_FILE="${ROOT_DIR}/package.json"
if [ -f "${PKG_FILE}" ]; then
  sed -i '' -E "s/\"version\": \"[^\"]+\"/\"version\": \"${NEW_VERSION}\"/" "${PKG_FILE}"
  echo "  ✓ Mis à jour package.json"
fi

# 4. Exécution immédiate du test de consistance
echo ""
echo "🔍 Vérification de la consistance..."
node "${ROOT_DIR}/tests/test_version_consistency.mjs"

echo "✅ Version ${NEW_VERSION} synchronisée et validée avec succès !"

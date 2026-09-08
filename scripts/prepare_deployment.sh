#!/usr/bin/env bash
# ==============================================================================
# DocSeeker - Script de préparation du paquet de déploiement (Synology / VPS)
# ==============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
DIST_DIR="${ROOT_DIR}/dist"
DEPLOY_DIR="${DIST_DIR}/docseeker"
ZIP_FILE="${DIST_DIR}/docseeker.zip"

echo "========================================================================"
echo "  DocSeeker - Préparation du paquet de déploiement (Ultra-léger)"
echo "========================================================================"

# Nettoyage préalable
rm -rf "${DEPLOY_DIR}" "${ZIP_FILE}"
mkdir -p "${DEPLOY_DIR}"

echo "[1/4] Copie des configurations Docker (Compose, Caddy)..."
# Génération d'un docker-compose.yml pur production (sans directive build inutile sur le NAS)
sed '/build:/,/dockerfile:/d' "${ROOT_DIR}/docker-compose.yml" > "${DEPLOY_DIR}/docker-compose.yml"
cp "${ROOT_DIR}/Caddyfile" "${DEPLOY_DIR}/"
cp "${ROOT_DIR}/DEPLOY_SYNOLOGY.md" "${DEPLOY_DIR}/"

echo "[2/4] Préparation du fichier d'environnement .env (version liée au commit Git)..."
GIT_COMMIT=$(git -C "${ROOT_DIR}" rev-parse --short HEAD 2>/dev/null || echo "dev")
BASE_VERSION="1.0.0"
VERSION="${BASE_VERSION}-${GIT_COMMIT}"

cp "${ROOT_DIR}/.env.example" "${DEPLOY_DIR}/.env.example"
if [ -f "${ROOT_DIR}/.env" ]; then
    cp "${ROOT_DIR}/.env" "${DEPLOY_DIR}/.env"
else
    cp "${ROOT_DIR}/.env.example" "${DEPLOY_DIR}/.env"
fi

# Aligner la version sur le commit Git dans le .env
sed -i.bak "s/^DOCSEEKER_VERSION=.*/DOCSEEKER_VERSION=${VERSION}/" "${DEPLOY_DIR}/.env" && rm -f "${DEPLOY_DIR}/.env.bak"
sed -i.bak "s/^DOCSEEKER_VERSION=.*/DOCSEEKER_VERSION=${VERSION}/" "${DEPLOY_DIR}/.env.example" && rm -f "${DEPLOY_DIR}/.env.example.bak"
sed -i.bak "s/image: docseeker-app:.*/image: docseeker-app:\${DOCSEEKER_VERSION:-${VERSION}}/" "${DEPLOY_DIR}/docker-compose.yml" && rm -f "${DEPLOY_DIR}/docker-compose.yml.bak"

echo "[3/3] Création de l'archive ZIP (${ZIP_FILE})..."
(
  cd "${DIST_DIR}"
  zip -r -q "docseeker.zip" "docseeker"
)

TOTAL_SIZE=$(du -sh "${DEPLOY_DIR}" | cut -f1)
ZIP_SIZE=$(du -sh "${ZIP_FILE}" | cut -f1)

echo "========================================================================"
echo "  ✅ Paquet de configuration prêt (Zéro code source, Zéro data) !"
echo "========================================================================"
echo "📁 Dossier NAS               : ${DEPLOY_DIR} (${TOTAL_SIZE})"
echo "📦 Archive ZIP ultra-légère  : ${ZIP_FILE} (${ZIP_SIZE})"
echo ""
echo "👉 Contenu épuré pour le NAS (sans toucher à vos documents existants) :"
echo "   - docker-compose.yml (utilise l'image pré-compilée docseeker-app:1.0.0)"
echo "   - Caddyfile (Reverse proxy, HTTPS, Basic Auth)"
echo "   - .env (paramètres et mot de passe)"
echo "   - DEPLOY_SYNOLOGY.md (guide pas-à-pas)"
echo "========================================================================"

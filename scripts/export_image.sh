#!/usr/bin/env bash
# ==============================================================================
# DocSeeker - Exportation de l'image Docker pré-compilée pour NAS Synology
# ==============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
DIST_DIR="${ROOT_DIR}/dist"
# Détection automatique du commit Git
GIT_COMMIT=$(git -C "${ROOT_DIR}" rev-parse --short HEAD 2>/dev/null || echo "dev")
BASE_VERSION="1.0.0"
VERSION="${BASE_VERSION}-${GIT_COMMIT}"
IMAGE_TAG="docseeker-app:${VERSION}"

# Plateforme cible : la majorité des NAS Synology (DS220+, DS720+, DS920+, DS423+, etc.) sont en amd64 (x86_64).
# Si votre NAS a un processeur ARM (ex: DS223), passez "arm64" en paramètre : ./scripts/export_image.sh arm64
ARCH="${1:-amd64}"
PLATFORM="linux/${ARCH}"
TAR_FILE="${DIST_DIR}/docseeker-app-${VERSION}-${ARCH}.tar.gz"

mkdir -p "${DIST_DIR}"

echo "========================================================================"
echo "  DocSeeker - Compilation et Exportation de l'image Docker"
echo "  Version liée au commit Git : ${VERSION} (commit: ${GIT_COMMIT})"
echo "  Architecture cible        : ${PLATFORM}"
echo "========================================================================"

echo "[1/2] Construction de l'image optimisée pour ${PLATFORM}..."
docker buildx build \
    --platform "${PLATFORM}" \
    --build-arg DOCSEEKER_VERSION="${VERSION}" \
    --build-arg GIT_COMMIT="${GIT_COMMIT}" \
    -t "${IMAGE_TAG}" \
    -t "docseeker-app:latest" \
    -t "docseeker-app:1.0.0" \
    --load \
    "${ROOT_DIR}"

echo "[2/2] Exportation de l'image dans l'archive (${TAR_FILE})..."
docker save "${IMAGE_TAG}" | gzip > "${TAR_FILE}"

FILE_SIZE=$(du -sh "${TAR_FILE}" | cut -f1)

echo "========================================================================"
echo "  ✅ Image pré-compilée prête !"
echo "========================================================================"
echo "📦 Fichier à importer : ${TAR_FILE} (${FILE_SIZE})"
echo ""
echo "👉 Pour l'utiliser sur Synology :"
echo "   1. Dans DSM, ouvrez Container Manager > onglet 'Image'"
echo "   2. Cliquez sur 'Importer' > 'Ajouter depuis un fichier' et choisissez ce .tar.gz"
echo "   3. Votre image est instantanément disponible, sans AUCUNE compilation par le NAS !"
echo "========================================================================"

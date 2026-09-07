#!/usr/bin/env bash
# ==============================================================================
# DocFastExplorer - Script de Sauvegarde Automatique à Chaud
# Sauvegarde la base SQLite via l'API d'intégrité .backup et synchronise les PDF
# ==============================================================================

set -euo pipefail

# Définition des chemins
PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DATA_DIR="${PROJECT_DIR}/data"
DB_FILE="${DATA_DIR}/db.sqlite"
DOCS_DIR="${DATA_DIR}/documents"

BACKUP_ROOT="${BACKUP_DIR:-${PROJECT_DIR}/backups}"
TIMESTAMP=$(date +"%Y%m%d_%H%M%S")
CURRENT_BACKUP_DIR="${BACKUP_ROOT}/${TIMESTAMP}"
RETENTION_DAYS="${RETENTION_DAYS:-14}"

echo "=========================================================="
echo "  Démarrage de la sauvegarde DocFastExplorer : ${TIMESTAMP}"
echo "=========================================================="

mkdir -p "${CURRENT_BACKUP_DIR}"

# 1. Sauvegarde cohérente de la base SQLite (compatible WAL mode sans verrouillage prolongé)
if [ -f "${DB_FILE}" ]; then
    echo "[1/3] Sauvegarde à chaud de la base SQLite..."
    sqlite3 "${DB_FILE}" ".backup '${CURRENT_BACKUP_DIR}/db.sqlite'"
    echo "       -> Base SQLite sauvegardée avec succès dans ${CURRENT_BACKUP_DIR}/db.sqlite"
else
    echo "[!] Attention : Aucune base SQLite trouvée à ${DB_FILE}"
fi

# 2. Synchronisation des documents PDF (liens durs ou copie incrémentale)
if [ -d "${DOCS_DIR}" ]; then
    echo "[2/3] Sauvegarde des documents PDF..."
    mkdir -p "${CURRENT_BACKUP_DIR}/documents"
    rsync -aq --delete "${DOCS_DIR}/" "${CURRENT_BACKUP_DIR}/documents/"
    DOC_COUNT=$(ls -1 "${CURRENT_BACKUP_DIR}/documents" | wc -l | tr -d ' ')
    echo "       -> ${DOC_COUNT} document(s) synchronisé(s)"
fi

# 3. Compression de l'archive quotidienne
echo "[3/3] Compression de l'archive..."
tar -czf "${CURRENT_BACKUP_DIR}.tar.gz" -C "${BACKUP_ROOT}" "${TIMESTAMP}"
rm -rf "${CURRENT_BACKUP_DIR}"
echo "       -> Archive générée : ${CURRENT_BACKUP_DIR}.tar.gz"

# 4. Rotation des sauvegardes (purge au-delà de RETENTION_DAYS jours)
echo "[*] Nettoyage des sauvegardes datant de plus de ${RETENTION_DAYS} jours..."
find "${BACKUP_ROOT}" -name "*.tar.gz" -type f -mtime +"${RETENTION_DAYS}" -exec rm -f {} +

echo "=========================================================="
echo "  Sauvegarde terminée avec succès !"
echo "=========================================================="

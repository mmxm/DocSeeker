#!/bin/bash
set -e

# ==============================================================================
# DocSeeker - Entrypoint avec support dynamique PUID / PGID (Spécial Synology)
# ==============================================================================

# PUID=1026 et PGID=100 par défaut (utilisateur standard DSM Synology)
PUID=${PUID:-1026}
PGID=${PGID:-100}

# 1. Aligner l'UID et le GID de l'utilisateur appuser sur ceux de l'hôte
if [ "$PGID" != "1000" ]; then
    groupmod -o -g "$PGID" appuser 2>/dev/null || true
fi
if [ "$PUID" != "1000" ]; then
    usermod -o -u "$PUID" -g "$PGID" appuser 2>/dev/null || true
fi

# 2. Initialisation des répertoires de stockage avec les bons droits hôte
mkdir -p /app/data/documents /app/data/cache_crops/covers
chown -R appuser:appuser /app/data 2>/dev/null || true
chown appuser:appuser /app 2>/dev/null || true
chmod -R 775 /app/data 2>/dev/null || true

# 3. Exécution du serveur sous l'utilisateur non-root appuser
exec runuser -u appuser -- "$@"

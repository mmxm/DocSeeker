# ==============================================================================
# DocSeeker - Dockerfile de Production Sécurisé
# Image minimale basée sur Python 3.13 slim
# ==============================================================================

FROM python:3.13-slim-bookworm

ARG DOCSEEKER_VERSION=1.0.0
ARG GIT_COMMIT=unknown

LABEL org.opencontainers.image.title="DocSeeker" \
      org.opencontainers.image.version="${DOCSEEKER_VERSION}" \
      org.opencontainers.image.revision="${GIT_COMMIT}" \
      org.opencontainers.image.description="DocSeeker - Exploration et recherche ultra-rapide de documents PDF"

# Empêche la mise en tampon des logs Python et l'écriture de fichiers .pyc
# MALLOC_ARENA_MAX=2 limite la fragmentation mémoire glibc (gain de 30-50% de RAM sous Linux)
ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONPATH=/app \
    DOCSEEKER_VERSION=${DOCSEEKER_VERSION} \
    GIT_COMMIT=${GIT_COMMIT} \
    MALLOC_ARENA_MAX=2 \
    WEB_CONCURRENCY=1 \
    PORT=8000

# Installation des utilitaires système nécessaires (curl pour healthcheck)
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    && rm -rf /var/lib/apt/lists/*

# Création d'un utilisateur non-root dédié pour l'exécution du service
RUN groupadd -g 1000 appuser && \
    useradd -u 1000 -g appuser -m -s /bin/bash appuser

WORKDIR /app

# Installation des dépendances Python
COPY requirements.txt .
RUN pip install --no-cache-dir --upgrade pip && \
    pip install --no-cache-dir -r requirements.txt

# Copie des sources de l'application et de l'entrypoint
COPY backend/ ./backend/
COPY frontend/ ./frontend/
COPY docker-entrypoint.sh /usr/local/bin/
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

# Création et initialisation des répertoires de stockage avec les bons droits
RUN mkdir -p /app/data/documents /app/data/covers /app/data/crops && \
    chown -R appuser:appuser /app

# Note: Le conteneur démarre sous root pour exécuter l'entrypoint,
# qui aligne dynamiquement l'UID/GID sur celui de l'hôte Synology (PUID/PGID=1026/100)
# puis bascule immédiatement sous appuser via runuser sans privilèges root.

# Exposition du port interne de l'application
EXPOSE 8000

# Diagnostic de santé du conteneur
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD curl -f http://localhost:8000/api/health || exit 1

ENTRYPOINT ["docker-entrypoint.sh"]

# Lancement de FastAPI avec Uvicorn (1 worker par défaut suffisant et 2x moins gourmand en RAM)
CMD ["uvicorn", "backend.main:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "1"]

# ==============================================================================
# DocFastExplorer - Dockerfile de Production Sécurisé
# Image minimale basée sur Python 3.13 slim
# ==============================================================================

FROM python:3.13-slim-bookworm

# Empêche la mise en tampon des logs Python et l'écriture de fichiers .pyc
ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
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

# Copie des sources de l'application
COPY backend/ ./backend/
COPY frontend/ ./frontend/

# Création et initialisation des répertoires de stockage avec les bons droits
RUN mkdir -p /app/data/documents /app/data/covers /app/data/crops && \
    chown -R appuser:appuser /app

# Bascule vers l'utilisateur non privilégié
USER appuser

# Exposition du port interne de l'application
EXPOSE 8000

# Diagnostic de santé du conteneur
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD curl -f http://localhost:8000/api/health || exit 1

# Lancement de FastAPI avec Uvicorn
CMD ["uvicorn", "backend.main:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "2"]

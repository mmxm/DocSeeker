#!/bin/bash
# ==============================================================================
# Script de démarrage local pour DocSeeker
# ==============================================================================
set -e
cd "$(dirname "$0")"

# Vérifier et libérer le port 8000 s'il est déjà occupé par un ancien processus
OLD_PID=$(lsof -ti :8000 || true)
if [ -n "$OLD_PID" ]; then
    echo "⚠️ Port 8000 déjà occupé par le processus PID $OLD_PID. Libération..."
    kill -9 $OLD_PID 2>/dev/null || true
    sleep 1
fi

# Vérifier si l'environnement virtuel existe
if [ ! -d "venv" ]; then
    echo "Création de l'environnement virtuel Python..."
    python3 -m venv venv
    ./venv/bin/pip install --upgrade pip
    ./venv/bin/pip install -r requirements.txt
fi

export PYTHONPATH="${PWD}"
echo "🚀 Démarrage de DocSeeker sur http://localhost:8000 ..."
exec ./venv/bin/uvicorn backend.main:app --host 0.0.0.0 --port 8000 --reload

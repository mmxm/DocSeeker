#!/bin/bash
# Script de démarrage pour DocFastExplorer

cd "$(dirname "$0")"

# Vérifier si l'environnement virtuel existe
if [ ! -d "venv" ]; then
    echo "Création de l'environnement virtuel Python..."
    python3 -m venv venv
    ./venv/bin/pip install --upgrade pip
    ./venv/bin/pip install -r requirements.txt
fi

export PYTHONPATH=.
echo "Démarrage de DocFastExplorer sur http://localhost:8000 ..."
./venv/bin/uvicorn backend.main:app --host 0.0.0.0 --port 8000 --reload

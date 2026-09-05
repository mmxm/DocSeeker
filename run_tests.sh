#!/bin/bash
# Exécution de la suite de tests unitaires et d'intégration de DocFastExplorer

cd "$(dirname "$0")"

export PYTHONPATH=.
echo "========================================================="
echo "   Lancement de la suite de tests DocFastExplorer        "
echo "========================================================="

./venv/bin/pytest tests/ -v

#!/bin/bash
# Exécution complète de la suite de tests industriels et de sécurité de DocFastExplorer

set -e
cd "$(dirname "$0")"

export PYTHONPATH=.
echo "========================================================================="
echo "   DocFastExplorer - Suite Complète de Tests & Audit Sécurité / Qualité   "
echo "========================================================================="

echo ""
echo "[1/2] Exécution des tests unitaires, fonctionnels, sécurité et benchmarks..."
./venv/bin/pytest tests/ -v --cov=backend --cov-report=term-missing --cov-report=html:htmlcov

echo ""
echo "[2/2] Audit de sécurité statique du code (Bandit)..."
./venv/bin/bandit -r backend/ -ll

echo ""
echo "========================================================================="
echo "   TOUS LES TESTS ONT RÉUSSI AVEC SUCCÈS (0 régression, 0 faille)       "
echo "   Rapport de couverture HTML disponible dans : htmlcov/index.html      "
echo "========================================================================="

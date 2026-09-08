#!/usr/bin/env bash
# ==============================================================================
# DocSeeker - Suite de Tests & Audit Sécurité en Conteneur de Production
# ==============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "${SCRIPT_DIR}"

MODE="docker"
if [ "${1:-}" = "--local" ]; then
    MODE="local"
fi

echo "========================================================================="
echo "      DocSeeker - Suite Complète de Tests & Audit Sécurité (Mode: ${MODE})  "
echo "========================================================================="

if [ "${MODE}" = "docker" ]; then
    # Vérifier si Docker est disponible et démarré
    if ! command -v docker &> /dev/null; then
        echo "❌ Erreur: 'docker' n'est pas installé ou accessible dans le PATH."
        echo "   Utilisez './run_tests.sh --local' pour exécuter les tests dans le venv local."
        exit 1
    fi

    if ! docker info &> /dev/null; then
        echo "❌ Erreur: Le démon Docker ne semble pas démarré."
        echo "   Veuillez démarrer Docker Desktop / Container Manager."
        echo "   Ou utilisez './run_tests.sh --local' pour exécuter les tests dans le venv local."
        exit 1
    fi

    GIT_COMMIT=$(git -C "${SCRIPT_DIR}" rev-parse --short HEAD 2>/dev/null || echo "dev")
    VERSION="1.0.0-${GIT_COMMIT}"
    IMAGE_TAG="docseeker-app:${VERSION}"

    echo ""
    echo "[1/4] Construction de l'image Docker de test (${IMAGE_TAG})..."
    docker build -t "${IMAGE_TAG}" \
        --build-arg DOCSEEKER_VERSION="${VERSION}" \
        --build-arg GIT_COMMIT="${GIT_COMMIT}" \
        "${SCRIPT_DIR}"

    echo ""
    echo "[2/4] Smoke Test : Validation du démarrage réel du conteneur Uvicorn..."
    TEST_CONTAINER_NAME="docseeker_test_smoketest_$$"
    # Démarrage éphémère du conteneur de prod pour valider l'importation Uvicorn
    docker run -d --name "${TEST_CONTAINER_NAME}" \
        -p 18000:8000 \
        -v "${SCRIPT_DIR}/data:/app/data" \
        "${IMAGE_TAG}" uvicorn backend.main:app --host 0.0.0.0 --port 8000 --workers 1

    # Attente active du démarrage (max 10s)
    SMOKE_SUCCESS=0
    for i in {1..10}; do
        if curl -sf http://localhost:18000/api/health > /dev/null 2>&1; then
            SMOKE_SUCCESS=1
            break
        fi
        sleep 1
    done

    # Nettoyage immédiat du conteneur de smoke test
    docker stop "${TEST_CONTAINER_NAME}" > /dev/null 2>&1 || true
    docker rm "${TEST_CONTAINER_NAME}" > /dev/null 2>&1 || true

    if [ "${SMOKE_SUCCESS}" -ne 1 ]; then
        echo "❌ ÉCHEC DU SMOKE TEST : Le conteneur Docker n'a pas pu démarrer Uvicorn ou répondre à /api/health !"
        exit 1
    fi
    echo "  ✅ Smoke test réussi : Le conteneur démarre et charge l'app ASGI sans erreur."

    echo ""
    echo "[3/4] Exécution des tests unitaires et d'intégration dans le conteneur Linux (Python 3.13)..."
    mkdir -p "${SCRIPT_DIR}/htmlcov"
    docker run --rm \
        -v "${SCRIPT_DIR}/data:/app/data" \
        -v "${SCRIPT_DIR}/tests:/app/tests:ro" \
        -v "${SCRIPT_DIR}/htmlcov:/app/htmlcov" \
        "${IMAGE_TAG}" pytest tests/ -v --cov=backend --cov-report=term-missing --cov-report=html:htmlcov

    echo ""
    echo "[4/4] Audit de sécurité statique du code (Bandit) dans le conteneur..."
    docker run --rm "${IMAGE_TAG}" bandit -r backend/ -ll

else
    # Exécution locale dans le venv (mode rapide)
    if [ ! -d "venv" ]; then
        echo "Création de l'environnement virtuel Python..."
        python3 -m venv venv
        ./venv/bin/pip install --upgrade pip
        ./venv/bin/pip install -r requirements.txt
    fi

    export PYTHONPATH=.
    echo ""
    echo "[1/2] Exécution des tests unitaires locaux..."
    ./venv/bin/pytest tests/ -v --cov=backend --cov-report=term-missing --cov-report=html:htmlcov

    echo ""
    echo "[2/2] Audit de sécurité statique du code (Bandit)..."
    ./venv/bin/bandit -r backend/ -ll
fi

echo ""
echo "========================================================================="
echo "   TOUS LES TESTS ONT RÉUSSI AVEC SUCCÈS (0 régression, 0 faille)       "
echo "   Rapport de couverture HTML disponible dans : htmlcov/index.html      "
echo "========================================================================="

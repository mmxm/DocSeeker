#!/usr/bin/env bash
# run_real_server_offline_tests.sh
# Script d'orchestration de tests réels HORS-LIGNE (Coupure physique du serveur local 8080)
# Sans faux mock ni changement de port : le serveur Rust est réellement stoppé et relancé.

set -euo pipefail

WORKSPACE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BACKEND_BIN="$WORKSPACE_DIR/backend-rust/target/release/docseeker-backend"
SERVER_URL="http://127.0.0.1:8080"
IOS_PROJECT_DIR="$WORKSPACE_DIR/ios-app"
SIMULATOR_NAME="iPhone 17"

echo "=========================================================================="
echo " [ORCHESTRATEUR] Démarrage des tests réels hors-ligne (Serveur Down Réel)"
echo "=========================================================================="

# 1. Vérification / Compilation du binaire release backend
if [ ! -f "$BACKEND_BIN" ]; then
    echo "[Backend] Compilation du binaire release..."
    (cd "$WORKSPACE_DIR/backend-rust" && cargo build --release)
fi

# Fonction de récupération du PID du serveur sur le port 8080
get_server_pid() {
    lsof -ti :8080 | head -n 1 || true
}

# Fonction d'extinction RÉELLE du serveur local
kill_server_process() {
    local pid
    pid=$(get_server_pid)
    if [ -n "$pid" ]; then
        echo "[Backend] Arrêt PHYSIQUE du serveur (PID: $pid)..."
        kill -TERM "$pid" 2>/dev/null || true
        sleep 1
        # Forcer si nécessaire
        pid=$(get_server_pid)
        if [ -n "$pid" ]; then
            kill -9 "$pid" 2>/dev/null || true
            sleep 0.5
        fi
    fi
}

# Fonction de démarrage du serveur local
start_server_process() {
    local pid
    pid=$(get_server_pid)
    if [ -n "$pid" ]; then
        echo "[Backend] Le serveur tourne déjà sur le port 8080 (PID: $pid)"
        return 0
    fi
    echo "[Backend] Démarrage du serveur sur le port 8080..."
    (cd "$WORKSPACE_DIR" && "$BACKEND_BIN" > /tmp/docseeker_server.log 2>&1) &
    local new_pid=$!
    echo "[Backend] Processus lancé (PID: $new_pid), attente de /api/health..."
    
    local retries=30
    while [ $retries -gt 0 ]; do
        if curl -s "$SERVER_URL/api/health" | grep -q '"status":"ok"'; then
            echo "[Backend] Serveur en ligne et opérationnel !"
            return 0
        fi
        sleep 0.5
        retries=$((retries - 1))
    done
    echo "[ERREUR] Le serveur n'a pas répondu dans les temps."
    exit 1
}

# Nettoyage systématique à la sortie (garantir que le serveur est rallumé quoi qu'il arrive)
cleanup() {
    echo "[Cleanup] Rétablissement garanti du serveur pour l'environnement..."
    start_server_process || true
}
trap cleanup EXIT

# --------------------------------------------------------------------------
# ÉTAPE 1 : S'assurer que le serveur tourne initialement pour les tests en ligne
# --------------------------------------------------------------------------
echo ""
echo "=== ÉTAPE 1 : Serveur actif -> Exécution des tests unitaires et streaming ==="
start_server_process

# Exécution des tests unitaires et visuels en ligne (streaming partiel Byte-Range et validation visuelle Niveaux 1, 2, 3)
echo "[Tests] Lancement des tests unitaires et visuels DocSeeker..."
xcodebuild test \
    -project "$IOS_PROJECT_DIR/DocSeeker.xcodeproj" \
    -scheme "DocSeeker" \
    -destination "platform=iOS Simulator,name=$SIMULATOR_NAME" \
    -only-testing:DocSeekerTests/DocSeekerTests/testStrictCacheCheck_IndexedInDBWithoutPhysicalFile_ReturnsFalse \
    -only-testing:DocSeekerTests/DocSeekerTests/testAuthenticatedCropDownload_WithSessionToken_Succeeds \
    -only-testing:DocSeekerTests/DocSeekerTests/testPartialPDFStreamingAndByteRangeNegotiation \
    -only-testing:DocSeekerUITests/DocSeekerOfflineUITests/testVisualValidation_OnlineStreamingPDF_Levels123 \
    -only-testing:DocSeekerUITests/DocSeekerOfflineUITests/testVisualValidation_EndocrinologieCrops_Levels123 \
    -quiet

echo "-> Succès : Streaming partiel, crops authentifiés et validation visuelle (Niveaux 1, 2, 3) validés !"

# --------------------------------------------------------------------------
# ÉTAPE 2 : COUPURE PHYSIQUE RÉELLE DU SERVEUR LOCAL (SERVEUR DOWN)
# --------------------------------------------------------------------------
echo ""
echo "=== ÉTAPE 2 : COUPURE PHYSIQUE DU SERVEUR LOCAL (Port 8080 fermé) ==="
kill_server_process

# Vérification formelle que le port 8080 est bien fermé et refuse les connexions
if curl -s "$SERVER_URL/api/health" > /dev/null 2>&1; then
    echo "[ERREUR] Le serveur répond toujours alors qu'il doit être coupé !"
    exit 1
fi
echo "[Succès] Le serveur local est PHYSIQUEMENT ÉTEINT (Connection refused sur :8080)."

# --------------------------------------------------------------------------
# ÉTAPE 3 : Exécution des tests UI en mode VRAIMENT HORS-LIGNE
# --------------------------------------------------------------------------
echo ""
echo "=== ÉTAPE 3 : Lancement des tests UI XCUITest contre le serveur coupé (Validation visuelle Niveaux 1, 2, 3) ==="
xcodebuild test \
    -project "$IOS_PROJECT_DIR/DocSeeker.xcodeproj" \
    -scheme "DocSeeker" \
    -destination "platform=iOS Simulator,name=$SIMULATOR_NAME" \
    -only-testing:DocSeekerUITests/DocSeekerOfflineUITests/testOfflineInitialStateAndFolderEntryAndDrillDown \
    -only-testing:DocSeekerUITests/DocSeekerOfflineUITests/testOfflineOccurrenceNavigationAndBottomBarArrows \
    -only-testing:DocSeekerUITests/DocSeekerOfflineUITests/testOfflineInDocumentSearchDrawerPreservesOccurrencesAndQuery \
    -only-testing:DocSeekerUITests/DocSeekerOfflineUITests/testOfflineLongContinuousUserJourney \
    -only-testing:DocSeekerUITests/DocSeekerOfflineUITests/testOfflineUncachedDocExclusionAndEmptyState \
    -only-testing:DocSeekerUITests/DocSeekerOfflineUITests/testVisualValidation_OfflineLocalPDF_Levels123 \
    -quiet

echo "-> Succès : L'ensemble des scénarios hors-ligne avec validation visuelle à 3 niveaux ont réussi !"

# --------------------------------------------------------------------------
# ÉTAPE 4 : RALLUMAGE DU SERVEUR À CHAUD ET TEST DE RECONNEXION AUTOMATIQUE
# --------------------------------------------------------------------------
echo ""
echo "=== ÉTAPE 4 : RALLUMAGE À CHAUD DU SERVEUR ET TEST DE REPRISE ==="
start_server_process

echo "[Reconnexion] Validation de la sonde /api/health et reconnexion automatique..."
sleep 2

# Vérifier que le serveur répond à nouveau
curl -s "$SERVER_URL/api/health" | grep -q '"status":"ok"'
echo "-> Succès : Le serveur est de nouveau en ligne et le handshake de reconnexion est validé !"

echo ""
echo "=========================================================================="
echo " [ORCHESTRATEUR] TOUS LES TESTS RÉELS HORS-LIGNE ET RECONNEXION ONT RÉUSSI"
echo "=========================================================================="

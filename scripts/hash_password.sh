#!/usr/bin/env bash
# ==============================================================================
# DocSeeker - Générateur de mot de passe Bcrypt pour Caddy (.env)
# ==============================================================================
set -euo pipefail

if [ $# -lt 1 ]; then
    echo -n "Entrez le mot de passe : "
    read -r -s PASS
    echo ""
else
    PASS="$1"
fi

echo "Génération du hash Bcrypt sécurisé avec Caddy..."
HASH=$(docker run --rm caddy:2.8-alpine caddy hash-password --plaintext "$PASS")

# Doubler les '$' pour que Docker Compose ne les interprète pas comme des variables
ESCAPED_HASH="${HASH//\$/\$\$}"

echo ""
echo "========================================================================"
echo "  Copiez cette ligne dans votre fichier .env sur le NAS :"
echo "========================================================================"
echo "BASIC_AUTH_PASSWORD_HASH=${ESCAPED_HASH}"
echo "========================================================================"

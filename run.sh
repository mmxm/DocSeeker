#!/bin/bash
# ==============================================================================
# DocSeeker v2.0 - Script de démarrage local (Backend Rust Haute Performance)
# ==============================================================================
set -e
cd "$(dirname "$0")"

# Vérifier et libérer le port 8080 s'il est déjà occupé par un ancien processus en écoute
OLD_PID=$(lsof -ti :8080 -sTCP:LISTEN || true)
if [ -n "$OLD_PID" ]; then
    echo "⚠️ Port 8080 déjà occupé par le processus PID $OLD_PID. Libération..."
    kill -TERM $OLD_PID 2>/dev/null || true
    sleep 0.5
    kill -9 $OLD_PID 2>/dev/null || true
    sleep 0.5
fi

if [ ! -f "backend-rust/target/release/docseeker-backend" ]; then
    echo "📦 Compilation initiale du binaire Release Rust..."
    cargo build --release --manifest-path backend-rust/Cargo.toml
fi

export DATA_DIR="${DATA_DIR:-./data}"
export PORT="${PORT:-8080}"
export HOST="${HOST:-0.0.0.0}"

echo "🚀 Démarrage de DocSeeker v2.0 sur http://localhost:${PORT} ..."
exec ./backend-rust/target/release/docseeker-backend

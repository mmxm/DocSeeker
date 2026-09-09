# ==============================================================================
# DocSeeker v2.0 - Dockerfile Multi-Stage Haute Performance (Rust & Sécurité Native)
# Cross-compilation native directe (sans émulation QEMU) via Docker Buildx
# ==============================================================================

# Stage 1 : Compilation croisée native sur la plateforme hôte du builder
FROM --platform=$BUILDPLATFORM rust:slim-bookworm AS builder

ARG DOCSEEKER_VERSION=2.0.0
ARG GIT_COMMIT=unknown
ARG TARGETARCH

WORKDIR /build

RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    ca-certificates \
    tar \
    pkg-config \
    gcc-aarch64-linux-gnu \
    libc6-dev-arm64-cross \
    gcc-x86-64-linux-gnu \
    libc6-dev-amd64-cross \
    && rm -rf /var/lib/apt/lists/*

# Ajout des cibles de compilation croisée Rust
RUN rustup target add aarch64-unknown-linux-gnu x86_64-unknown-linux-gnu

# Configuration des linkers et compilateurs C croisés pour Cargo et cc-rs
ENV CARGO_TARGET_AARCH64_UNKNOWN_LINUX_GNU_LINKER=aarch64-linux-gnu-gcc \
    CC_aarch64_unknown_linux_gnu=aarch64-linux-gnu-gcc \
    CARGO_TARGET_X86_64_UNKNOWN_LINUX_GNU_LINKER=x86_64-linux-gnu-gcc \
    CC_x86_64_unknown_linux_gnu=x86_64-linux-gnu-gcc

# 1. Copie des fichiers de dépendances
COPY backend-rust/Cargo.toml backend-rust/Cargo.lock* ./backend-rust/
WORKDIR /build/backend-rust

# 2. Téléchargement automatique de la bibliothèque libpdfium selon la TARGETARCH
RUN mkdir -p lib && \
    ARCH="${TARGETARCH:-$(case $(uname -m) in aarch64|arm64) echo arm64;; *) echo amd64;; esac)}" && \
    if [ "$ARCH" = "amd64" ] || [ "$ARCH" = "x86_64" ]; then \
        curl -sL https://github.com/bblanchon/pdfium-binaries/releases/latest/download/pdfium-linux-x64.tgz | tar -xz -C lib; \
    elif [ "$ARCH" = "arm64" ] || [ "$ARCH" = "aarch64" ]; then \
        curl -sL https://github.com/bblanchon/pdfium-binaries/releases/latest/download/pdfium-linux-arm64.tgz | tar -xz -C lib; \
    fi && \
    if [ -f lib/lib/libpdfium.so ]; then cp lib/lib/libpdfium.so lib/libpdfium.so; fi

# 3. Pré-compilation des dépendances tierces (mise en cache Docker pérenne)
RUN mkdir -p src && echo "fn main() {}" > src/main.rs && \
    ARCH="${TARGETARCH:-$(case $(uname -m) in aarch64|arm64) echo arm64;; *) echo amd64;; esac)}" && \
    case "$ARCH" in \
        "amd64"|"x86_64") RUST_TARGET="x86_64-unknown-linux-gnu" ;; \
        "arm64"|"aarch64") RUST_TARGET="aarch64-unknown-linux-gnu" ;; \
        *) echo "Architecture non supportée: $ARCH" && exit 1 ;; \
    esac && \
    cargo build --release --target "$RUST_TARGET" && \
    rm -rf src target/"$RUST_TARGET"/release/deps/docseeker_backend* target/"$RUST_TARGET"/release/docseeker-backend*

# 4. Copie du code source applicatif réel et du frontend
COPY backend-rust/src/ ./src/
COPY backend-rust/tests/ ./tests/
COPY frontend/ /build/frontend/

# 5. Compilation applicative ultra-rapide et copie vers un chemin fixe
RUN ARCH="${TARGETARCH:-$(case $(uname -m) in aarch64|arm64) echo arm64;; *) echo amd64;; esac)}" && \
    case "$ARCH" in \
        "amd64"|"x86_64") RUST_TARGET="x86_64-unknown-linux-gnu" ;; \
        "arm64"|"aarch64") RUST_TARGET="aarch64-unknown-linux-gnu" ;; \
        *) echo "Architecture non supportée: $ARCH" && exit 1 ;; \
    esac && \
    cargo build --release --target "$RUST_TARGET" && \
    cp target/"$RUST_TARGET"/release/docseeker-backend /build/docseeker-backend

# Stage 2 : Image d'exécution ultra-plume Google Distroless (~9 Mo téléchargé, ~55 Mo total sur disque)
FROM gcr.io/distroless/cc-debian12

ARG DOCSEEKER_VERSION=2.0.0
ARG GIT_COMMIT=unknown

LABEL org.opencontainers.image.title="DocSeeker" \
      org.opencontainers.image.version="${DOCSEEKER_VERSION}" \
      org.opencontainers.image.revision="${GIT_COMMIT}" \
      org.opencontainers.image.description="DocSeeker v2.0 - Rust & Google Distroless"

ENV DOCSEEKER_VERSION=${DOCSEEKER_VERSION} \
    GIT_COMMIT=${GIT_COMMIT} \
    HOST=0.0.0.0 \
    PORT=8080 \
    DATA_DIR=/app/data

WORKDIR /app

# Copie du binaire compilé, de la bibliothèque pdfium et des fichiers frontend
COPY --from=builder /build/docseeker-backend /usr/local/bin/docseeker
COPY --from=builder /build/backend-rust/lib/libpdfium.so /usr/lib/libpdfium.so
COPY frontend/ /app/frontend/

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
    CMD ["/usr/local/bin/docseeker", "--healthcheck"]

ENTRYPOINT ["/usr/local/bin/docseeker"]

# ==============================================================================
# DocSeeker v2.0 - Dockerfile Multi-Stage Haute Performance (Rust & Sécurité Native)
# ==============================================================================

# Stage 1 : Compilation du binaire Rust
FROM rust:slim-bookworm AS builder

ARG DOCSEEKER_VERSION=2.0.0
ARG GIT_COMMIT=unknown
ARG TARGETARCH

WORKDIR /build

RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    ca-certificates \
    tar \
    pkg-config \
    && rm -rf /var/lib/apt/lists/*

# 1. Copie des fichiers de dépendances
COPY backend-rust/Cargo.toml backend-rust/Cargo.lock* ./backend-rust/
WORKDIR /build/backend-rust

# 2. Téléchargement automatique de la bibliothèque libpdfium selon l'architecture
RUN mkdir -p lib && \
    ARCH="${TARGETARCH:-$(uname -m)}" && \
    if [ "$ARCH" = "x86_64" ] || [ "$ARCH" = "amd64" ]; then \
        curl -sL https://github.com/bblanchon/pdfium-binaries/releases/latest/download/pdfium-linux-x64.tgz | tar -xz -C lib; \
    elif [ "$ARCH" = "aarch64" ] || [ "$ARCH" = "arm64" ]; then \
        curl -sL https://github.com/bblanchon/pdfium-binaries/releases/latest/download/pdfium-linux-arm64.tgz | tar -xz -C lib; \
    fi && \
    if [ -f lib/lib/libpdfium.so ]; then cp lib/lib/libpdfium.so lib/libpdfium.so; fi

# 3. Pré-compilation des dépendances tierces (mise en cache Docker pérenne)
RUN mkdir -p src && echo "fn main() {}" > src/main.rs && \
    cargo build --release && \
    rm -rf src target/release/deps/docseeker_backend* target/release/docseeker-backend*

# 4. Copie du code source applicatif réel et du frontend
COPY backend-rust/src/ ./src/
COPY backend-rust/tests/ ./tests/
COPY frontend/ /build/frontend/

# 5. Compilation applicative ultra-rapide (les dépendances sont déjà compilées)
RUN cargo build --release

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
COPY --from=builder /build/backend-rust/target/release/docseeker-backend /usr/local/bin/docseeker
COPY --from=builder /build/backend-rust/lib/libpdfium.so /usr/lib/libpdfium.so
COPY frontend/ /app/frontend/

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
    CMD ["/usr/local/bin/docseeker", "--healthcheck"]

ENTRYPOINT ["/usr/local/bin/docseeker"]

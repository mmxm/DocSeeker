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

COPY backend-rust/Cargo.toml backend-rust/Cargo.lock* ./backend-rust/
COPY backend-rust/src/ ./backend-rust/src/
COPY backend-rust/tests/ ./backend-rust/tests/
COPY frontend/ ./frontend/

WORKDIR /build/backend-rust

# Téléchargement automatique de la bibliothèque libpdfium partagée selon l'architecture cible
RUN mkdir -p lib && \
    ARCH="${TARGETARCH:-$(uname -m)}" && \
    if [ "$ARCH" = "x86_64" ] || [ "$ARCH" = "amd64" ]; then \
        curl -sL https://github.com/bblanchon/pdfium-binaries/releases/latest/download/pdfium-linux-x64.tgz | tar -xz -C lib; \
    elif [ "$ARCH" = "aarch64" ] || [ "$ARCH" = "arm64" ]; then \
        curl -sL https://github.com/bblanchon/pdfium-binaries/releases/latest/download/pdfium-linux-arm64.tgz | tar -xz -C lib; \
    fi && \
    if [ -f lib/lib/libpdfium.so ]; then cp lib/lib/libpdfium.so lib/libpdfium.so; fi

# Compilation Release hautement optimisée
RUN cargo build --release

# Stage 2 : Image d'exécution minimale Debian Slim
FROM debian:bookworm-slim

ARG DOCSEEKER_VERSION=2.0.0
ARG GIT_COMMIT=unknown

LABEL org.opencontainers.image.title="DocSeeker" \
      org.opencontainers.image.version="${DOCSEEKER_VERSION}" \
      org.opencontainers.image.revision="${GIT_COMMIT}" \
      org.opencontainers.image.description="DocSeeker - Exploration et recherche ultra-rapide de documents PDF en Rust"

ENV DOCSEEKER_VERSION=${DOCSEEKER_VERSION} \
    GIT_COMMIT=${GIT_COMMIT} \
    HOST=0.0.0.0 \
    PORT=8080 \
    DATA_DIR=/app/data

RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

RUN groupadd -g 1000 appuser && \
    useradd -u 1000 -g appuser -m -s /bin/bash appuser

WORKDIR /app

# Copie du binaire compilé et de la bibliothèque pdfium
COPY --from=builder /build/backend-rust/target/release/docseeker-backend /usr/local/bin/docseeker
COPY --from=builder /build/backend-rust/lib/libpdfium.so /usr/lib/libpdfium.so
COPY frontend/ /app/frontend/
COPY docker-entrypoint.sh /usr/local/bin/
RUN chmod +x /usr/local/bin/docker-entrypoint.sh /usr/local/bin/docseeker

# Répertoires de données par défaut
RUN mkdir -p /app/data/documents /app/data/cache_crops/covers && \
    chown -R appuser:appuser /app

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
    CMD curl -f http://localhost:8080/api/health || exit 1

ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["docseeker"]

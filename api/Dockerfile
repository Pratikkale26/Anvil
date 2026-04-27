FROM oven/bun:1 AS base
WORKDIR /app

# System packages:
#   - firejail: sandbox for `cargo check` invocations on /build (api/src/build/sandbox.ts).
#     Without this, the runner falls back to `unshare` (still safe, but firejail
#     is the strongest available option and what production should use).
#   - curl: HEALTHCHECK below uses it.
#   - rust toolchain pieces (cargo + rustc) for /build's cargo invocation.
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
       firejail \
       curl \
       ca-certificates \
       build-essential \
  && rm -rf /var/lib/apt/lists/*

# Install dependencies
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

# Copy source
COPY src/ src/
COPY tsconfig.json ./

# Expose port
ENV PORT=8080
# Force the strongest sandbox available; `auto` would silently fall back if
# firejail were missing — we just installed it, so demand it explicitly.
ENV ANVIL_SANDBOX=firejail
EXPOSE 8080

# Health check
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD curl -f http://localhost:8080/ || exit 1

# Run
CMD ["bun", "src/index.ts"]

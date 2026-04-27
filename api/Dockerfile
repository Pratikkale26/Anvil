FROM oven/bun:1 AS base
WORKDIR /app

# System packages:
#   - firejail + bubblewrap: sandboxes for `cargo check` invocations on /build
#     (api/src/build/sandbox.ts). bubblewrap is the strongest FS-isolation
#     option (ro-bind /etc, ro-bind /usr, --tmpfs /tmp); firejail is the
#     fallback. Without either, the runner falls back to `unshare` which
#     (per the 2026-04-27 sandbox audit) leaks $HOME / /etc / ~/.ssh
#     reads-and-writes — unacceptable for production.
#   - curl: HEALTHCHECK below uses it.
#   - build-essential: gcc + linker for cargo's native dep crates.
#   - ca-certificates: rustup TLS cert store.
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
       firejail \
       bubblewrap \
       curl \
       ca-certificates \
       build-essential \
  && rm -rf /var/lib/apt/lists/*

# Rust toolchain — /build runs `cargo check` on user-emitted programs.
# Without this, /build returns "no suitable cargo executable found" (the
# bug the 2026-04-27 prod audit caught: build.success=0/4 on prod metrics).
ENV RUSTUP_HOME=/root/.rustup \
    CARGO_HOME=/root/.cargo \
    PATH=/root/.cargo/bin:$PATH
RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \
      | sh -s -- -y --default-toolchain stable --profile minimal \
      --no-modify-path \
  && rustc --version && cargo --version

# Install dependencies
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

# Copy source
COPY src/ src/
COPY tsconfig.json ./

# Expose port
ENV PORT=8080
# Force the strongest sandbox available; `auto` would silently fall back if
# bubblewrap were missing — we just installed both bwrap + firejail, so
# bwrap is preferred (better FS isolation than firejail or unshare).
ENV ANVIL_SANDBOX=bwrap
EXPOSE 8080

# Health check
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD curl -f http://localhost:8080/ || exit 1

# Run
CMD ["bun", "src/index.ts"]

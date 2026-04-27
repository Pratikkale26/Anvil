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

# Pre-warm the cargo dep cache + scratch project target/ for both Pinocchio
# and Native targets. Without this, the FIRST request to /build on a fresh
# container does a cold cargo build (downloads ~80 deps + compiles solana-
# program / pinocchio / borsh / spl-token = 60-120s) which exceeds the
# DigitalOcean App Platform request timeout (504 gateway). Warming at image-
# build time means the first runtime request is ~2-5s instead.
#
# Uses ANVIL_BUILD_SCRATCH_ROOT=/root/.anvil-build to match the runtime
# default (build-runner.ts: process.env.HOME ?? '/var/tmp', .anvil-build).
RUN mkdir -p /root/.anvil-build/anvil-build-pinocchio/src \
            /root/.anvil-build/anvil-build-native/src \
  && cd /root/.anvil-build/anvil-build-pinocchio \
  && printf '[package]\nname = "anvil-build"\nversion = "0.1.0"\nedition = "2021"\n[lib]\ncrate-type = ["cdylib", "lib"]\n[dependencies]\nborsh = { version = "1.5", features = ["derive"] }\npinocchio = "0.9"\npinocchio-system = "0.4"\npinocchio-token = "0.4"\npinocchio-associated-token-account = "0.4"\n' > Cargo.toml \
  && echo 'pub fn x() {}' > src/lib.rs \
  && cargo fetch \
  && cargo check --quiet \
  && cd /root/.anvil-build/anvil-build-native \
  && printf '[package]\nname = "anvil-build"\nversion = "0.1.0"\nedition = "2021"\n[lib]\ncrate-type = ["cdylib", "lib"]\n[dependencies]\nborsh = { version = "1.5", features = ["derive"] }\nsolana-program = "2.2"\nspl-token = { version = "7", features = ["no-entrypoint"] }\nspl-token-2022 = { version = "6", features = ["no-entrypoint"] }\nspl-associated-token-account = { version = "6", features = ["no-entrypoint"] }\n' > Cargo.toml \
  && echo 'pub fn x() {}' > src/lib.rs \
  && cargo fetch \
  && cargo check --quiet

# Install dependencies
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

# Copy source
COPY src/ src/
COPY tsconfig.json ./

# Expose port
ENV PORT=8080
# Sandbox selection: bwrap has the strongest FS isolation but requires
# unprivileged user namespaces, which DigitalOcean App Platform's
# container runtime blocks ('bwrap: Creating new namespace failed:
# Operation not permitted'). firejail uses setuid + seccomp + a separate
# kernel mechanism DO permits. bwrap stays installed as the local-dev
# preference (sandbox.ts auto-detect picks it on machines that allow it).
ENV ANVIL_SANDBOX=firejail
EXPOSE 8080

# Health check
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD curl -f http://localhost:8080/ || exit 1

# Run
CMD ["bun", "src/index.ts"]

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

# Anza CLI — provides `cargo-build-sbf`, which the workbench's "Deploy"
# mode uses to produce a deployable Solana .so. Plain rustup cargo
# doesn't include this; cargo discovers it via PATH (any `cargo-foo`
# binary on PATH gets exposed as `cargo foo`). Without this, /build
# with mode=build-sbf returns the cargo error 'no such command:
# build-sbf' which we now intercept with an actionable install hint —
# but baking the toolchain into the image is the actual fix.
#
# v3.1.13 matches the version cited in error messages, the README, and
# SECURITY.md. Bump in lockstep across all four if Anza's release
# stream moves.
#
# The installer drops binaries in
# ~/.local/share/solana/install/active_release/bin and writes a path
# helper to ~/.profile. We don't source ~/.profile in the bun run path
# (the Dockerfile CMD doesn't go through a login shell), so set PATH
# explicitly via ENV so spawned cargo invocations inherit it.
#
# `cargo-build-sbf --version` is the smoke check — it both confirms
# the wrapper resolves AND triggers Anza's lazy platform-tools install
# inside the same RUN layer so the first runtime /build request
# doesn't pay for the download cold.
ENV PATH=/root/.local/share/solana/install/active_release/bin:$PATH
RUN sh -c "$(curl --proto '=https' --tlsv1.2 -sSf https://release.anza.xyz/v3.1.13/install)" \
  && cargo-build-sbf --version

# Anchor CLI — used by the workbench's byte-equal differential endpoint
# (POST /build/differential) to build the Anchor reference .so. Without
# it, /health.differentialAvailable is false and the workbench's
# Verify byte-equal panel renders the "use the CLI locally" fallback.
#
# avm (Anchor Version Manager) installs + pins anchor 0.31.0 to match
# what the differential test corpus and api/tests/differential-harness.ts
# build against. Cargo install caches the avm + anchor binaries into
# CARGO_HOME so subsequent layers can reuse them.
RUN cargo install --git https://github.com/coral-xyz/anchor avm --locked \
  && avm install 0.31.0 \
  && avm use 0.31.0 \
  && anchor --version

# Pre-fetch (download only, no compile) the cargo registry tarballs for the
# Pinocchio + Native dep trees. cargo check at runtime reuses these,
# eliminating the network round-trip from the first /build request. We do
# NOT cargo check at image-build time — that needs >2 GB RAM to compile
# solana-program 2.2's transitive deps and exceeded the DigitalOcean App
# Platform image-build memory limit, causing 503 'no_healthy_upstream' on
# the previous deploy attempt.
#
# Failure here is non-fatal — '|| true' lets the image build complete
# even if a registry hiccup or new dep version blocks one of the fetches.
# The runtime fallback (cargo fetch on first scratch-project init) covers it.
RUN set -e; \
    mkdir -p /root/.anvil-build/anvil-build-pinocchio/src \
             /root/.anvil-build/anvil-build-native/src; \
    printf '[package]\nname = "anvil-build"\nversion = "0.1.0"\nedition = "2021"\n[lib]\ncrate-type = ["cdylib", "lib"]\n[dependencies]\nborsh = { version = "1.5", features = ["derive"] }\npinocchio = "0.9"\npinocchio-system = "0.4"\npinocchio-token = "0.4"\npinocchio-associated-token-account = "0.4"\n' > /root/.anvil-build/anvil-build-pinocchio/Cargo.toml; \
    echo 'pub fn x() {}' > /root/.anvil-build/anvil-build-pinocchio/src/lib.rs; \
    printf '[package]\nname = "anvil-build"\nversion = "0.1.0"\nedition = "2021"\n[lib]\ncrate-type = ["cdylib", "lib"]\n[dependencies]\nborsh = { version = "1.5", features = ["derive"] }\nsolana-program = "2.2"\nspl-token = { version = "7", features = ["no-entrypoint"] }\nspl-token-2022 = { version = "6", features = ["no-entrypoint"] }\nspl-associated-token-account = { version = "6", features = ["no-entrypoint"] }\n' > /root/.anvil-build/anvil-build-native/Cargo.toml; \
    echo 'pub fn x() {}' > /root/.anvil-build/anvil-build-native/src/lib.rs; \
    (cd /root/.anvil-build/anvil-build-pinocchio && cargo fetch) || true; \
    (cd /root/.anvil-build/anvil-build-native && cargo fetch) || true

# Pre-fetch the Anchor REFERENCE build deps (anchor-lang + anchor-spl). The
# /build/differential endpoint builds an Anchor reference .so under --offline
# (firejail --net=none); without these in $CARGO_HOME the build fails with
# "no matching package named anchor-lang/anchor-spl ... offline mode" — the
# runtime warm-fetch (differential-build.ts) can't reach crates.io on DO's
# locked-down container network. Mirrors the pinocchio/native pre-fetch above;
# pinned to 0.31 (= avm pin + the reference build's sniff default). Feature
# union covers the common anchor-spl shapes (sniffAnchorExtraDeps).
RUN set -e; \
    mkdir -p /root/.anvil-build/anvil-build-anchor/src; \
    printf '[package]\nname = "anvil-build-anchor"\nversion = "0.1.0"\nedition = "2021"\n[lib]\ncrate-type = ["cdylib", "lib"]\n[dependencies]\nanchor-lang = { version = "0.31", features = ["init-if-needed"] }\nanchor-spl = { version = "0.31", features = ["associated_token", "memo", "metadata", "token_2022"] }\n' > /root/.anvil-build/anvil-build-anchor/Cargo.toml; \
    echo 'pub fn x() {}' > /root/.anvil-build/anvil-build-anchor/src/lib.rs; \
    (cd /root/.anvil-build/anvil-build-anchor && cargo fetch) || true

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

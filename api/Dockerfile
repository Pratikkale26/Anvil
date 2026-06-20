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
# Host toolchain = `stable`. This is load-bearing for the byte-equal
# /build/differential path: the warm-fetch + Docker pre-fetch run the HOST cargo,
# while the offline reference build runs cargo-build-sbf's BUNDLED platform-tools
# cargo (the Anza pin below). Cargo's `registry/index/index.crates.io-<hash>` dir
# name flipped ONCE at cargo 1.85 (6f17… → 1949…). The prod break was an OLD
# platform-tools cargo (Anza v3.1.13, < 1.85 → 6f17…) reading a registry the
# host `stable` cargo (≥ 1.85 → 1949…) filled in a DIFFERENT dir → "no matching
# package named anchor-spl ... offline mode". The fix is to keep BOTH on the
# SAME side of the 1.85 flip: `stable` is ≥ 1.85 (and also the rustc avm needs —
# avm's cargo-platform dep requires ≥ 1.91, so do NOT pin host below that), and
# the Anza bump below moves platform-tools to ≥ 1.85 (v3.1.14 = rustc 1.89.0).
# Both land in index.crates.io-1949…. (Don't re-pin host to 1.89: it breaks the
# avm install.)
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
# v3.1.14 (platform-tools v1.52 / rustc 1.89.0) — its bundled cargo is ≥ 1.85
# (same side of the registry index-dir hash flip as the host `stable` cargo
# above), so the warm-fetch cargo and the offline cargo-build-sbf cargo compute
# the IDENTICAL index.crates.io-<hash> dir (the byte-equal offline-build fix).
# This is the version verified working locally end-to-end. Keep it ≥ v3.1.14
# (platform-tools rustc ≥ 1.85) whenever the Anza release stream moves.
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
# NOTE: the trailing version assertion is also a deliberate Docker cache-bust.
# DO App Platform served this layer from STALE build cache — a fresh deploy
# carried the new app code yet kept an old platform-tools (cargo-build-sbf
# 2.1.0, cargo < 1.85), which splits the byte-equal registry index hash from the
# host cargo's (>= 1.85). Comments don't change a RUN's cache key, but the
# command text below does — appending the `grep` forces this layer to re-run, so
# the next deploy genuinely reinstalls v3.1.14 (verify via
# /health.toolchain.cargoBuildSbfVersion, which must read 3.1.14). NON-FATAL on
# mismatch: a hard fail would make DO serve the last-good (stale) image again.
RUN sh -c "$(curl --proto '=https' --tlsv1.2 -sSf https://release.anza.xyz/v3.1.14/install)" \
  && cargo-build-sbf --version \
  && ( cargo-build-sbf --version | grep -q "3.1.14" \
       && echo "OK: cargo-build-sbf 3.1.14 installed (byte-equal cargo on the same index-hash side as the host cargo)" \
       || echo "WARN: cargo-build-sbf is NOT 3.1.14 after install — byte-equal registry-hash split risk; check /health.toolchain.cargoBuildSbfVersion and force a no-cache rebuild" )

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
#
# NON-FATAL by design (this RUN can never fail the image build). An earlier
# revision did `exit 1` when the post-fetch verify missed anchor-spl, reasoning
# "a broken offline registry must not ship". The opposite is true on DO App
# Platform: a failed image build makes DO keep serving the LAST-GOOD image, so a
# single transient fetch hiccup silently strands prod on a stale image (old emit
# bugs AND old toolchain) with no signal. Far better to always deploy the fresh
# image and surface the degraded byte-equal at RUNTIME — `/health.differentialReason`
# reports exactly this anchor-spl-resolvable check, and the build log below prints
# OK/WARN so a real pre-fetch failure is still visible in the deploy output.
RUN mkdir -p /root/.anvil-build/anvil-build-anchor/src; \
    printf '[package]\nname = "anvil-build-anchor"\nversion = "0.1.0"\nedition = "2021"\n[lib]\ncrate-type = ["cdylib", "lib"]\n[dependencies]\nanchor-lang = { version = "0.31", features = ["init-if-needed"] }\nanchor-spl = { version = "0.31", features = ["associated_token", "memo", "metadata", "token_2022"] }\n' > /root/.anvil-build/anvil-build-anchor/Cargo.toml; \
    echo 'pub fn x() {}' > /root/.anvil-build/anvil-build-anchor/src/lib.rs; \
    (cd /root/.anvil-build/anvil-build-anchor && cargo fetch) \
      || echo "WARN: anchor dep pre-fetch failed — byte-equal degraded until a runtime warm-fetch repopulates the registry (see /health.differentialReason)"; \
    ( ls /root/.cargo/registry/index/index.crates.io-*/.cache/an/ch/anchor-spl >/dev/null 2>&1 \
        && ls -d /root/.cargo/registry/src/index.crates.io-*/anchor-spl-* >/dev/null 2>&1 \
        && echo "OK: anchor-spl resolvable in the offline registry (index blob + src present)" ) \
      || echo "WARN: anchor-spl NOT resolvable in the offline registry after pre-fetch — /health.differentialReason will report byte-equal degraded"

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

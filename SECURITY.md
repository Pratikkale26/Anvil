# Security policy

Anvil's public API runs cargo against attacker-controlled source code. This document captures what we defend against, what we explicitly don't, and how to report new findings.

## Reporting a vulnerability

Email **pratikkale7661@gmail.com** with a description, reproduction, and impact. We aim to acknowledge within 5 business days. Please do not file public GitHub issues for unpatched vulnerabilities.

If you'd like to coordinate disclosure, name a window and we'll work to it.

## Threat model

The dangerous surface is `POST /build` (and `POST /build/auto-fix`, which calls into it). These endpoints accept arbitrary Rust source from the network and invoke `cargo` against it.

`cargo build` and `cargo check` execute `build.rs` scripts as part of dependency resolution and compilation. A malicious `build.rs` is just a Rust program with the privileges of the user running cargo.

### What we defend

- **Code execution containment.** Every cargo invocation runs inside the strongest sandbox available on the host, detected at startup:
  1. `firejail` — net cut, FS via seccomp + caps drop, prlimit caps.
  2. `bwrap` — comparable; mounts read-only `/usr` `/lib` `/etc`, fresh tmpfs, `--unshare-net` `--unshare-pid` `--die-with-parent`.
  3. `unshare` — kernel user/net/mount namespaces; tmpfs over `/tmp` and `/var/tmp`.
  4. None of the above → process refuses to start in production (`NODE_ENV=production` + sandbox.kind=`none` is fatal unless `ANVIL_ALLOW_INSECURE_SANDBOX=1`).

- **Secret exfiltration.** Independent of which sandbox is selected, the cargo subprocess gets a stripped env: only `PATH`, `HOME`, `USER`, `LOGNAME`, `LANG`, `LC_ALL`, `TERM`, `TMPDIR`, `PWD`, and the `CARGO_*` / `RUSTUP_*` configuration vars. Notably **no** `ANTHROPIC_API_KEY`, `AWS_*`, `REDIS_URL`, `SENTRY_DSN`, etc.

- **Resource consumption.** `prlimit` on every cargo invocation: 2 GiB AS, 60s CPU, 256 MiB file size, 128 processes. firejail/bwrap apply the same caps via their own mechanisms. A fork-bomb / OOM / unbounded write is bounded.

- **Network egress.** The sandbox cuts the network namespace. `cargo` runs with `--offline`; deps come from the warm scratch project's `target/` directory, not the registry.

- **Caller spend exhaustion.** Per-IP daily AI spend cap (`ANVIL_DAILY_AI_USD_PER_IP`, default $2/IP/day, Redis-backed in multi-instance deploys). A scripted attacker hitting `/emit?refine=1` inside the per-minute rate limit can't burn the API's AI budget.

- **Caller queue starvation.** Per-IP cap on concurrent `cargo build-sbf` runs (`ANVIL_BUILD_SBF_PER_IP_CAP`, default 2). One user pipelining 5 SBF builds (each 30s–2min) cannot starve the global queue for 10 minutes.

- **Per-minute rate limit.** Default 60 req/min/IP (`RATE_LIMIT`). Redis-backed when `REDIS_URL` is set. In production (`NODE_ENV=production`), Redis pipeline failures return 503 with `Retry-After` instead of silently degrading to in-memory — silent fallback in a multi-replica deploy would multiply the effective cap by the replica count during the outage. Operators can opt back into the old behavior with `ANVIL_RATELIMIT_REDIS_FALLBACK=1`.

- **Path traversal on file writes.** `safeRelativePath()` rejects absolute paths and `..` traversal before any write into the scratch dir.

### What we explicitly DON'T defend

- **CPU consumption inside the cap.** Within the 60s CPU + 2 GiB AS limits, `build.rs` can compute whatever it likes. Aggregate cost per request is bounded; per-request grief isn't.

- **Side-channel timing leaks.** The sandbox layers don't pretend to defend against timing oracles or cache-side-channel attacks against host workloads sharing the kernel.

- **Kernel CVEs that bypass user-namespace isolation.** When the sandbox kind is `unshare`, isolation is unprivileged user namespaces. A kernel CVE that escalates inside that namespace would defeat the isolation. Mitigation: keep the host kernel patched; prefer `firejail` or `bwrap` deploys where available.

- **Compromise of the cargo registry.** Dependency resolution happens during the warm scratch-project setup, OUTSIDE the sandbox, against `crates.io`. For `/build` (workbench Verify Build) the dep list is **hard-coded** in `build-runner.ts` (`PINOCCHIO_CARGO_TOML` and `NATIVE_CARGO_TOML`); no user input touches the resolved set.

  For `/build/differential` the request body accepts `anchorExtraDeps` (up to 50 KB of `[dependencies]` lines). This is bounded by **two** layers and not by hard-coding: (1) the sandbox cuts the network namespace AND `CARGO_NET_OFFLINE=true` is forced on every cargo invocation, so cargo refuses to fetch crates not already in `$CARGO_HOME`; (2) any build that does run still happens inside firejail/bwrap/unshare, so a malicious `build.rs` from a pre-cached crate executes with stripped env + prlimit caps. Net effect: an attacker can only opt into crates the operator has pre-fetched, AND those crates run under the same isolation as the rest of the build. Documented in `build-runner.ts` and `differential-build.ts`. **If you add an `extra-deps`-shaped knob to `/build`, replicate the offline-cargo + sandbox composition or remove the offline guard intentionally.**

- **Compromise of `platform-tools` download.** `cargo-build-sbf` downloads `platform-tools` on first run from `release.anza.xyz`. We trust the Anza release infrastructure for this download. The download happens during scratch-project warm-up, outside the sandbox.

- **AI provider compromise.** AI repair calls go to Anthropic's API. Its TLS termination + auth is the trust boundary; we don't independently verify response integrity.

- **DoS at the network layer.** No CDN, no per-region anycast, no HTTP-flood mitigation. Cloudflare / similar in front is recommended for production deploys.

## Known weaknesses

- **`build.rs` first-fetch.** `cargo fetch` runs outside the sandbox (necessary; it needs the network). Today the dep list is operator-controlled, so this is bounded. Documented at the constants in `build-runner.ts`.

- **Single-instance spend tracker file.** When `REDIS_URL` is unset, the spend tracker writes to a JSON file (`$ANVIL_DATA_DIR/spend-by-ip.json`) and is single-instance only. Multi-replica deploys MUST set `REDIS_URL`.

- **`/metrics` is unauthenticated.** Top spenders are `/24`-masked but the data still leaks aggregate user behavior. Production deploys behind auth-gated proxies should restrict `/metrics` to internal traffic.

## Configuration recommendations for production

- `NODE_ENV=production`
- Install `firejail` AND/OR `bwrap` on the host. The runtime auto-picks the strongest available.
- `ANVIL_DAILY_AI_USD_PER_IP=2` (or lower for higher-cost models)
- `ANVIL_BUILD_SBF_PER_IP_CAP=2` (default)
- `ANVIL_BUILD_MAX_QUEUE_DEPTH=16` (default)
- `RATE_LIMIT=60` per minute (default)
- `REDIS_URL=redis://...` (required for multi-instance correctness)
- `SENTRY_DSN=...` for error visibility; `SENTRY_RELEASE=...` for per-deploy tracking
- `CORS_ORIGIN` set to the actual frontend origin (default is permissive for dev)
- Place a CDN / WAF in front of the public hostname.

## Versioning

This document tracks the threat model for the codebase at `main`. Material changes are noted in commit messages. The most recent audit was 2026-04-30.

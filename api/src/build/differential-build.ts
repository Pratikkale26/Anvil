/**
 * .so build helpers for the production /build/differential endpoint.
 *
 * Mirrors the build flow in api/tests/differential-harness.ts but lives
 * outside the tests/ directory so it can be imported by Express routes
 * without dragging in bun:test. The harness file remains the canonical
 * source for fixture-based CI testing; this module is the equivalent
 * for serving runtime workbench requests.
 *
 * Source-hash cache reused at ~/.anvil-diff-cache/. Same path as the
 * harness so the workbench + the CI fixtures share .so artifacts.
 *
 * SECURITY: cargo-build-sbf runs build.rs scripts from user-supplied
 * source. The same sandbox that wraps the existing /build endpoint
 * (api/src/build/sandbox.ts -- firejail / bwrap / unshare) MUST wrap
 * these spawns too. The build.rs threat model is documented in
 * SECURITY.md.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  statSync,
  linkSync,
  copyFileSync,
} from "node:fs";
import { join, dirname as nodeDirname } from "node:path";
import { createHash } from "node:crypto";
import type { SolanaIR } from "../ir/schema.js";
import { spawnSandboxed, sandboxedEnv } from "./sandbox.js";
import { AnvilError, ErrorCode } from "../errors.js";

const CACHE_ROOT =
  process.env.ANVIL_DIFF_CACHE ??
  join(process.env.HOME ?? "/tmp", ".anvil-diff-cache");

// Cache TTL sweep at module load. Mirrors the harness IIFE
// (api/tests/differential-harness.ts:80-112) so the production
// /build/differential path doesn't accumulate unbounded .so artifacts.
// Each cache dir is ~150-300 KB; over a long-running prod deploy this
// grows to GBs without eviction. Default 7d retention; operators can
// override via ANVIL_DIFF_CACHE_TTL_DAYS (set to 0 to disable).
const CACHE_TTL_DAYS = (() => {
  const raw = process.env.ANVIL_DIFF_CACHE_TTL_DAYS;
  const n = raw ? parseInt(raw, 10) : NaN;
  return Number.isFinite(n) && n >= 0 ? n : 7;
})();

// Size-based eviction cap. The TTL sweep above only catches stale entries;
// a busy dev loop that compiles fresh artifacts every few minutes can fill
// the cache (138GB observed 2026-05-28). After TTL, walk the cache LRU
// (oldest mtime first) and remove dirs until total size ≤ cap.
// Default 135GB; override via ANVIL_DIFF_CACHE_MAX_GB (set to 0 to disable).
const CACHE_MAX_BYTES = (() => {
  const raw = process.env.ANVIL_DIFF_CACHE_MAX_GB;
  const n = raw ? parseFloat(raw) : NaN;
  const gb = Number.isFinite(n) && n >= 0 ? n : 135;
  return gb * 1024 * 1024 * 1024;
})();

function dirSizeBytes(p: string): number {
  let total = 0;
  try {
    for (const e of readdirSync(p, { withFileTypes: true })) {
      const cp = join(p, e.name);
      try {
        if (e.isDirectory()) {
          total += dirSizeBytes(cp);
        } else {
          const s = statSync(cp);
          total += s.size;
        }
      } catch {
        // unreadable entry — skip
      }
    }
  } catch {
    // unreadable dir — skip
  }
  return total;
}

(() => {
  if (CACHE_TTL_DAYS === 0) return;
  if (!existsSync(CACHE_ROOT)) return;
  const cutoffMs = Date.now() - CACHE_TTL_DAYS * 24 * 60 * 60 * 1000;
  let evicted = 0;
  let skipped = 0;
  try {
    for (const entry of readdirSync(CACHE_ROOT, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const p = join(CACHE_ROOT, entry.name);
      try {
        const s = statSync(p);
        if (s.mtimeMs < cutoffMs) {
          rmSync(p, { recursive: true, force: true });
          evicted++;
        }
      } catch {
        skipped++;
      }
    }
    if (evicted > 0) {
      console.log(
        `[diff-cache] evicted ${evicted} dir(s) older than ${CACHE_TTL_DAYS}d from ${CACHE_ROOT}` +
          (skipped ? ` (${skipped} skipped)` : ""),
      );
    }
  } catch (err) {
    console.warn(`[diff-cache] sweep failed: ${err instanceof Error ? err.message : String(err)}`);
  }
})();

(() => {
  if (CACHE_MAX_BYTES === 0) return;
  if (!existsSync(CACHE_ROOT)) return;
  try {
    const entries: Array<{ path: string; mtimeMs: number; size: number }> = [];
    for (const e of readdirSync(CACHE_ROOT, { withFileTypes: true })) {
      if (!e.isDirectory()) continue;
      const p = join(CACHE_ROOT, e.name);
      try {
        const s = statSync(p);
        entries.push({ path: p, mtimeMs: s.mtimeMs, size: dirSizeBytes(p) });
      } catch {
        // skip
      }
    }
    let total = entries.reduce((a, b) => a + b.size, 0);
    if (total <= CACHE_MAX_BYTES) return;
    entries.sort((a, b) => a.mtimeMs - b.mtimeMs);
    let evicted = 0;
    let freed = 0;
    for (const e of entries) {
      if (total <= CACHE_MAX_BYTES) break;
      try {
        rmSync(e.path, { recursive: true, force: true });
        total -= e.size;
        freed += e.size;
        evicted++;
      } catch {
        // skip unremovable
      }
    }
    if (evicted > 0) {
      const gb = (n: number) => (n / (1024 ** 3)).toFixed(1);
      console.log(
        `[diff-cache] size-evicted ${evicted} dir(s), freed ${gb(freed)}GB ` +
          `(cap ${gb(CACHE_MAX_BYTES)}GB, post ${gb(total)}GB)`,
      );
    }
  } catch (err) {
    console.warn(`[diff-cache] size-sweep failed: ${err instanceof Error ? err.message : String(err)}`);
  }
})();

export interface BuildArtifacts {
  anchorSoPath: string;
  anvilSoPath: string;
  cacheState: { anchor: "hit" | "miss"; anvil: "hit" | "miss" };
}

export interface DifferentialBuildOptions {
  /** Anchor source as a single string (already flattened by project-source.ts). */
  anchorSource: string;
  /** Files to write into the Anvil scratch project under src/. */
  anvilEmittedFiles: Array<{ path: string; content: string }>;
  /** Files to write at the Anvil scratch project root (Cargo.toml, etc.). */
  anvilScaffoldFiles: Array<{ path: string; content: string }>;
  /** Anchor reference Cargo.toml extra deps (anchor-spl, etc.). */
  anchorExtraDeps?: string;
  /** Anchor lang features the reference build needs (init-if-needed, etc.). */
  anchorLangFeatures?: string[];
  /** Used in scratch dir + cache key naming. Should be a stable identifier. */
  programName: string;
  /** Stream cargo output as it happens (for SSE consumers). */
  onLog?: (line: string) => void;
  /** Cancel in-flight builds. Caller wires SIGTERM via this handle. */
  cancelHandle?: { current: { cancel: () => void } | null };
  /** IR — used in cache-key derivation so a parser-only change invalidates. */
  ir?: SolanaIR;
  /**
   * Base58 program ID the scenario will deploy the .so at. The Anchor source's
   * `declare_id!()` and the Anvil-emitted source's program-id constant are
   * both rewritten to this value before building so `crate::ID` matches the
   * deploy address. When omitted, both builds use whatever ID is in the
   * source already. CRITICAL for the cache: if a request hits with a
   * different programIdBase58 than a cached .so was built for, Anchor's
   * `Account<'info, T>` owner check fails on every step. Folded into the
   * source-hash so cache entries are partitioned by deploy-id.
   */
  programIdBase58?: string;
}

/**
 * N5 — Per-replica concurrency cap for differential builds.
 *
 * The per-IP build-sbf cap (ANVIL_BUILD_SBF_PER_IP_CAP, default 2 in
 * build-runner.ts) bounds ONE caller's pipeline. It doesn't bound the
 * total number of concurrent cargo-build-sbf processes on a single
 * host: 10 IPs each firing 2 differential requests = 20 simultaneous
 * SBF builds. cargo-build-sbf is CPU-heavy + RAM-heavy (each invocation
 * easily uses 1-2 GiB during link); a small VPS can be DOS-ed by fan-out
 * across IPs.
 *
 * This cap is per-PROCESS (per replica). Multi-replica deploys still
 * get N × cap total concurrency across the cluster — that's the
 * intended scaling lever. Operator can override via
 * ANVIL_DIFFERENTIAL_REPLICA_CAP, default 2.
 *
 * Implementation: a counting semaphore wrapping buildBothSos. Excess
 * requests wait on a Promise queue (FIFO). Wait-time is bounded by the
 * existing rate-limit + per-IP-cap layers so the queue can't grow
 * unbounded.
 */
const DIFFERENTIAL_REPLICA_CAP = (() => {
  const raw = process.env.ANVIL_DIFFERENTIAL_REPLICA_CAP;
  const parsed = raw ? parseInt(raw, 10) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 2;
})();
let differentialInflight = 0;
const differentialWaitQueue: Array<() => void> = [];

function acquireDifferentialSlot(): Promise<void> {
  if (differentialInflight < DIFFERENTIAL_REPLICA_CAP) {
    differentialInflight++;
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => {
    differentialWaitQueue.push(() => {
      differentialInflight++;
      resolve();
    });
  });
}
function releaseDifferentialSlot(): void {
  differentialInflight--;
  const next = differentialWaitQueue.shift();
  if (next) next();
}

/**
 * Test-only handle exposing the current in-flight + queue depth.
 * Useful for asserting the cap is enforced; not part of the public API.
 */
export function _differentialSlotStateForTests(): { inflight: number; queued: number; cap: number } {
  return {
    inflight: differentialInflight,
    queued: differentialWaitQueue.length,
    cap: DIFFERENTIAL_REPLICA_CAP,
  };
}

/**
 * Build the Anchor reference + Anvil emitted .so files. Reuses cached
 * artifacts when source-hash matches. Both builds run inside the
 * sandbox layer.
 */
export async function buildBothSos(opts: DifferentialBuildOptions): Promise<BuildArtifacts> {
  // N5 — acquire one of DIFFERENTIAL_REPLICA_CAP semaphore slots before
  // touching the SBF toolchain. Cache hits skip the cargo invocation
  // BUT we still hold the slot through the artifact check; that's fine
  // because cache hits are millisecond-scale.
  await acquireDifferentialSlot();
  try {
    return await buildBothSosImpl(opts);
  } finally {
    releaseDifferentialSlot();
  }
}

async function buildBothSosImpl(opts: DifferentialBuildOptions): Promise<BuildArtifacts> {
  // Both hashes include programIdBase58 so a request that overrides the
  // deploy ID gets a fresh .so rather than a cached one baked with the
  // source's original `declare_id!()`. Without this, Anchor's owner check
  // (info.owner == &crate::ID) fails on the second run with a confusing
  // ConstraintOwner error — looks like a real divergence but is purely
  // a cache-staleness artifact.
  //
  // NOTE — design asymmetry with the test harness (api/tests/differential-
  // harness.ts). That file folds an ANVIL_CODE_VERSION (hash of
  // src/parser + src/emitter + src/ir/schema) into its cache dir, because
  // it parses + emits at run time from `fixture.anchorSource`. Parser
  // changes there silently invalidate cached .so otherwise. THIS file
  // does NOT need that — it receives already-emitted files in
  // `opts.anvilEmittedFiles`, so a parser/emitter change shows up here
  // as different file content → different hash automatically. The
  // asymmetry is intentional. Don't add ANVIL_CODE_VERSION here.
  const idTag = opts.programIdBase58 ?? "";
  const anchorHash = hashOf(opts.anchorSource + (opts.anchorExtraDeps ?? "") + (opts.anchorLangFeatures?.join(",") ?? "") + idTag);
  const anvilHash = hashOf(JSON.stringify(opts.anvilEmittedFiles) + JSON.stringify(opts.anvilScaffoldFiles) + idTag);

  const cacheDir = join(CACHE_ROOT, `workbench-${opts.programName}`);
  mkdirSync(cacheDir, { recursive: true });
  const anchorSoPath = join(cacheDir, `${opts.programName}_anchor_${anchorHash}.so`);
  const anvilSoPath = join(cacheDir, `${opts.programName}_anvil_${anvilHash}.so`);

  const anchorCached = existsSync(anchorSoPath);
  const anvilCached = existsSync(anvilSoPath);

  if (!anchorCached) {
    opts.onLog?.(`[anchor] cache miss -- building reference .so`);
    await buildAnchor(opts, anchorSoPath);
    opts.onLog?.(`[anchor] built (${statSync(anchorSoPath).size} bytes)`);
  } else {
    opts.onLog?.(`[anchor] cache hit (${statSync(anchorSoPath).size} bytes)`);
  }

  if (!anvilCached) {
    opts.onLog?.(`[anvil] cache miss -- building emitted .so`);
    await buildAnvil(opts, anvilSoPath);
    opts.onLog?.(`[anvil] built (${statSync(anvilSoPath).size} bytes)`);
  } else {
    opts.onLog?.(`[anvil] cache hit (${statSync(anvilSoPath).size} bytes)`);
  }

  return {
    anchorSoPath,
    anvilSoPath,
    cacheState: {
      anchor: anchorCached ? "hit" : "miss",
      anvil: anvilCached ? "hit" : "miss",
    },
  };
}

// #16 — per-invocation scratch suffix. The scratch build dirs were keyed by
// program-name ONLY (`_workbench_build_escrow_anchor`), so two concurrent
// hosted builds of the same program (common names: escrow / counter / amm)
// raced on the same rmSync + writeFileSync + cargo target dir → half-written
// Cargo.toml, "No such file or directory" mid-compile, corrupt .so. The output
// .so is content-addressed (workbench-<name>/<name>_<side>_<hash>.so), so the
// scratch is disposable: give each build its own dir (pid isolates replicas,
// the counter isolates intra-process concurrency) and remove it after the .so
// is copied out.
let scratchSeq = 0;
function uniqueScratch(programName: string, side: "anchor" | "anvil"): string {
  return join(CACHE_ROOT, `_workbench_build_${programName}_p${process.pid}_${++scratchSeq}_${side}`);
}

async function buildAnchor(opts: DifferentialBuildOptions, outPath: string): Promise<void> {
  const scratch = uniqueScratch(opts.programName, "anchor");
  rmSync(scratch, { recursive: true, force: true });
  mkdirSync(join(scratch, "src"), { recursive: true });
  opts.onLog?.(`[anchor] scratch=${scratch}`);
  // Workbench callers don't send anchorExtraDeps -- they paste source and
  // expect the build to "just work". Sniff anchor-spl / anchor-spl-feature
  // usage out of the source so the Anchor reference Cargo.toml gets the
  // crates rustc actually needs. Fixture-based tests still pass an
  // explicit anchorExtraDeps and override this.
  const sniffed = sniffAnchorExtraDeps(opts.anchorSource);
  const extraDeps = opts.anchorExtraDeps ?? sniffed;
  // Workbench callers also don't send anchorLangFeatures. Sniff
  // init-if-needed usage; without it, derive(Accounts) silently
  // skips emitting Bumps/etc. for structs whose constraints reference
  // init_if_needed and the caller fails with cryptic "trait Bumps
  // not satisfied" errors at handler signatures.
  const sniffedLangFeatures = sniffAnchorLangFeatures(opts.anchorSource);
  const langFeatures = opts.anchorLangFeatures ?? sniffedLangFeatures;
  // B3 — anchor-lang version sniff. Hard-pinning to 0.31 fails for
  // programs targeting 0.30 / 0.29 with confusing rustc errors
  // (deprecated APIs, dep resolution drift). Sniff a `// anchor-lang
  // 0.30` style comment OR an actual version string in source. Fall
  // back to 0.31 (current) if not found. We use the same version for
  // both anchor-lang and anchor-spl so they resolve consistently.
  const anchorLangVersion = sniffAnchorLangVersion(opts.anchorSource);
  // B1 — strict allowlist of anchorExtraDeps. The warmup at line ~252
  // runs `cargo fetch` OUTSIDE the sandbox with network access (it
  // needs the network to populate $CARGO_HOME). The body content of
  // Cargo.toml dictates which crates that fetch downloads. Without
  // validation, a request body containing `evil = { git = "..." }`
  // would clone arbitrary HTTPS/SSH from inside the deploy VPC, or
  // `random-typosquat = "1.0"` would land in the shared $CARGO_HOME.
  // SECURITY.md previously claimed CARGO_NET_OFFLINE=true was forced
  // on every invocation; the warmup explicitly disables it, so this
  // allowlist is the actual cut. Throws a typed Error that the route
  // layer maps to a 400 — never reaches warmup.
  const validatedExtraDeps = validateAnchorExtraDeps(extraDeps);
  const cargoToml = `[package]
name = "${opts.programName}"
version = "0.1.0"
edition = "2021"
[lib]
crate-type = ["cdylib", "lib"]
name = "${opts.programName}"
[features]
no-entrypoint = []
no-idl = []
no-log-ix-name = []
cpi = ["no-entrypoint"]
default = []
[dependencies]
${langFeatures.length > 0
  ? `anchor-lang = { version = "${anchorLangVersion}", features = ["${langFeatures.join('", "')}"] }`
  : `anchor-lang = "${anchorLangVersion}"`}
${validatedExtraDeps.replace(/version = "0\.31"/g, `version = "${anchorLangVersion}"`).replace(/anchor-spl = "0\.31"/g, `anchor-spl = "${anchorLangVersion}"`)}

# Real Anchor's generated [profile.release] enables overflow-checks. The Anvil
# side of this byte-equal build gets it via the scaffold (project-scaffold.ts),
# so the Anchor reference MUST match or /build's own byte-equal falsely diverges
# on any overflow-prone program (Anchor wraps, Anvil reverts). See build-runner.ts
# + differential-overflow-revert.
[profile.release]
overflow-checks = true
`;
  writeFileSync(join(scratch, "Cargo.toml"), cargoToml);
  writeFileSync(
    join(scratch, "src/lib.rs"),
    patchAnchorSourceCompat(rewriteDeclareId(opts.anchorSource, opts.programIdBase58)),
  );
  // Warm the cargo registry BEFORE the sandboxed offline cargo-build-sbf
  // run. Without this, fresh deployments (DigitalOcean / Docker images
  // with no prior cargo cache) fail with "no matching package named
  // anchor-lang found ... using offline mode (--offline)" when cargo
  // metadata can't resolve anchor-lang from the empty registry.
  // build-runner.ts already does this for non-differential builds; the
  // workbench differential path needs the same treatment.
  await warmDifferentialDependencies(scratch, opts);
  await runSandboxedSbf(scratch, opts);
  copySoFromTarget(scratch, outPath);
  // #16 — remove the per-invocation scratch now the .so is cached at outPath.
  // On error we intentionally leave it for the CACHE_TTL sweep to inspect/evict.
  rmSync(scratch, { recursive: true, force: true });
}

/**
 * Pre-fetch crate deps with network access so the subsequent sandboxed
 * `cargo-build-sbf --offline` run can resolve them from the local
 * registry. Mirrors `warmDependencies` in build-runner.ts (separate
 * because that one is private + tailored to its scratch layout).
 */
function warmDifferentialDependencies(
  scratchDir: string,
  opts: DifferentialBuildOptions,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("cargo", ["fetch", "--quiet"], {
      cwd: scratchDir,
      env: { ...sandboxedEnv(), CARGO_NET_OFFLINE: "false" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr?.on("data", (c: Buffer) => {
      stderr += c.toString("utf-8");
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      const trimmed = stderr.trim().split("\n").slice(-15).join("\n");
      const err = new Error(
        `cargo fetch (warmup) failed (exit ${code}, cwd=${scratchDir})\n${trimmed || "(no stderr)"}`,
      );
      opts.onLog?.(`[cargo-fetch] warmup failed: ${err.message}`);
      reject(err);
    });
  });
}

/**
 * Best-effort detection of anchor-spl + cargo features from raw Anchor
 * source. Returns Cargo.toml [dependencies] lines (or "" if none needed).
 *
 * Mirrors the explicit anchorExtraDeps strings the fixture-based tests
 * declare -- workbench callers don't author those, so we infer from the
 * `use anchor_spl::*;` / `use anchor_lang::system_program;` shapes in the
 * pasted source. Adds anchor-spl features only when their submodule path
 * is referenced (token_2022, memo, associated_token, metadata) so we
 * don't pull in unnecessary feature flags + their deps.
 */
/**
 * Best-effort detection of the anchor-lang version the source targets.
 * Source can carry the version as:
 *   1. an explicit Cargo.toml-shape comment in the lib.rs (`// anchor-lang
 *      = "0.30"`) — common in tutorial copies pasted into the workbench
 *   2. a doc-comment `//! anchor-lang 0.30` style note
 *   3. inline reference like `anchor_lang = "0.30"` if the user pasted
 *      Cargo.toml content into the source by accident
 *
 * Returns the matched version (e.g. "0.30") or "0.31" as a default.
 * Pinned to {0.29, 0.30, 0.31} — anything outside that set falls back
 * to 0.31. We don't try to resolve symbol-level API differences;
 * choosing the wrong version usually surfaces a clear rustc error
 * (deprecated::removed) which is easier to diagnose than the cryptic
 * dep-resolution failures the previous hard-pin produced.
 */
export function sniffAnchorLangVersion(source: string): string {
  // Detect Anchor 1.0+ syntactic markers that don't exist in 0.31:
  //   - `dup` constraint in #[derive(Accounts)] (allows duplicate accounts)
  //   - `#[instruction(discriminator = X)]` literal disc override
  // When either appears, force 1.0 for that source. Other sources stay on
  // 0.31 (the default) so the 18 byte-equal fixtures don't get dragged
  // into the 1.0 ecosystem migration.
  const hasOneZeroOnlySyntax =
    // `dup,` constraint inside #[derive(Accounts)] — appears on its own
    // indented line in multi-line account blocks. Tighten the match to
    // require leading whitespace and either a trailing comment or
    // end-of-line — this avoids matching tuple destructuring patterns
    // like `let dup, foo = expr;` (the legitimate `dup` constraint is
    // only ever inside an #[account(...)] block, which uses indented
    // single-flag lines).
    /^\s+dup\s*,(?:\s*\/\/.*)?$/m.test(source) ||
    // `#[instruction(discriminator = ...)]` — 1.0 literal disc form.
    /#\[instruction\s*\(\s*discriminator\s*=/.test(source);
  if (hasOneZeroOnlySyntax) return "1.0";

  // N6 audit (2026-05-18): added 0.32. Pre-N6 0.32 sources fell back to
  // 0.31 silently — most carry through fine (0.32 is largely additive
  // over 0.31 — adds Anchor's first-class `events::*` API + the new
  // `interfaces::*` module shapes), but a 0.32-specific feature flag set
  // off-pinned could surface as cryptic dep-resolution errors. Surface
  // the version explicitly so the differential harness pins the matching
  // anchor-lang dep.
  const ALLOWED = new Set(["0.29", "0.30", "0.31", "0.32"]);
  const re = /anchor[-_]lang\s*[=:]?\s*['"`]?(0\.(?:29|30|31|32)(?:\.\d+)?)/;
  const m = source.match(re);
  if (m?.[1]) {
    // Strip patch component if present — Cargo accepts the major.minor form.
    const minor = m[1].split(".").slice(0, 2).join(".");
    if (ALLOWED.has(minor)) return minor;
  }
  return "0.31";
}

/**
 * Detect anchor-lang cargo features the source needs but the workbench
 * caller didn't declare. Currently scans for `init_if_needed` inside
 * `#[account(...)]` annotations — Anchor gates that constraint behind
 * the `init-if-needed` feature; without it, derive(Accounts) skips
 * emitting Bumps/AccountsExit/etc. for affected structs and the build
 * fails with "the trait `Bumps` is not implemented for X<'_>" at the
 * handler signature, several layers removed from the actual cause.
 */
function sniffAnchorLangFeatures(source: string): string[] {
  const features: string[] = [];
  if (/\binit_if_needed\b/.test(source)) features.push("init-if-needed");
  // event-cpi feature gates the #[event_cpi] attribute + emit_cpi! macro.
  // Without it, derive macros silently skip emitting the event-cpi
  // plumbing and the build fails with "cannot find attribute `event_cpi`".
  if (/#\[event_cpi\]|\bemit_cpi!/.test(source)) features.push("event-cpi");
  // idl-build feature is needed when source carries IDL-build glue. Rare
  // but surfaces in some Anchor 0.30+ programs that ship IDL hooks.
  if (/\bidl_build\b/.test(source)) features.push("idl-build");
  return features;
}

/**
 * Crate names callers may pass via `anchorExtraDeps`. The differential
 * harness's Anchor reference build needs the standard SPL / oracle /
 * helper crates and nothing else. Any other crate name → 400. The
 * names cover anchor-lang 0.29 → 1.0 + the typed-CPI surface Anvil
 * actively transpiles (SPL, Token-2022, ATA, Memo, Metaplex, Pyth,
 * Switchboard) plus the well-known helper crates that appear in real
 * Anchor programs (bytemuck, borsh, thiserror, etc.).
 *
 * Adding a name here means: trusting that crate's authors + crates.io
 * publishing path. Don't add anything you wouldn't want a `build.rs`
 * from that crate to execute (sandboxed) on this host. NEVER add a
 * crate that ships proc-macros doing arbitrary I/O at compile time
 * unless we've audited the macro.
 */
const ANCHOR_EXTRA_DEPS_ALLOWLIST = new Set<string>([
  // Anchor + ecosystem
  "anchor-lang",
  "anchor-spl",
  "anchor-syn",
  "anchor-derive-accounts",
  "anchor-derive-space",
  "anchor-attribute-account",
  // SPL Token family
  "spl-token",
  "spl-token-2022",
  "spl-token-metadata-interface",
  "spl-pod",
  "spl-type-length-value",
  "spl-associated-token-account",
  "spl-memo",
  "spl-discriminator",
  // Metaplex
  "mpl-token-metadata",
  // Oracle SDKs (legacy + modern)
  "pyth-sdk-solana",
  "pyth-solana-receiver-sdk",
  "switchboard-v2",
  "switchboard-on-demand",
  "switchboard-solana",
  // Solana base
  "solana-program",
  "solana-security-txt",
  // Common helper crates that show up in real Anchor programs
  "bytemuck",
  "borsh",
  "borsh-derive",
  "num-derive",
  "num-traits",
  "thiserror",
  "arrayref",
  "static_assertions",
  "static-assertions",
  "ahash",
  "uint",
  "fixed",
  "ux",
  "rust_decimal",
]);

/**
 * Tokens that signal an out-of-registry source override inside a Cargo.toml
 * dependency spec. Any of these in `anchorExtraDeps` → 400. We allow only
 * `version = "..."` (and optional `features = [...]`, `default-features
 * = false`, `optional = ...`) — everything else (git/path/branch/tag/rev/
 * registry/package-rename) gets refused.
 *
 * Why each is blocked:
 *  - `git=` / `path=` — arbitrary URL/FS source bypasses crates.io trust.
 *  - `branch=`/`tag=`/`rev=` — only meaningful alongside `git=`; reject
 *    independently so a half-stripped attack still fails.
 *  - `registry=` — alternate registries trust their own publishers.
 *  - `package=` — package-rename lets `cute-name = { package = "evil" }`
 *    smuggle an off-allowlist crate under an allowed alias.
 */
/**
 * Fail-closed allowlist of dependency-table keys. A dep may only pin a
 * crates.io version + select features — NEVER its source. Everything else
 * (git / path / branch / tag / rev / registry / package-rename / workspace / …)
 * is refused. An allowlist beats the previous banned-key denylist because the
 * denylist regex `\bgit\s*=` was BYPASSED by quoting the key: `{ "git" = "…" }`
 * — the closing quote breaks the git→= adjacency, yet cargo honors the quoted
 * key and normalizes it to a `git+https://…` source, so the out-of-sandbox
 * `cargo fetch` cloned an attacker URL (SSRF) and pulled an off-allowlist crate
 * under an allowed alias.
 */
const ANCHOR_EXTRA_DEPS_ALLOWED_TABLE_KEYS = new Set([
  "version",
  "features",
  "optional",
  "default-features",
]);

/**
 * Extract the KEYS of a single-line TOML inline table RHS
 * (`{ version = "1", "git" = "url", features = ["x"] }`). Handles bare,
 * "double"- and 'single'-quoted keys, string values (so `=`/`,` inside a value
 * is ignored), and nested [] / {}. Lowercased. This is what defeats the quoted-
 * key bypass a `\bKEY\s*=` regex could not see.
 */
function extractInlineTableKeys(rhs: string): string[] {
  const inner = rhs.trim().replace(/^\{/, "").replace(/\}$/, "");
  const keys: string[] = [];
  let i = 0;
  const n = inner.length;
  while (i < n) {
    while (i < n && /[\s,]/.test(inner[i]!)) i++; // skip separators
    if (i >= n) break;
    let key = "";
    if (inner[i] === '"' || inner[i] === "'" || inner[i] === "`") {
      const q = inner[i]!; i++;
      while (i < n && inner[i] !== q) { key += inner[i]; i++; }
      i++; // closing quote
    } else {
      while (i < n && !/[\s=]/.test(inner[i]!)) { key += inner[i]; i++; }
    }
    keys.push(key.trim().toLowerCase());
    while (i < n && inner[i] !== "=") i++; // advance to '='
    i++; // past '='
    // Skip the VALUE, respecting quoted strings and nested [] / {} so a comma
    // or '=' inside a value never starts a phantom key.
    let depth = 0;
    while (i < n) {
      const c = inner[i]!;
      if (c === '"' || c === "'" || c === "`") {
        const q = c; i++;
        while (i < n && inner[i] !== q) { if (inner[i] === "\\") i++; i++; }
        i++; continue;
      }
      if (c === "[" || c === "{") { depth++; i++; continue; }
      if (c === "]" || c === "}") { depth--; i++; continue; }
      if (c === "," && depth === 0) { break; }
      i++;
    }
  }
  return keys.filter((k) => k.length > 0);
}

/**
 * Validate user-supplied `[dependencies]` snippet before it lands in the
 * Anchor reference Cargo.toml. Throws AnvilError-shaped failure if any
 * unrecognized crate name or banned key appears. Returns the input
 * unchanged on success (no normalization — the existing version-pin
 * rewrites in buildAnchor() operate on the same text).
 */
export function validateAnchorExtraDeps(extraDeps: string): string {
  if (!extraDeps || extraDeps.trim() === "") return extraDeps;
  // Strip line / block comments first so the line walker doesn't
  // false-positive on `# git = "..."` style hints.
  const stripped = extraDeps
    .split(/\r?\n/)
    .map((l) => l.replace(/#.*$/, ""))
    .filter((l) => l.trim() !== "");
  for (const line of stripped) {
    // Each line should be `<name> = "<version>"` or `<name> = { ... }`.
    // The TOML form we accept is single-line per dep; multi-line tables
    // would require a real TOML parser and aren't generated by the
    // sniffer or the fixture catalog.
    const eqIdx = line.indexOf("=");
    if (eqIdx === -1) {
      throw new AnvilError(
        ErrorCode.VALIDATION_FAILED,
        "anchorExtraDeps: malformed dependency line",
        `Expected "<name> = <version-or-table>" on each line; saw "${line.trim().slice(0, 80)}".`,
        400,
      );
    }
    const rawName = line.slice(0, eqIdx).trim();
    // Strip TOML key quoting if present (`"foo" = "1.0"` is valid TOML).
    const name = rawName.replace(/^["'`]/, "").replace(/["'`]$/, "");
    if (!/^[A-Za-z0-9_.-]+$/.test(name)) {
      throw new AnvilError(
        ErrorCode.VALIDATION_FAILED,
        "anchorExtraDeps: invalid crate name",
        `"${name}" contains characters outside [A-Za-z0-9_.-].`,
        400,
      );
    }
    if (!ANCHOR_EXTRA_DEPS_ALLOWLIST.has(name)) {
      throw new AnvilError(
        ErrorCode.VALIDATION_FAILED,
        `anchorExtraDeps: crate "${name}" is not on the differential-build allowlist`,
        `Allowed: ${[...ANCHOR_EXTRA_DEPS_ALLOWLIST].sort().join(", ")}`,
        400,
      );
    }
    const rhs = line.slice(eqIdx + 1).trim();
    // If RHS is a table-shape value, allowlist its keys. Parsing the KEYS
    // (rather than regex-scanning for banned tokens) is what closes the quoted-
    // key bypass: `{ "git" = "…" }` is extracted as key `git` and refused.
    if (rhs.startsWith("{")) {
      for (const key of extractInlineTableKeys(rhs)) {
        if (!ANCHOR_EXTRA_DEPS_ALLOWED_TABLE_KEYS.has(key)) {
          throw new AnvilError(
            ErrorCode.VALIDATION_FAILED,
            `anchorExtraDeps: dependency-table key "${key}" is not permitted on "${name}"`,
            "Only registry version pins are accepted: version, features, optional, default-features. " +
              "Source overrides (git / path / branch / tag / rev / registry / package-rename) are " +
              "blocked — a quoted key like `\"git\" =` does NOT bypass this.",
            400,
          );
        }
      }
    }
  }
  return extraDeps;
}

/**
 * #11 / R5 — the /build/differential route accepts a CLIENT-supplied
 * `anvilScaffoldFiles` scaffold (Cargo.toml included) that is written verbatim
 * and resolved by the SAME out-of-sandbox `cargo fetch`. validateAnchorExtraDeps
 * only guards the Anchor reference side; this guards the client scaffold. It
 * refuses any dependency-table SOURCE-OVERRIDE key (git / path / branch / tag /
 * rev / registry / package / workspace) in any `[*dependencies*]` section —
 * both the flat `foo = { git = "…" }` form and the per-crate
 * `[dependencies.foo]` + `git = "…"` form.
 *
 * A crate-name allowlist is intentionally NOT enforced here (the Anvil scaffold
 * legitimately uses pinocchio / borsh / five8 / bytemuck, off the Anchor
 * allowlist); blocking source overrides closes the SSRF/supply-chain vector,
 * which is the R5 concern. Clients can omit anvilScaffoldFiles to use the
 * server-synthesized scaffold.
 */
export function assertScaffoldDepsSafe(
  files: ReadonlyArray<{ path: string; content: string }>,
): void {
  for (const f of files) {
    if (!/(^|\/)Cargo\.toml$/i.test(f.path)) continue;
    let section = "";
    for (const rawLine of f.content.split(/\r?\n/)) {
      const line = rawLine.replace(/#.*$/, "").trim();
      if (line === "") continue;
      const hdr = line.match(/^\[\s*([^\]]+?)\s*\]$/);
      if (hdr) { section = hdr[1]!.toLowerCase(); continue; }
      // A dependency section's dotted path contains a `(dev-|build-)?dependencies`
      // segment (e.g. `dependencies`, `dev-dependencies`,
      // `target.'cfg(unix)'.dependencies`, `dependencies.foo`).
      if (!/(^|\.)(?:dev-|build-)?dependencies(\.|$)/.test(section)) continue;
      const eq = line.indexOf("=");
      if (eq === -1) continue;
      const lhs = line.slice(0, eq).trim().replace(/^["'`]|["'`]$/g, "").toLowerCase();
      const rhs = line.slice(eq + 1).trim();
      // Per-crate table (`[dependencies.foo]`): the line's LHS IS a table key.
      // Flat section (`[dependencies]`): keys live in the inline `{ … }` RHS.
      const perCrate = /(^|\.)(?:dev-|build-)?dependencies\.[^.]/.test(section);
      const keys = perCrate ? [lhs] : (rhs.startsWith("{") ? extractInlineTableKeys(rhs) : []);
      for (const key of keys) {
        if (!ANCHOR_EXTRA_DEPS_ALLOWED_TABLE_KEYS.has(key)) {
          throw new AnvilError(
            ErrorCode.VALIDATION_FAILED,
            `anvilScaffoldFiles: '${f.path}' uses source-override key "${key}" in [${section}]`,
            "A client-supplied Cargo.toml may only pin registry versions " +
              "(version / features / optional / default-features). git / path / branch / " +
              "tag / rev / registry / package / workspace are blocked because the differential " +
              "warm-fetch has network access. Omit anvilScaffoldFiles to use the server scaffold.",
            400,
          );
        }
      }
    }
  }
}

function sniffAnchorExtraDeps(source: string): string {
  const deps: string[] = [];
  // anchor-spl with feature flags
  if (/\banchor_spl\b/.test(source)) {
    const features: string[] = [];
    if (/\banchor_spl::associated_token\b/.test(source)) features.push("associated_token");
    if (/\banchor_spl::memo\b/.test(source)) features.push("memo");
    if (/\banchor_spl::metadata\b/.test(source) ||
        // Brace-form nested use: `use anchor_spl::{metadata::..., ...};`
        // or `use { anchor_spl::{metadata::...}, ... };`. The exact path
        // string `anchor_spl::metadata` doesn't appear; detect by
        // metadata-specific type/fn names.
        /\bCreateMetadataAccountsV3\b/.test(source) ||
        /\bCreateMasterEditionV3\b/.test(source) ||
        /\bcreate_metadata_accounts_v3\b/.test(source) ||
        /\bcreate_master_edition_v3\b/.test(source) ||
        /\bmpl_token_metadata\b/.test(source)) features.push("metadata");
    if (/\banchor_spl::token_2022\b/.test(source) || /\btoken_interface\b/.test(source)) {
      features.push("token_2022");
    }
    deps.push(
      features.length === 0
        ? `anchor-spl = "0.31"`
        : `anchor-spl = { version = "0.31", features = ["${features.join('", "')}"] }`,
    );
  }
  // bytemuck — zero-copy / chat program pattern (bytemuck::from_bytes etc.)
  // Anchor 0.31 internally re-exports bytemuck but the user-facing `bytemuck::`
  // path requires the explicit dep.
  if (/\bbytemuck::/.test(source)) {
    deps.push(`bytemuck = { version = "1.13", features = ["derive"] }`);
  }
  // Note: solana-program is brought in transitively by anchor-lang; users
  // don't need to declare it directly. Avoid re-adding it here.
  return deps.join("\n");
}

async function buildAnvil(opts: DifferentialBuildOptions, outPath: string): Promise<void> {
  const scratch = join(CACHE_ROOT, `_workbench_build_${opts.programName}_anvil`);
  rmSync(scratch, { recursive: true, force: true });
  for (const f of opts.anvilScaffoldFiles) {
    const p = join(scratch, f.path);
    // The previous regex-based parent-dir computation incorrectly stripped
    // a directory segment for paths like `Cargo.toml` (no slash) -- it
    // returned an empty string, then mkdirSync({recursive:true}) on "" is
    // a no-op silently. Use node:path.dirname for both cases.
    mkdirSync(nodeDirname(p), { recursive: true });
    writeFileSync(p, f.content, "utf-8");
  }
  for (const f of opts.anvilEmittedFiles) {
    const p = join(scratch, "src", f.path);
    mkdirSync(nodeDirname(p), { recursive: true });
    // Rewrite declare_id! / pinocchio_pubkey! / native ID const so the
    // emitted .so has crate::ID matching the deploy address. Idempotent +
    // a no-op when programIdBase58 is unset.
    writeFileSync(p, rewriteDeclareId(f.content, opts.programIdBase58), "utf-8");
  }
  opts.onLog?.(`[anvil] scratch=${scratch}`);
  // Same warmup fix as buildAnchor — Anvil scaffold deps (pinocchio,
  // borsh, etc.) also need a populated cargo registry before offline
  // cargo-build-sbf can resolve them.
  await warmDifferentialDependencies(scratch, opts);
  await runSandboxedSbf(scratch, opts);
  copySoFromTarget(scratch, outPath);
  // #16 — remove the per-invocation scratch now the .so is cached at outPath.
  // On error we intentionally leave it for the CACHE_TTL sweep to inspect/evict.
  rmSync(scratch, { recursive: true, force: true });
}

/**
 * Rewrite the program-id constant in a Rust source file to match the
 * scenario's deploy address. Touches three shapes:
 *   - Anchor:    `declare_id!("XXX...")`
 *   - Pinocchio: `pinocchio_pubkey::declare_id!("XXX...")`
 *   - Native:    `pub const ID: Pubkey = pubkey!("XXX...")` /
 *                `solana_program::declare_id!("XXX...")`
 * Returns the input unchanged when programIdBase58 is undefined or when
 * none of the patterns match — both are common cases (file is not the
 * lib.rs / programIdBase58 not overridden) and a no-op rewrite is correct.
 *
 * Caveat: shape-tolerant, NOT AST-aware. A `declare_id!("…")` token sitting
 * inside a doc-comment / `///` example / a string literal would also be
 * rewritten. In practice declare_id never appears in those positions in
 * real programs, so the regex is fine. If a real program ever trips this,
 * the upgrade is to parse with tree-sitter + walk the AST for the macro
 * invocation node — a non-trivial change for a benign edge case.
 */
/**
 * Patch upstream Anchor source incompatibilities with crates.io 0.31.
 * Some program-examples / coral-xyz fixtures use Anchor APIs that work
 * with workspace path-deps (Anchor master) but fail with 0.31:
 *
 *   - `CpiContext::new(<X>.key(), ...)` — 0.31 wants AccountInfo, not
 *     Pubkey. Rewrite to `<X>.to_account_info()`. Same for
 *     `new_with_signer`.
 *
 * Only fires when the FIRST arg of `CpiContext::new` is a `.key()` call;
 * doesn't touch valid AccountInfo-shaped first args.
 */
function patchAnchorSourceCompat(source: string): string {
  let out = source;
  // (1) `CpiContext::new(<X>.key(), ...)` → `CpiContext::new(<X>.to_account_info(), ...)`
  out = out.replace(
    /\b(CpiContext::new(?:_with_signer)?\s*\(\s*)([a-zA-Z_][a-zA-Z0-9_.]*)\.key\(\)/g,
    "$1$2.to_account_info()",
  );
  // (2) `let <var> = <X>.key();` where <var> is conventionally a program
  // ref later passed into CpiContext::new. t22-basics / cashiers-check
  // pattern: `let cpi_program = ctx.accounts.token_program.key();`.
  // Rewriting just the let is sufficient — the type at the use-site
  // becomes AccountInfo, matching the CpiContext::new signature.
  out = out.replace(
    /\b(let\s+(?:cpi_program|cpi_program_id|cpi_prog|prog|program_id)\s*=\s*)([a-zA-Z_][a-zA-Z0-9_.]*)\.key\(\)\s*;/g,
    "$1$2.to_account_info();",
  );
  return out;
}

export { rewriteDeclareId as rewriteDeclareIdForTest };
function rewriteDeclareId(source: string, programIdBase58?: string): string {
  if (!programIdBase58) return source;
  let out = source;
  // Most common: bare or pinocchio_pubkey declare_id!("…")
  out = out.replace(
    /\b(declare_id!\s*\(\s*")[1-9A-HJ-NP-Za-km-z]{32,44}("\s*\))/g,
    `$1${programIdBase58}$2`,
  );
  // Native shape: `pub const ID: Pubkey = pubkey!("…");`
  out = out.replace(
    /(\bpubkey!\s*\(\s*")[1-9A-HJ-NP-Za-km-z]{32,44}("\s*\))/g,
    `$1${programIdBase58}$2`,
  );
  return out;
}

/**
 * Make the warmed cargo registry resolvable by BOTH cargos regardless of which
 * side of the cargo-1.85 index-hash flip each lands on.
 *
 * Cargo's registry/{index,cache,src}/index.crates.io-<hash> dir name flipped at
 * cargo 1.85 (6f17… for < 1.85, 1949… for >= 1.85). The byte-equal warm-fetch
 * runs the HOST cargo (>= 1.91 for avm → 1949…), while the offline
 * cargo-build-sbf runs its bundled platform-tools cargo — which on a
 * stale-but-immovable prod image is < 1.85 (cargo-build-sbf 2.1.0 → 6f17…). The
 * offline build then reads an EMPTY index dir → "no matching package named
 * anchor-spl ... offline mode", even though the crate is on disk under the
 * host's hash dir.
 *
 * We can't reliably force prod off the < 1.85 toolchain (DO App Platform caches
 * the Dockerfile toolchain layers — a fresh deploy carries new app code yet
 * keeps cargo-build-sbf 2.1.0), and the sandboxed offline build (--net=none)
 * can't fetch into its own hash dir. So after the warm-fetch we HARDLINK-MIRROR
 * the populated hash dir to the other known hash dir. Hardlinks → near-zero disk
 * + no re-download; the sparse-index .cache blob format is identical across the
 * flip (verified locally cargo 1.79 ↔ 1.96), so the older cargo reads the mirror
 * fine. Version-agnostic + self-healing: works whatever cargo DO ends up baking.
 * Best-effort — any failure just leaves the offline build's own error +
 * diagnoseOfflineRegistry() to fire.
 */
/** crates.io sparse-index dir hashes either side of the cargo-1.85 flip. */
const CRATES_IO_INDEX_HASHES = ["1949cf8c6b5b557f", "6f17d22bba15001f"];
const cratesIoDirName = (h: string) => `index.crates.io-${h}`;

/**
 * Recursively hardlink every file under srcDir into dstDir. Node-native (no
 * dependency on the container's `cp` or its flag portability — the prod image's
 * coreutils warned `-n` is non-portable). Hardlinks share inodes → near-zero
 * disk; falls back to a copy only on EXDEV (cross-device, shouldn't happen
 * within one CARGO_HOME). `overwrite` refreshes existing files (used for the
 * tiny index .cache blobs so a newly-locked version is always current); when
 * false, existing files are left as-is (immutable crate tarballs/sources — only
 * ADD what's missing). Returns the number of files linked/copied.
 */
function hardlinkTree(srcDir: string, dstDir: string, overwrite: boolean): number {
  let n = 0;
  for (const e of readdirSync(srcDir, { withFileTypes: true })) {
    const s = join(srcDir, e.name);
    const d = join(dstDir, e.name);
    if (e.isDirectory()) {
      mkdirSync(d, { recursive: true });
      n += hardlinkTree(s, d, overwrite);
    } else if (e.isFile()) {
      try {
        if (existsSync(d)) {
          if (!overwrite) continue;
          rmSync(d, { force: true });
        }
        linkSync(s, d);
        n++;
      } catch {
        try {
          copyFileSync(s, d);
          n++;
        } catch {
          /* skip a single unreadable entry — the rest still mirror */
        }
      }
    }
    /* symlinks: the cargo registry has none meaningful — skip */
  }
  return n;
}

function mirrorRegistryHashDirs(cargoHome: string, onLog?: (l: string) => void): void {
  try {
    for (const sub of ["index", "cache", "src"]) {
      const base = join(cargoHome, "registry", sub);
      if (!existsSync(base)) continue;
      const present = CRATES_IO_INDEX_HASHES.filter((h) =>
        existsSync(join(base, cratesIoDirName(h))),
      );
      if (present.length === 0) continue;
      for (const srcH of present) {
        for (const dstH of CRATES_IO_INDEX_HASHES) {
          if (dstH === srcH) continue;
          const from = join(base, cratesIoDirName(srcH));
          const to = join(base, cratesIoDirName(dstH));
          mkdirSync(to, { recursive: true });
          const n = hardlinkTree(from, to, /* overwrite index .cache */ sub === "index");
          onLog?.(
            `[anvil] registry mirror: ${sub} ${cratesIoDirName(srcH)} → ${cratesIoDirName(dstH)} (${n} files)`,
          );
        }
      }
    }
  } catch (e) {
    // Loud (not silent): a failed mirror is the difference between byte-equal
    // working and the "no matching package ... offline" error, so surface it.
    onLog?.(`[anvil] registry mirror FAILED: ${(e as Error).message}`);
  }
}

export { mirrorRegistryHashDirs as mirrorRegistryHashDirsForTest };

function runSandboxedSbf(cwd: string, opts: DifferentialBuildOptions): Promise<void> {
  return new Promise((resolve, reject) => {
    const env = sandboxedEnv();
    // Bridge the cargo-1.85 registry index-hash split: the offline build's cargo
    // may compute a different index.crates.io-<hash> dir than the host cargo that
    // warmed the registry. Mirror across both before the sandboxed (--net=none)
    // build, which has no chance to fetch into its own dir.
    const cargoHome =
      env.CARGO_HOME ?? process.env.CARGO_HOME ?? `${process.env.HOME ?? ""}/.cargo`;
    mirrorRegistryHashDirs(cargoHome, opts.onLog);
    // Cap cargo's parallel job count. cargo-build-sbf spawns rustc + cc +
    // rust-lld concurrently across crates -- on WSL2 (and small VMs) the
    // host fork()s start returning EAGAIN once thread/process slots fill,
    // which surfaces as cryptic linker aborts ("ld terminated with signal
    // 6", "Resource temporarily unavailable"). ANVIL_DIFF_JOBS overrides;
    // default is conservative because the workbench is a shared instance.
    const jobs = process.env.ANVIL_DIFF_JOBS ?? "2";
    const child: ChildProcess = spawnSandboxed(
      "cargo-build-sbf",
      ["--jobs", jobs, "--manifest-path", join(cwd, "Cargo.toml")],
      {
        cwd,
        env: {
          ...env,
          RUSTFLAGS: "",
          CARGO_BUILD_JOBS: jobs,
        },
      },
    );
    if (opts.cancelHandle) {
      opts.cancelHandle.current = {
        cancel: () => {
          try { child.kill("SIGTERM"); } catch { /* ignore */ }
        },
      };
    }
    // Tail buffer of recent stdout/stderr -- on non-zero exit we surface
    // the last ~50 lines in the rejected error so the SSE error event
    // shows the actual cargo failure instead of just "exited with code 1".
    const tail: string[] = [];
    let lineBuf = "";
    const onChunk = (chunk: Buffer) => {
      lineBuf += chunk.toString("utf-8");
      let nl;
      while ((nl = lineBuf.indexOf("\n")) >= 0) {
        const line = lineBuf.slice(0, nl);
        lineBuf = lineBuf.slice(nl + 1);
        if (line.length > 0) {
          opts.onLog?.(line);
          tail.push(line);
          if (tail.length > 80) tail.shift();
        }
      }
    };
    child.stdout?.on("data", onChunk);
    child.stderr?.on("data", onChunk);
    const timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch { /* ignore */ }
    }, 10 * 60 * 1000);
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve();
        return;
      }
      // Trim tail to the lines cargo most likely emitted as errors. Keep
      // the bottom of the buffer -- that's where rustc prints the failure.
      const trimmed = tail
        .filter((l) => l.trim().length > 0)
        .slice(-30)
        .join("\n");
      reject(
        new Error(
          `cargo-build-sbf exited with code ${code} (cwd=${cwd})\n--- last build output ---\n${trimmed || "(no output captured)"}${diagnoseOfflineRegistry(trimmed)}`,
        ),
      );
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

/**
 * Self-diagnostic for the "no matching package ... offline mode" byte-equal
 * failure (the host-cargo vs platform-tools-cargo registry-index-hash split).
 * Cargo's `registry/index/index.crates.io-<hash>` dir name flips across cargo
 * versions; if the warm-fetch (host `cargo`) and the offline build
 * (`cargo-build-sbf`'s bundled platform-tools cargo) land on different sides of
 * that flip, the warm-fetch populates one index dir while the offline build
 * reads another (empty) → exactly this error, even though the crate IS on disk.
 *
 * Runs ONLY on that failure signature (cheap, bounded shell-outs) and appends a
 * readout to the error so a prod deploy is self-diagnosing: both cargo versions,
 * and per index dir whether the anchor-spl sparse-index blob is present —
 * flagging a MULTI-DIR split (the smoking gun) vs a single populated dir (which
 * instead points at sandbox/firejail visibility).
 */
function diagnoseOfflineRegistry(tail: string): string {
  if (!/no matching package|offline mode|using offline/i.test(tail)) return "";
  const cargoHome = sandboxedEnv().CARGO_HOME
    ?? process.env.CARGO_HOME
    ?? `${process.env.HOME ?? ""}/.cargo`;
  const out: string[] = ["--- anvil byte-equal offline-registry diagnostic ---"];
  const ver = (label: string, cmd: string) => {
    try {
      const r = spawnSync(cmd, ["--version"], { encoding: "utf-8", timeout: 8000 });
      out.push(`${label}: ${((r.stdout || r.stderr || "").trim().split("\n")[0]) || "(no output)"}`);
    } catch (e) {
      out.push(`${label}: <error ${(e as Error).message}>`);
    }
  };
  ver("host cargo (warm-fetch)", "cargo");
  ver("cargo-build-sbf (offline build)", "cargo-build-sbf");
  try {
    const idxRoot = join(cargoHome, "registry", "index");
    const dirs = existsSync(idxRoot)
      ? readdirSync(idxRoot).filter((d) => d.startsWith("index.crates.io-"))
      : [];
    out.push(`CARGO_HOME=${cargoHome}`);
    out.push(`registry index dirs: ${dirs.join(", ") || "(none)"}`);
    for (const d of dirs) {
      // sparse-index blob path: <index>/.cache/<a>/<b>/<crate>
      const blob = join(idxRoot, d, ".cache", "an", "ch", "anchor-spl");
      out.push(`  ${d}: anchor-spl index blob ${existsSync(blob) ? "PRESENT" : "ABSENT"}`);
    }
    // anvil mirror state: report BOTH known crates.io hashes (index blob + src
    // extraction) so this readout alone says whether mirrorRegistryHashDirs ran.
    // If only ONE hash has the blob, the mirror did NOT run → the deployed image
    // predates the mirror commit (4cb7b90). If BOTH have it yet the build still
    // failed, the offline cargo wants a THIRD location (e.g. the legacy git index
    // github.com-1ecc6299db9ec823) — which the cargo versions above will explain.
    const srcRootDiag = join(cargoHome, "registry", "src");
    let blobsPresent = 0;
    for (const h of CRATES_IO_INDEX_HASHES) {
      const idxBlob = existsSync(
        join(idxRoot, cratesIoDirName(h), ".cache", "an", "ch", "anchor-spl"),
      );
      const srcH = join(srcRootDiag, cratesIoDirName(h));
      const srcOk =
        existsSync(srcH) && readdirSync(srcH).some((c) => c.startsWith("anchor-spl-"));
      if (idxBlob) blobsPresent++;
      out.push(`  hash ${h} (${h === "1949cf8c6b5b557f" ? ">=1.85" : "<1.85"}): index-blob ${idxBlob ? "Y" : "n"} / src ${srcOk ? "Y" : "n"}`);
    }
    out.push(
      blobsPresent >= 2
        ? "  >>> anvil mirror RAN (both hash dirs populated). If the build still failed, the offline cargo wants a different registry than crates.io-sparse — check the legacy git index github.com-1ecc6299db9ec823 and the cargo versions above."
        : "  >>> anvil mirror DID NOT RUN (only one hash dir populated). The deployed image predates commit 4cb7b90 / mirrorRegistryHashDirs — redeploy and confirm /health.differentialMirror === true.",
    );
  } catch (e) {
    out.push(`registry index scan: <error ${(e as Error).message}>`);
  }
  return "\n" + out.join("\n");
}

function copySoFromTarget(scratch: string, outPath: string): void {
  const dir = join(scratch, "target/deploy");
  if (!existsSync(dir)) {
    throw new Error(`build succeeded but target/deploy not found at ${dir}`);
  }
  const files = readdirSync(dir).filter((f) => f.endsWith(".so"));
  if (files.length === 0) {
    throw new Error(`build succeeded but no .so files in ${dir}`);
  }
  const so = readFileSync(join(dir, files[0]!));
  writeFileSync(outPath, so);
}

function hashOf(s: string): string {
  return createHash("sha256").update(s).digest("hex").slice(0, 16);
}

/**
 * Cheap startup-time check: are cargo-build-sbf + anchor on PATH?
 * /health.differentialAvailable surfaces the result so the workbench
 * can render "Differential unavailable" inline when toolchain missing.
 */
export function differentialAvailable(): boolean {
  try {
    const { execSync } = require("node:child_process") as typeof import("node:child_process");
    execSync("command -v cargo-build-sbf", { stdio: "ignore" });
    execSync("command -v anchor", { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/**
 * Is anchor-spl actually resolvable by the OFFLINE reference build? The Docker
 * pre-fetch is now non-fatal (a failed image build would strand prod on a stale
 * image), so a fresh deploy can boot with byte-equal degraded. This cheap disk
 * check (existsSync only) mirrors what the build-time pre-fetch verifies — the
 * sparse-index .cache blob AND the extracted registry/src — so the degraded
 * state is VISIBLE at /health.differentialReason instead of only surfacing as a
 * cryptic "no matching package ... offline mode" the first time a user clicks
 * "Verify byte-equal".
 */
function anchorSplOfflineResolvable(): boolean {
  const cargoHome = process.env.CARGO_HOME ?? `${process.env.HOME ?? ""}/.cargo`;
  try {
    const idxRoot = join(cargoHome, "registry", "index");
    const idxDirs = existsSync(idxRoot)
      ? readdirSync(idxRoot).filter((d) => d.startsWith("index.crates.io-"))
      : [];
    const blobPresent = idxDirs.some((d) =>
      existsSync(join(idxRoot, d, ".cache", "an", "ch", "anchor-spl")),
    );
    const srcRoot = join(cargoHome, "registry", "src");
    const srcPresent = existsSync(srcRoot)
      ? readdirSync(srcRoot).some(
          (d) =>
            d.startsWith("index.crates.io-") &&
            readdirSync(join(srcRoot, d)).some((c) => c.startsWith("anchor-spl-")),
        )
      : false;
    return blobPresent && srcPresent;
  } catch {
    return false;
  }
}

/**
 * Human-readable reason byte-equal is unavailable, or null when it's ready.
 * Surfaced at /health.differentialReason so a degraded deploy explains itself
 * (toolchain missing vs anchor-spl not pre-fetched) rather than serving a stale
 * image or failing only at click-time.
 */
export function differentialReason(): string | null {
  if (!differentialAvailable()) {
    return "cargo-build-sbf or anchor CLI not on PATH";
  }
  if (!anchorSplOfflineResolvable()) {
    return "anchor-spl not resolvable in the offline cargo registry (pre-fetch missing/incomplete) — byte-equal degraded until a runtime warm-fetch repopulates it";
  }
  return null;
}

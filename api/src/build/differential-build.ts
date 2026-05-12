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
import { spawn, type ChildProcess } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  statSync,
} from "node:fs";
import { join, dirname as nodeDirname } from "node:path";
import { createHash } from "node:crypto";
import type { SolanaIR } from "../ir/schema.js";
import { spawnSandboxed, sandboxedEnv } from "./sandbox.js";

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
 * Build the Anchor reference + Anvil emitted .so files. Reuses cached
 * artifacts when source-hash matches. Both builds run inside the
 * sandbox layer.
 */
export async function buildBothSos(opts: DifferentialBuildOptions): Promise<BuildArtifacts> {
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

async function buildAnchor(opts: DifferentialBuildOptions, outPath: string): Promise<void> {
  const scratch = join(CACHE_ROOT, `_workbench_build_${opts.programName}_anchor`);
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
${extraDeps.replace(/version = "0\.31"/g, `version = "${anchorLangVersion}"`).replace(/anchor-spl = "0\.31"/g, `anchor-spl = "${anchorLangVersion}"`)}
`;
  writeFileSync(join(scratch, "Cargo.toml"), cargoToml);
  writeFileSync(
    join(scratch, "src/lib.rs"),
    rewriteDeclareId(opts.anchorSource, opts.programIdBase58),
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
  const ALLOWED = new Set(["0.29", "0.30", "0.31"]);
  const re = /anchor[-_]lang\s*[=:]?\s*['"`]?(0\.(?:29|30|31)(?:\.\d+)?)/;
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
  return features;
}

function sniffAnchorExtraDeps(source: string): string {
  if (!/\banchor_spl\b/.test(source)) return "";
  const features: string[] = [];
  if (/\banchor_spl::associated_token\b/.test(source)) features.push("associated_token");
  if (/\banchor_spl::memo\b/.test(source)) features.push("memo");
  if (/\banchor_spl::metadata\b/.test(source)) features.push("metadata");
  if (/\banchor_spl::token_2022\b/.test(source) || /\btoken_interface\b/.test(source)) {
    features.push("token_2022");
  }
  if (features.length === 0) {
    return `anchor-spl = "0.31"`;
  }
  return `anchor-spl = { version = "0.31", features = ["${features.join('", "')}"] }`;
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

function runSandboxedSbf(cwd: string, opts: DifferentialBuildOptions): Promise<void> {
  return new Promise((resolve, reject) => {
    const env = sandboxedEnv();
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
          `cargo-build-sbf exited with code ${code} (cwd=${cwd})\n--- last build output ---\n${trimmed || "(no output captured)"}`,
        ),
      );
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
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

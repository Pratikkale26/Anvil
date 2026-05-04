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
}

/**
 * Build the Anchor reference + Anvil emitted .so files. Reuses cached
 * artifacts when source-hash matches. Both builds run inside the
 * sandbox layer.
 */
export async function buildBothSos(opts: DifferentialBuildOptions): Promise<BuildArtifacts> {
  const anchorHash = hashOf(opts.anchorSource + (opts.anchorExtraDeps ?? "") + (opts.anchorLangFeatures?.join(",") ?? ""));
  const anvilHash = hashOf(JSON.stringify(opts.anvilEmittedFiles) + JSON.stringify(opts.anvilScaffoldFiles));

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
${opts.anchorLangFeatures && opts.anchorLangFeatures.length > 0
  ? `anchor-lang = { version = "0.31", features = ["${opts.anchorLangFeatures.join('", "')}"] }`
  : `anchor-lang = "0.31"`}
${extraDeps}
`;
  writeFileSync(join(scratch, "Cargo.toml"), cargoToml);
  writeFileSync(join(scratch, "src/lib.rs"), opts.anchorSource);
  await runSandboxedSbf(scratch, opts);
  copySoFromTarget(scratch, outPath);
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
    writeFileSync(p, f.content, "utf-8");
  }
  opts.onLog?.(`[anvil] scratch=${scratch}`);
  await runSandboxedSbf(scratch, opts);
  copySoFromTarget(scratch, outPath);
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

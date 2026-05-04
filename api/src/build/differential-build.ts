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
import { join } from "node:path";
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
${opts.anchorExtraDeps ?? ""}
`;
  writeFileSync(join(scratch, "Cargo.toml"), cargoToml);
  writeFileSync(join(scratch, "src/lib.rs"), opts.anchorSource);
  await runSandboxedSbf(scratch, opts);
  copySoFromTarget(scratch, outPath);
}

async function buildAnvil(opts: DifferentialBuildOptions, outPath: string): Promise<void> {
  const scratch = join(CACHE_ROOT, `_workbench_build_${opts.programName}_anvil`);
  rmSync(scratch, { recursive: true, force: true });
  for (const f of opts.anvilScaffoldFiles) {
    const p = join(scratch, f.path);
    mkdirSync(join(p, "..").replace(/\/[^/]+$/, ""), { recursive: true });
    writeFileSync(p, f.content, "utf-8");
  }
  for (const f of opts.anvilEmittedFiles) {
    const p = join(scratch, "src", f.path);
    mkdirSync(join(p, "..").replace(/\/[^/]+$/, ""), { recursive: true });
    writeFileSync(p, f.content, "utf-8");
  }
  await runSandboxedSbf(scratch, opts);
  copySoFromTarget(scratch, outPath);
}

function runSandboxedSbf(cwd: string, opts: DifferentialBuildOptions): Promise<void> {
  return new Promise((resolve, reject) => {
    const env = sandboxedEnv();
    // cargo-build-sbf needs the platform-tools download path -- don't
    // strip RUSTUP_HOME / CARGO_HOME (sandboxedEnv already keeps those).
    const child: ChildProcess = spawnSandboxed(
      "cargo-build-sbf",
      ["--manifest-path", join(cwd, "Cargo.toml")],
      { cwd, env: { ...env, RUSTFLAGS: "" } },
    );
    if (opts.cancelHandle) {
      opts.cancelHandle.current = {
        cancel: () => {
          try { child.kill("SIGTERM"); } catch { /* ignore */ }
        },
      };
    }
    let lineBuf = "";
    const onChunk = (chunk: Buffer) => {
      lineBuf += chunk.toString("utf-8");
      let nl;
      while ((nl = lineBuf.indexOf("\n")) >= 0) {
        const line = lineBuf.slice(0, nl);
        lineBuf = lineBuf.slice(nl + 1);
        if (line.length > 0) opts.onLog?.(line);
      }
    };
    child.stdout?.on("data", onChunk);
    child.stderr?.on("data", onChunk);
    const timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch { /* ignore */ }
    }, 10 * 60 * 1000);
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`cargo-build-sbf exited with code ${code}`));
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

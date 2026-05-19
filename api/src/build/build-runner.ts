/**
 * Build runner — takes already-emitted Rust files and runs cargo against
 * them in a warm per-target scratch project, returning the compiler
 * diagnostics in a structured form.
 *
 * Build modes (see BuildMode):
 *   - "build" (default): `cargo build` — host-arch compile, catches type
 *     errors AND linker / codegen / monomorphization errors that pure
 *     `cargo check` would miss (e.g. duplicate `entrypoint!` macro
 *     collisions when SPL deps lack `no-entrypoint`). Fast enough for
 *     the workbench's "Verify Build" button (~5–15s on cached deps for
 *     a small program).
 *   - "build-sbf" (strict, opt-in via `?strict=1` on the route): runs
 *     `cargo build-sbf`, which produces an actual deployable Solana
 *     `.so`. This is the ONLY mode that proves the program will load
 *     into the validator. Slow (1–3 min cold; 5–20s warm), so we keep
 *     it behind an explicit flag.
 *
 * Layout: one persistent scratch dir per target at `<scratch>/anvil-build-<target>/`.
 * Cargo.toml is written once (or whenever it changes), and `target/` is
 * reused across calls so dependency builds are warm. Each call wipes
 * `src/` and writes the new files there before invoking cargo.
 *
 * Concurrency: a per-target promise chain serializes calls so two
 * simultaneous POSTs to the same target don't trample each other's `src/`.
 *
 * Sandbox: cargo invocations are wrapped via `./sandbox.ts`, which detects
 * the strongest available isolation tool at startup (firejail > bwrap >
 * unshare > none) and applies env-strip + prlimit unconditionally. Dep
 * downloads happen during a one-time `cargo fetch` warm-up before any user
 * src/ exists; sandboxed runs use `--offline` so the net-namespace cut is
 * non-fatal.
 */

import { spawn } from "node:child_process";
import { mkdir, rm, writeFile, readFile, stat } from "node:fs/promises";
import { dirname, join, isAbsolute, normalize } from "node:path";
import { spawnSandboxed, sandboxedEnv } from "./sandbox.js";

export type BuildTarget = "pinocchio" | "native";

/**
 * "check" = cargo check (fastest, ~3-5s, type-check only — used for the
 *           workbench's "Quick Check" button as the user types)
 * "build" = cargo build (default, ~10-15s, catches linker + codegen on top
 *           of type errors — backs the "Verify Build" button)
 * "build-sbf" = cargo build-sbf (strict, ~30s-2min, produces deployable
 *               Solana .so — backs the "Verify Deploy" button and
 *               anvil-sol --strict)
 */
export type BuildMode = "check" | "build" | "build-sbf";

export interface BuildFile {
  path: string;
  content: string;
}

export interface BuildDiagnostic {
  filePath: string;
  line: number;
  column: number;
  code: string | null;
  message: string;
  spanText: string;
}

export interface BuildResult {
  ok: boolean;
  durationMs: number;
  errors: BuildDiagnostic[];
  warnings: BuildDiagnostic[];
  stderrTail: string;
  /** Set when cargo could not be invoked, hit the timeout, or returned no JSON. */
  unsupported?: { reason: string };
  /**
   * Queue snapshot at the moment THIS build started its cargo run (after
   * waiting in the per-target queue, before cargo invoked). Lets clients
   * render "you waited Xs in queue, N still queued behind you" without
   * a separate /metrics roundtrip.
   */
  queue?: {
    /** Depth observed when the build started cargo (excludes this build). */
    depthAtStart: number;
    /** ms spent waiting in the queue before cargo started. */
    waitMs: number;
  };
}

// Same dependency lists as `tests/cargo-build.test.ts:11-37`. Duplicated on
// purpose — importing from `tests/` would invert the layering and the test
// file is intentionally simple. The package name is static; the user-supplied
// `programName` only affects the response context.
//
// SECURITY-CRITICAL: these TOML strings are the entire dependency surface
// the sandbox warmup `cargo fetch` resolves. Both that warmup AND the
// platform-tools first-run download for build-sbf happen OUTSIDE the
// sandbox (see ensureScratchProject + sandbox.ts threat model), so the
// dependency list MUST stay hard-coded here — never sourced from user
// input. If you add user-controlled deps (e.g. `?extra-deps=...` or
// uploading a custom Cargo.toml), the network-namespace cut is
// circumvented and a malicious crate can run code with the API
// process's credentials. See SECURITY.md.
// FUTURE: Emit-side blocker (b) — solana_program::hash::hashv on Pinocchio.
// jito-tip-distribution + merkle-proof-using programs reference
// `solana_program::hash::hashv`. Pinocchio 0.9 doesn't ship a high-level
// hashv API; raw SBF syscalls (sol_keccak256, sol_sha256) are exposed
// via pinocchio::syscalls but require manual wrapping. Fix has TWO
// implementation choices; both need iterative crate-compat probing
// to land safely:
//
//   Option 1: add `solana-hash` (or split `solana-sha256-hasher`) as a
//             Pinocchio scaffold dep, filter the use-import on
//             pinocchio (anchor-spl path), keep call sites bare.
//             Risk: dep version conflict with pinocchio's own deps.
//
//   Option 2: emit a hand-rolled `anvil_hashv` helper in the Pinocchio
//             scaffold that wraps pinocchio::syscalls::sol_sha256, then
//             post-process rewrite `solana_program::hash::hashv` →
//             `anvil_hashv` at every call site.
//             Risk: shape of call args (`&[&[u8]]` vs `&[&[u8; N]]`)
//             needs to match across all real call sites.
//
// Either lands cleanly only with a working toolchain to iterate on. Not
// shipped here — see project-byte-equal-pipeline-review-arc.md for the
// blocker hierarchy and which fixtures unlock when.
const PINOCCHIO_CARGO_TOML = `[package]
name = "anvil-build"
version = "0.1.0"
edition = "2021"
[lib]
crate-type = ["cdylib", "lib"]
[dependencies]
borsh = { version = "1.5", features = ["derive"] }
pinocchio = "0.9"
pinocchio-system = "0.4"
pinocchio-token = "0.4"
pinocchio-associated-token-account = "0.4"
# Zero-copy account types reference bytemuck::Pod/Zeroable directly.
# buildProjectScaffold auto-injects this when ir.accounts has any
# isZeroCopy entry; mirror that here so /build doesn't fail on
# zero_copy_load / Pod-impl emit. See project-scaffold.ts.
bytemuck = { version = "1", features = ["derive"] }
# Note: pyth_* crates intentionally NOT added — N5b unified the Pyth
# emit on hand-rolled bytes (no crate dep needed). The source's
# `get_feed_id_from_hex("0x…")?` is parsed at emit time into a byte
# array literal so the receiver-sdk isn't referenced at runtime either.
`;

// FUTURE: Emit-side blocker (c) — solana-vote-program scaffold dep.
// jito-tip-distribution references `VoteState::deserialize_node_pubkey`
// from `solana-vote-program` (re-exported as `solana_vote_program`).
// Native target could carry it cleanly (solana-program is already a
// dep, vote-program is a sibling crate), but version pinning needs
// validation against the host SBF toolchain. NOT added here — see
// project-byte-equal-pipeline-review-arc.md.
const NATIVE_CARGO_TOML = `[package]
name = "anvil-build"
version = "0.1.0"
edition = "2021"
[lib]
crate-type = ["cdylib", "lib"]
[dependencies]
borsh = { version = "1.5", features = ["derive"] }
solana-program = "2.2"
spl-token = { version = "7", features = ["no-entrypoint"] }
spl-token-2022 = { version = "6", features = ["no-entrypoint"] }
spl-associated-token-account = { version = "6", features = ["no-entrypoint"] }
# Common scaffold-injected crates that the Anvil project scaffold pulls
# in when the IR references them. Mirroring the
# extractUsedCrates / project-scaffold subset here so /build doesn't
# fail on legitimate emit:
#   - bytemuck: zero-copy Pod/Zeroable impls
#   - spl-memo: cpi_memo helper
#   - spl-token-metadata-interface: T22 TokenMetadata extension CPIs
#   - mpl-token-metadata: real-CPI MPL catalog (12 instructions)
bytemuck = { version = "1", features = ["derive"] }
spl-memo = { version = "6", features = ["no-entrypoint"] }
spl-token-metadata-interface = "0.4"
mpl-token-metadata = "5.1"
# Note: pyth_* crates intentionally NOT added — N5b unified the Pyth
# emit on hand-rolled bytes (see emitter-base.ts emitPythReadPrice*).
# Source `use pyth_*::*` lines are filtered out by
# filteredSourceImports. Adding the crates would re-introduce the
# borsh-derive proc-macro interop issue.
`;

function cargoTomlFor(target: BuildTarget): string {
  switch (target) {
    case "pinocchio":
      return PINOCCHIO_CARGO_TOML;
    case "native":
      return NATIVE_CARGO_TOML;
  }
}

// Default scratch root lives under $HOME (not /tmp) so the unshare sandbox
// can safely tmpfs-overlay /tmp without clobbering the cwd that cargo runs
// in. Operators can override via ANVIL_BUILD_SCRATCH_ROOT but should pick
// a path outside /tmp if relying on the unshare sandbox kind.
const SCRATCH_ROOT =
  process.env.ANVIL_BUILD_SCRATCH_ROOT ??
  join(process.env.HOME ?? "/var/tmp", ".anvil-build");

function scratchDirFor(target: BuildTarget): string {
  return join(SCRATCH_ROOT, `anvil-build-${target}`);
}

const DEFAULT_TIMEOUT_MS = (() => {
  const raw = process.env.ANVIL_BUILD_TIMEOUT_MS;
  const parsed = raw ? parseInt(raw, 10) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 90_000;
})();

// build-sbf is 5–10x slower than build because it (a) cross-compiles to
// the SBF target, (b) downloads & invokes platform-tools on first run, and
// (c) does full codegen + linking against bpf-tools. Give it 10 min by
// default; operators can override via ANVIL_BUILD_SBF_TIMEOUT_MS.
const SBF_TIMEOUT_MS = (() => {
  const raw = process.env.ANVIL_BUILD_SBF_TIMEOUT_MS;
  const parsed = raw ? parseInt(raw, 10) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 600_000;
})();

const STDERR_TAIL_BYTES = 4096;

/**
 * Reject paths that could escape `src/` (absolute, `..` traversal, etc.).
 * Cargo will accept relative paths under `src/`; we just have to make sure
 * the file system write itself stays bounded.
 */
function safeRelativePath(p: string): string {
  if (!p || typeof p !== "string") {
    throw new Error("file path must be a non-empty string");
  }
  if (isAbsolute(p)) {
    throw new Error(`file path must be relative: ${p}`);
  }
  // Normalize and check for parent traversal.
  const norm = normalize(p).replace(/\\/g, "/");
  if (norm.startsWith("../") || norm === ".." || norm.split("/").includes("..")) {
    throw new Error(`file path may not contain '..': ${p}`);
  }
  return norm;
}

/**
 * Per-target serial queue. Two simultaneous calls to `runBuild("pinocchio", ...)`
 * would otherwise race on `src/`; this chains them so the second waits for
 * the first to finish.
 *
 * Bounded depth: `MAX_QUEUE_DEPTH` in-flight per target. Over the cap we
 * fail fast with QUEUE_FULL — better than letting a request dangle for
 * minutes while N earlier ones serialize through. Default 16; override via
 * ANVIL_BUILD_MAX_QUEUE_DEPTH.
 *
 * Per-request wall-clock: `MAX_QUEUE_WAIT_MS` cap on time spent waiting in
 * the queue (not counting the cargo run itself; cargo has its own
 * DEFAULT_TIMEOUT_MS). Default 90s.
 */
const targetQueues: Map<BuildTarget, Promise<unknown>> = new Map();
const targetDepth: Map<BuildTarget, number> = new Map();

/**
 * Bounded ring buffer of recent build durations per (target, mode). Used
 * to compute an ETA for queued requests: queueDepth × meanDurationMs.
 *
 * Window size 20 is enough that a single cold-cache build can't permanently
 * skew the median. (target, mode) keying is important — `cargo check` is
 * ~3s while `cargo build-sbf` is 30s-2min. Mixing them in the same window
 * would give wildly wrong ETAs for both.
 */
const RECENT_DURATIONS_WINDOW = 20;
const recentDurations: Map<string, number[]> = new Map();
function durationKey(target: BuildTarget, mode: BuildMode): string {
  return `${target}:${mode}`;
}
function recordDuration(target: BuildTarget, mode: BuildMode, ms: number): void {
  const key = durationKey(target, mode);
  const arr = recentDurations.get(key) ?? [];
  arr.push(ms);
  if (arr.length > RECENT_DURATIONS_WINDOW) arr.shift();
  recentDurations.set(key, arr);
}
function meanDuration(target: BuildTarget, mode: BuildMode): number {
  const arr = recentDurations.get(durationKey(target, mode));
  if (!arr || arr.length === 0) return 0;
  return Math.round(arr.reduce((a, b) => a + b, 0) / arr.length);
}

/**
 * Queue snapshot for /build queue-status responses. Returns current depth
 * + recent-mean duration so a client about to enqueue can render an ETA
 * before paying the wait. Per-(target, mode) granularity matches the
 * way work actually serializes — `cargo check` and `cargo build-sbf`
 * have very different durations and shouldn't share an ETA.
 */
export interface QueueStats {
  depthByTarget: Record<BuildTarget, number>;
  capacity: number;
  /** target:mode → recent mean duration ms. 0 if no samples yet. */
  meanDurationMsByMode: Record<string, number>;
  /**
   * ETA per (target, mode) for a hypothetical NEW request joining the
   * queue right now: depth × mean. 0 when no samples or empty queue.
   */
  etaSecByMode: Record<string, number>;
}

export function queueStats(): QueueStats {
  const depthByTarget: Record<BuildTarget, number> = {
    pinocchio: targetDepth.get("pinocchio") ?? 0,
    native: targetDepth.get("native") ?? 0,
  };
  const meanDurationMsByMode: Record<string, number> = {};
  const etaSecByMode: Record<string, number> = {};
  for (const target of ["pinocchio", "native"] as const) {
    for (const mode of ["check", "build", "build-sbf"] as const) {
      const key = `${target}:${mode}`;
      const mean = meanDuration(target, mode);
      meanDurationMsByMode[key] = mean;
      etaSecByMode[key] = mean > 0 ? Math.round((depthByTarget[target] * mean) / 1000) : 0;
    }
  }
  return {
    depthByTarget,
    capacity: MAX_QUEUE_DEPTH,
    meanDurationMsByMode,
    etaSecByMode,
  };
}

const MAX_QUEUE_DEPTH = (() => {
  const raw = process.env.ANVIL_BUILD_MAX_QUEUE_DEPTH;
  const parsed = raw ? parseInt(raw, 10) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 16;
})();

const MAX_QUEUE_WAIT_MS = (() => {
  const raw = process.env.ANVIL_BUILD_MAX_QUEUE_WAIT_MS;
  const parsed = raw ? parseInt(raw, 10) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 90_000;
})();

/**
 * Per-IP cap on concurrent build-sbf runs. Without this, a single user
 * submitting 5 SBF builds (each ~30s-2min) consumes the entire global
 * queue depth and starves every other user on the same target for 10
 * minutes. Default 2 per IP — one in-flight + one queued. Override via
 * ANVIL_BUILD_SBF_PER_IP_CAP. Cap applies only to build-sbf; build/check
 * are fast enough that the global queue depth is sufficient.
 */
const SBF_PER_IP_CAP = (() => {
  const raw = process.env.ANVIL_BUILD_SBF_PER_IP_CAP;
  const parsed = raw ? parseInt(raw, 10) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 2;
})();
const sbfPerIpInflight: Map<string, number> = new Map();

export class QueueFullError extends Error {
  constructor(target: BuildTarget, depth: number, cap: number) {
    super(`build queue full for target=${target}: ${depth}/${cap} in flight, refusing`);
    this.name = "QueueFullError";
  }
}

export class QueueWaitTimeoutError extends Error {
  constructor(target: BuildTarget, waitMs: number) {
    super(`build queue wait exceeded ${waitMs}ms for target=${target}`);
    this.name = "QueueWaitTimeoutError";
  }
}

export class PerIpQueueFullError extends Error {
  constructor(public readonly ip: string, public readonly cap: number) {
    super(`per-IP build-sbf cap reached: ${cap} concurrent, refusing`);
    this.name = "PerIpQueueFullError";
  }
}

function enqueue<T>(
  target: BuildTarget,
  fn: () => Promise<T>,
  opts: { mode?: BuildMode; callerIp?: string } = {},
): Promise<T> {
  const depth = targetDepth.get(target) ?? 0;
  if (depth >= MAX_QUEUE_DEPTH) {
    return Promise.reject(new QueueFullError(target, depth, MAX_QUEUE_DEPTH));
  }

  // Per-IP cap — applies only to build-sbf where each run is 30s-2min.
  // Without this a single IP pipelining 5 SBF builds blocks every other
  // user on the same target for 10 minutes.
  const ip = opts.callerIp;
  const isSbf = opts.mode === "build-sbf";
  if (isSbf && ip) {
    const inflight = sbfPerIpInflight.get(ip) ?? 0;
    if (inflight >= SBF_PER_IP_CAP) {
      return Promise.reject(new PerIpQueueFullError(ip, SBF_PER_IP_CAP));
    }
    sbfPerIpInflight.set(ip, inflight + 1);
  }

  targetDepth.set(target, depth + 1);

  const prev = targetQueues.get(target) ?? Promise.resolve();

  // Wrap the actual fn() in a wait-cap so a long backlog can't strand a
  // caller forever. The cargo run itself isn't bounded by this — it has
  // its own DEFAULT_TIMEOUT_MS — but the time spent WAITING in the queue is.
  const startedAt = Date.now();
  const guarded = async (): Promise<T> => {
    const waited = Date.now() - startedAt;
    if (waited >= MAX_QUEUE_WAIT_MS) {
      throw new QueueWaitTimeoutError(target, waited);
    }
    return fn();
  };

  const next = prev.then(guarded, guarded);

  // Don't let a rejection break the chain for the next caller; also drop
  // the depth counter regardless of outcome.
  const tail = next.finally(() => {
    targetDepth.set(target, Math.max(0, (targetDepth.get(target) ?? 1) - 1));
    if (isSbf && ip) {
      const v = (sbfPerIpInflight.get(ip) ?? 1) - 1;
      if (v <= 0) sbfPerIpInflight.delete(ip);
      else sbfPerIpInflight.set(ip, v);
    }
  });
  targetQueues.set(
    target,
    tail.catch(() => undefined),
  );
  return next;
}

/**
 * Cargo JSON message shape we care about.
 * https://doc.rust-lang.org/cargo/reference/external-tools.html#json-messages
 */
interface CompilerSpan {
  file_name: string;
  line_start: number;
  line_end: number;
  column_start: number;
  column_end: number;
  is_primary: boolean;
  text?: Array<{ text: string; highlight_start: number; highlight_end: number }>;
}

interface CompilerMessage {
  reason: string;
  message?: {
    level: string;
    message: string;
    code?: { code: string; explanation?: string } | null;
    spans?: CompilerSpan[];
  };
}

function spanText(span: CompilerSpan): string {
  if (!span.text || span.text.length === 0) return "";
  const first = span.text[0];
  if (!first) return "";
  const start = Math.max(0, first.highlight_start - 1);
  const end = Math.max(start, first.highlight_end - 1);
  return first.text.slice(start, end);
}

function diagnosticFromMessage(msg: NonNullable<CompilerMessage["message"]>): BuildDiagnostic | null {
  const spans = msg.spans ?? [];
  const primary = spans.find((s) => s.is_primary) ?? spans[0];
  if (!primary) {
    // No span — emit a file-less diagnostic so we don't drop the message
    // entirely. The route still returns it under errors[]/warnings[].
    return {
      filePath: "",
      line: 0,
      column: 0,
      code: msg.code?.code ?? null,
      message: msg.message,
      spanText: "",
    };
  }
  return {
    filePath: primary.file_name,
    line: primary.line_start,
    column: primary.column_start,
    code: msg.code?.code ?? null,
    message: msg.message,
    spanText: spanText(primary),
  };
}

function parseCargoStdout(stdout: string): { errors: BuildDiagnostic[]; warnings: BuildDiagnostic[] } {
  const errors: BuildDiagnostic[] = [];
  const warnings: BuildDiagnostic[] = [];
  for (const rawLine of stdout.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    let parsed: CompilerMessage;
    try {
      parsed = JSON.parse(line) as CompilerMessage;
    } catch {
      continue;
    }
    if (parsed.reason !== "compiler-message" || !parsed.message) continue;
    const level = parsed.message.level;
    if (level === "error" || level === "error: internal compiler error") {
      const diag = diagnosticFromMessage(parsed.message);
      if (diag) errors.push(diag);
    } else if (level === "warning") {
      const diag = diagnosticFromMessage(parsed.message);
      if (diag) warnings.push(diag);
    }
  }
  return { errors, warnings };
}

async function ensureScratchProject(target: BuildTarget, scratchDir: string): Promise<void> {
  const cargoTomlPath = join(scratchDir, "Cargo.toml");
  const desired = cargoTomlFor(target);
  let cargoTomlChanged = true;
  try {
    const existing = await readFile(cargoTomlPath, "utf-8");
    if (existing === desired) cargoTomlChanged = false;
  } catch {
    // missing — fall through to write
  }
  if (cargoTomlChanged) {
    await mkdir(scratchDir, { recursive: true });
    await writeFile(cargoTomlPath, desired, "utf-8");
    // Drop a placeholder lib.rs so `cargo fetch` has a crate root to resolve
    // against. The real user files overwrite this in writeSrcFiles().
    const srcDir = join(scratchDir, "src");
    await mkdir(srcDir, { recursive: true });
    await writeFile(join(srcDir, "lib.rs"), "// anvil scratch placeholder\n", "utf-8");
    // One-time dep fetch outside the sandbox. Cargo.toml is trusted (we
    // wrote it), no user files exist yet, so this is safe to run with
    // network. After this, sandboxed cargo --offline reuses the cached
    // registry + target dir.
    await warmDependencies(scratchDir);
  }
}

function warmDependencies(scratchDir: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("cargo", ["fetch", "--quiet"], {
      cwd: scratchDir,
      env: { ...sandboxedEnv(), CARGO_NET_OFFLINE: "false" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr?.on("data", (c: Buffer) => { stderr += c.toString("utf-8"); });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`cargo fetch failed (exit ${code}): ${stderr.slice(-500)}`));
    });
  });
}

async function writeSrcFiles(scratchDir: string, files: BuildFile[]): Promise<void> {
  const srcDir = join(scratchDir, "src");
  // Wipe and recreate src/ so a renamed file doesn't linger across calls.
  await rm(srcDir, { recursive: true, force: true });
  await mkdir(srcDir, { recursive: true });
  for (const f of files) {
    const rel = safeRelativePath(f.path);
    const outPath = join(srcDir, rel);
    await mkdir(dirname(outPath), { recursive: true });
    await writeFile(outPath, f.content, "utf-8");
  }
}

interface CargoRunResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/**
 * Per-line callback fired as cargo emits each `--message-format=json` line.
 * Used by the streaming /build endpoint to push live progress to clients
 * via SSE. Synchronous on purpose — we don't want backpressure to slow
 * down the cargo wrapping; the SSE client buffers naturally.
 */
export type CargoStreamCallback = (line: string) => void;

/**
 * Cancel handle for an in-flight cargo run. Calling `cancel()` sends
 * SIGTERM to the cargo process group; `cancelled` resolves once the
 * subprocess actually exits. Used by the streaming /build endpoint to
 * abort cargo when the SSE client disconnects mid-build.
 */
export interface CargoCancelHandle {
  cancel: () => void;
  cancelled: Promise<void>;
}

function runCargo(
  scratchDir: string,
  mode: BuildMode,
  timeoutMs: number,
  options: { onLine?: CargoStreamCallback; cancelHandle?: { current: CargoCancelHandle | null } } = {},
): Promise<CargoRunResult> {
  return new Promise((resolve) => {
    // Run cargo inside the configured sandbox. `--offline` is mandatory
    // because the sandbox cuts the network namespace; deps were already
    // fetched in ensureScratchProject's warm-up.
    //
    // Note on build-sbf: it's a cargo subcommand that wraps `cargo build`
    // with the sbf-solana-solana target. Unlike `cargo build` / `cargo check`,
    // its argv parser does NOT accept `--message-format` directly — flags
    // meant for the inner cargo invocation must come AFTER a `--`
    // separator. Without the separator the wrapper aborts with
    //   error: Found argument '--message-format' which wasn't expected
    // exit code 2, before the inner cargo is even spawned. That's the
    // failure that surfaces to the workbench as "1 generic error" with
    // no file/line — actual stderr lives in stderrTail.
    //
    // First-run on a fresh scratch dir also needs the SBF platform-tools,
    // which build-sbf downloads automatically — that download happens
    // OUTSIDE the sandbox during the ensureScratchProject warm-up if SBF
    // mode is requested.
    const cargoArgs: string[] =
      mode === "build-sbf"
        ? ["build-sbf", "--", "--message-format=json", "--quiet", "--offline"]
        : [
            mode === "check" ? "check" : "build",
            "--message-format=json",
            "--quiet",
            "--offline",
          ];
    const child = spawnSandboxed("cargo", cargoArgs, { cwd: scratchDir });

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let cancelled = false;
    let stdoutBuffer = "";

    const timer = setTimeout(() => {
      timedOut = true;
      // SIGKILL — cargo can leave child rustc invocations behind on SIGTERM
      // under load. The scratch target/ recovers fine on the next call.
      child.kill("SIGKILL");
    }, timeoutMs);

    // Wire the cancel handle so the streaming endpoint can abort on
    // client disconnect. SIGTERM first (graceful), SIGKILL after 2s.
    if (options.cancelHandle) {
      let exitResolve: () => void = () => {};
      const cancelled$ = new Promise<void>((r) => {
        exitResolve = r;
      });
      child.on("close", () => exitResolve());
      options.cancelHandle.current = {
        cancel: () => {
          if (cancelled || child.killed) return;
          cancelled = true;
          child.kill("SIGTERM");
          setTimeout(() => {
            if (!child.killed) child.kill("SIGKILL");
          }, 2_000);
        },
        cancelled: cancelled$,
      };
    }

    child.stdout?.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf-8");
      stdout += text;
      // Line-stream cargo's --message-format=json output to the SSE
      // callback. Cargo emits one JSON object per line; we buffer
      // partials across chunks.
      if (options.onLine) {
        stdoutBuffer += text;
        let nl = stdoutBuffer.indexOf("\n");
        while (nl !== -1) {
          const line = stdoutBuffer.slice(0, nl);
          stdoutBuffer = stdoutBuffer.slice(nl + 1);
          if (line.length > 0) {
            try {
              options.onLine(line);
            } catch {
              // never let a callback error nuke the cargo wrapper
            }
          }
          nl = stdoutBuffer.indexOf("\n");
        }
      }
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf-8");
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      stderr += `\n[spawn error] ${err.message}\n`;
      resolve({ exitCode: null, stdout, stderr, timedOut });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      // Flush any trailing line-buffer content (no terminating \n).
      if (options.onLine && stdoutBuffer.length > 0) {
        try {
          options.onLine(stdoutBuffer);
        } catch {
          // swallow
        }
      }
      resolve({ exitCode: cancelled ? -1 : code, stdout, stderr, timedOut });
    });
  });
}

// Cache the cargo-availability probe — `which cargo` is a syscall, no point
// re-running it on every request. Re-evaluated on process restart.
let cargoAvailableCache: boolean | null = null;
function cargoAvailable(): boolean {
  if (cargoAvailableCache !== null) return cargoAvailableCache;
  try {
    // execSync is fine — startup-time only.
    const { execSync } = require("node:child_process") as typeof import("node:child_process");
    execSync("command -v cargo", { stdio: "ignore" });
    cargoAvailableCache = true;
  } catch {
    cargoAvailableCache = false;
  }
  return cargoAvailableCache;
}

// Same probe for cargo-build-sbf — cargo discovers it via PATH (any
// `cargo-foo` binary on PATH is exposed as `cargo foo`). Without this
// pre-flight, requesting mode=build-sbf on a host that only has plain
// cargo gets the cryptic cargo error 'no such command: build-sbf' and
// the workbench shows it as a build infrastructure error with no
// actionable next step.
let cargoBuildSbfAvailableCache: boolean | null = null;
function cargoBuildSbfAvailable(): boolean {
  if (cargoBuildSbfAvailableCache !== null) return cargoBuildSbfAvailableCache;
  try {
    const { execSync } = require("node:child_process") as typeof import("node:child_process");
    execSync("command -v cargo-build-sbf", { stdio: "ignore" });
    cargoBuildSbfAvailableCache = true;
  } catch {
    cargoBuildSbfAvailableCache = false;
  }
  return cargoBuildSbfAvailableCache;
}

function tailString(s: string, bytes: number): string {
  if (s.length <= bytes) return s;
  // Slice on bytes by encoding to a buffer first — avoids splitting a
  // multi-byte UTF-8 sequence in the middle.
  const buf = Buffer.from(s, "utf-8");
  if (buf.length <= bytes) return s;
  return buf.subarray(buf.length - bytes).toString("utf-8");
}

/**
 * Run a build of the given files for the target.
 *
 * Returns structured diagnostics. Never throws for compile errors — those
 * land in `errors[]` with `ok: false`. Throws only for invalid input
 * (path traversal, unwritable scratch dir, etc.) and for unsupported
 * targets where the caller should surface a friendly error message.
 */
/**
 * Streaming variant of {@link runBuild}. Same input/output as the regular
 * `runBuild`, but additionally invokes `options.onLine` for every cargo
 * `--message-format=json` line as it's emitted, and writes a
 * {@link CargoCancelHandle} into `options.cancelHandle.current` so callers
 * can abort the in-flight cargo on client disconnect.
 *
 * Use from the streaming /build SSE endpoint. The non-streaming /build
 * endpoint should keep using {@link runBuild} for simplicity.
 */
export async function runBuildStreaming(
  target: BuildTarget,
  files: BuildFile[],
  programName: string,
  mode: BuildMode,
  options: {
    onLine?: CargoStreamCallback;
    cancelHandle?: { current: CargoCancelHandle | null };
    callerIp?: string;
  },
): Promise<BuildResult> {
  return runBuildInternal(target, files, programName, mode, options);
}

export async function runBuild(
  target: BuildTarget,
  files: BuildFile[],
  programName: string,
  mode: BuildMode = "build",
  opts: { callerIp?: string } = {},
): Promise<BuildResult> {
  return runBuildInternal(target, files, programName, mode, opts);
}

async function runBuildInternal(
  target: BuildTarget,
  files: BuildFile[],
  programName: string,
  mode: BuildMode,
  options: {
    onLine?: CargoStreamCallback;
    cancelHandle?: { current: CargoCancelHandle | null };
    callerIp?: string;
  },
): Promise<BuildResult> {
  // Reserved for future log-prefix tagging (today's stderrTail is already
  // labeled by the cargo subcommand). Touching the param here both shuts
  // up the unused-param lint AND documents that programName is intentional
  // call-site context, not just dead weight.
  void programName;
  if (!Array.isArray(files) || files.length === 0) {
    throw new Error("at least one file is required");
  }

  // Detect missing cargo BEFORE doing any scratch-dir work — gives the
  // caller a clean `unsupported` so they don't waste IR/refine round-trips
  // on a deployment where /build can't function. The 2026-04-27 prod audit
  // caught this: build.success=0/4 on prod metrics because cargo wasn't
  // installed in the DigitalOcean container.
  if (!cargoAvailable()) {
    return {
      ok: false,
      durationMs: 0,
      errors: [
        {
          filePath: "",
          line: 0,
          column: 0,
          code: null,
          message:
            "cargo is not installed on this deployment. The /build endpoint requires the Rust toolchain — install via `apt install cargo` or rustup, then redeploy.",
          spanText: "",
        },
      ],
      warnings: [],
      stderrTail: "",
      unsupported: { reason: "cargo not installed" },
    };
  }

  // Same pre-flight for build-sbf — cargo on its own can't run the SBF
  // cross-compile path; you need cargo-build-sbf from Anza CLI on PATH.
  // Without this check, mode=build-sbf on a plain-cargo host returns
  // cargo's own "no such command: build-sbf" message which renders as
  // an opaque build-infrastructure error with no install hint.
  if (mode === "build-sbf" && !cargoBuildSbfAvailable()) {
    return {
      ok: false,
      durationMs: 0,
      errors: [
        {
          filePath: "",
          line: 0,
          column: 0,
          code: null,
          message:
            "cargo-build-sbf is not installed on this deployment. The Deploy build mode produces a Solana .so via the Anza CLI. " +
            "Install with:\n" +
            "  sh -c \"$(curl -sSfL https://release.anza.xyz/v3.1.13/install)\"\n" +
            "Then ensure ~/.local/share/solana/install/active_release/bin is on PATH and redeploy. " +
            "Or use Build mode (cargo build) which catches type + linker + codegen errors against the host arch.",
          spanText: "",
        },
      ],
      warnings: [],
      stderrTail: "",
      unsupported: { reason: "cargo-build-sbf not installed" },
    };
  }

  const scratchDir = scratchDirFor(target);
  // Capture queue stats from the moment runBuild was called. enqueue()
  // chains on the previous promise; the time gap between enqueueAt and
  // started inside the fn measures actual wait time.
  const enqueuedAt = Date.now();
  const depthAtEnqueue = targetDepth.get(target) ?? 0;

  return enqueue(target, async () => {
    const started = Date.now();
    const waitMs = started - enqueuedAt;
    await ensureScratchProject(target, scratchDir);
    await writeSrcFiles(scratchDir, files);

    // Sanity check: src/lib.rs should exist for cargo to find anything to
    // compile. If the caller forgot to include it, fail fast with a clear
    // message rather than a confusing rustc error.
    try {
      await stat(join(scratchDir, "src", "lib.rs"));
    } catch {
      const durationMs = Date.now() - started;
      return {
        ok: false,
        durationMs,
        errors: [
          {
            filePath: "",
            line: 0,
            column: 0,
            code: null,
            message:
              "No src/lib.rs found in submitted files. Cargo needs a crate root — include a `lib.rs` entry.",
            spanText: "",
          },
        ],
        warnings: [],
        stderrTail: "",
      };
    }

    const timeoutMs = mode === "build-sbf" ? SBF_TIMEOUT_MS : DEFAULT_TIMEOUT_MS;
    const run = await runCargo(scratchDir, mode, timeoutMs, options);
    const durationMs = Date.now() - started;

    const { errors, warnings } = parseCargoStdout(run.stdout);
    const stderrTail = tailString(run.stderr, STDERR_TAIL_BYTES);

    const cmdLabel =
      mode === "build-sbf"
        ? "cargo build-sbf"
        : mode === "check"
          ? "cargo check"
          : "cargo build";

    if (run.timedOut) {
      errors.push({
        filePath: "",
        line: 0,
        column: 0,
        code: null,
        message: `${cmdLabel} exceeded ${timeoutMs}ms timeout`,
        spanText: "",
      });
    }

    // Exit code 101 from cargo means "build failed" — diagnostics on
    // stdout already cover this. A non-101 non-zero exit with no parsed
    // errors usually means the cargo invocation itself failed (missing
    // toolchain, bad Cargo.toml, bad argv). Surface that as a synthetic
    // error so the response is never empty — and include the stderr tail
    // inline since that's where the actual cause lives. Without this the
    // workbench user just sees a generic "exit code 2" and has nowhere
    // to look (stderrTail is a separate field that no frontend renders).
    if (run.exitCode !== 0 && errors.length === 0 && !run.timedOut) {
      const inlineStderr = stderrTail.trim().slice(0, 2000);
      errors.push({
        filePath: "",
        line: 0,
        column: 0,
        code: null,
        message: inlineStderr.length > 0
          ? `${cmdLabel} failed (exit code ${run.exitCode}):\n${inlineStderr}`
          : `${cmdLabel} failed (exit code ${run.exitCode}) with no stderr output.`,
        spanText: "",
      });
    }

    // Record duration for the ETA estimator (target,mode-keyed window).
    // Only count green/red builds, not infra-error early-returns above.
    recordDuration(target, mode, durationMs);

    return {
      ok: errors.length === 0,
      durationMs,
      errors,
      warnings,
      stderrTail,
      queue: { depthAtStart: Math.max(0, depthAtEnqueue - 1), waitMs },
    };
  }, { mode, callerIp: options.callerIp });
}

// Exposed for tests / debugging.
export const __internal = {
  parseCargoStdout,
  scratchDirFor,
  cargoTomlFor,
};

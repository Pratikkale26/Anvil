/**
 * cargo-gate — orchestrator-side accept gate (#22).
 *
 * The validator (api/src/emitter/output-validator.ts) is a fast heuristic
 * pass: ~100ms, no toolchain dependency, deterministic. Coverage gap:
 * shapes rustc rejects but the heuristic doesn't recognize. The
 * 2026-05-12 real-world sweep surfaced 2/2 "validator-clean / cargo-FAIL"
 * cases (anchor-cpi-test Result<T> alias, composite Accounts struct).
 *
 * Per advisor's path-c: promote cargo to the accept gate. Validator
 * stays as fast-fail-on-known-shapes; cargo becomes ground truth.
 *
 * This module is the small, dependency-free wrapper that:
 *   1. Spawns `cargo check` in a scratch dir already populated with the
 *      emitted source + scaffold (Cargo.toml, .cargo/config.toml, etc.).
 *   2. Parses the JSON message stream for compiler errors.
 *   3. Returns a structured verdict so orchestrators (CLI, /emit?gate=
 *      cargo) can decide whether to declare the emit shippable.
 *
 * NOT used by the existing /build endpoint, which has its own queue +
 * sandbox layer (api/src/build/build-runner.ts). The orchestrators that
 * need this are CLI write paths and the planned /emit?gate=cargo
 * option; both already write to a local scratch dir on the same host.
 *
 * Sandboxing note: this module runs BARE cargo — no FS isolation, no network
 * namespace. It is for the CLI write path, where the user is on their own
 * machine in their own trust context. As defense-in-depth it strips known
 * secret env vars (ANTHROPIC_API_KEY etc.) before handing the env to cargo,
 * since a user may run `anvil compile` on a third-party program whose emitted
 * build.rs is hostile — but env-strip is NOT a sandbox. Any caller that runs
 * cargo on UNTRUSTED input over the network (a public route accepting
 * arbitrary source) MUST route through spawnSandboxed (api/src/build/
 * sandbox.ts) — as /build and /emit?gate=cargo do — and MUST NOT call
 * runCargoCheckGate directly.
 */
import { spawn, spawnSync } from "node:child_process";

export interface CargoGateResult {
  ok: boolean;
  /** All `error[EXXXX]: ...` lines parsed out of stderr. */
  errors: string[];
  /** All `warning[...]` / `warning:` lines for visibility. */
  warnings: string[];
  /** Raw stderr tail (last 4 KB) for debugging when the parse misses something. */
  stderr: string;
  /** Wall-clock duration in milliseconds. */
  durationMs: number;
}

export interface CargoGateOptions {
  /** Override the cargo binary (defaults to "cargo" on PATH). */
  cargoBin?: string;
  /** Hard timeout in milliseconds. Defaults to 180_000 (3 min). */
  timeoutMs?: number;
  /** Additional env vars layered on top of the inherited env. */
  env?: NodeJS.ProcessEnv;
}

/**
 * Run `cargo check` in `scratchDir` and classify the result.
 *
 * The scratch dir MUST already contain a Cargo.toml + src/ tree as
 * produced by buildProjectScaffold + emit.files. Caller is responsible
 * for dir lifecycle (create + clean up).
 */
export async function runCargoCheckGate(
  scratchDir: string,
  opts: CargoGateOptions = {},
): Promise<CargoGateResult> {
  const cargoBin = opts.cargoBin ?? "cargo";
  const timeoutMs = opts.timeoutMs ?? 180_000;
  const t0 = Date.now();

  // Strip the secret-shaped env vars this process holds so a hostile build.rs
  // in transpiled third-party output can't read them. Not a sandbox (see
  // header) — just defense-in-depth on the bare-cargo path. CARGO_NET_OFFLINE
  // is deliberately NOT forced here: the CLI runs on the user's machine and
  // must be able to fetch deps, unlike the /build sandbox's offline scratch.
  const baseEnv: NodeJS.ProcessEnv = { ...process.env };
  for (const k of ["ANTHROPIC_API_KEY", "ANVIL_METRICS_TOKEN", "SENTRY_DSN", "REDIS_URL"]) {
    delete baseEnv[k];
  }

  return await new Promise<CargoGateResult>((resolve) => {
    const child = spawn(cargoBin, ["check", "--message-format=short"], {
      cwd: scratchDir,
      env: { CARGO_TERM_COLOR: "never", ...baseEnv, ...opts.env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));

    const timer = setTimeout(() => {
      try {
        child.kill("SIGTERM");
      } catch {
        /* already exited */
      }
    }, timeoutMs);

    child.on("close", (code) => {
      clearTimeout(timer);
      const lines = stderr.split("\n");
      // `--message-format=short` lines look like:
      //   src/lib.rs:42:5: error[E0282]: type annotations needed: ...
      //   src/lib.rs:10:1: warning: unused import: ...
      // Extract them at this granularity (path:L:C: <severity>...).
      const errors: string[] = [];
      const warnings: string[] = [];
      for (const line of lines) {
        const m = line.match(/^([^\s:]+:\d+:\d+:\s+(error|warning))(\[E\d+\])?:\s*(.+)$/);
        if (!m) continue;
        const isErr = m[2] === "error";
        const formatted = `${m[1]}${m[3] ?? ""}: ${m[4]}`;
        if (isErr) errors.push(formatted);
        else warnings.push(formatted);
      }
      // Fallback for compile errors that don't carry a path prefix
      // (e.g. "error: linking with `cc` failed"). Capture them as raw
      // lines so the verdict isn't silently OK on a non-zero exit.
      if (code !== 0 && errors.length === 0) {
        for (const line of lines) {
          if (/^error(\[E\d+\])?:/.test(line.trim())) {
            errors.push(line.trim());
          }
        }
        if (errors.length === 0) {
          errors.push(`cargo exited with code ${code} but no error[EXXXX] line found in stderr`);
        }
      }
      resolve({
        ok: code === 0,
        errors,
        warnings,
        stderr: stderr.slice(-4096),
        durationMs: Date.now() - t0,
      });
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({
        ok: false,
        errors: [`failed to spawn cargo: ${err.message}`],
        warnings: [],
        stderr: stderr.slice(-4096),
        durationMs: Date.now() - t0,
      });
    });
  });
}

/**
 * Sync probe used at orchestrator startup to decide whether the cargo
 * gate is available on this host. Cheap (just `cargo --version`).
 */
export function cargoAvailable(cargoBin = "cargo"): boolean {
  const r = spawnSync(cargoBin, ["--version"], { encoding: "utf-8" });
  return r.status === 0;
}

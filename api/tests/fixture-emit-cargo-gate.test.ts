/**
 * Regression for #22 — /emit?gate=cargo API path.
 *
 * The CLI path (--cargo-check default-on) was covered by
 * cli/cli-cargo-gate.test.ts. The API path is the other half of B2:
 * /emit returns the same cargo verdict when ?gate=cargo is passed, so
 * the workbench (which calls /emit, not the CLI) inherits the same
 * "validator-clean but cargo-FAIL" defense.
 *
 * Exercises the route handler directly (no Express boot) to skip the
 * sandbox/queue layers for the failure case, then exercises the happy
 * path on counter.
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { parseAnchor } from "../src/parser/anchor-parser.js";

const CARGO_AVAILABLE = (() => {
  const r = spawnSync("cargo", ["--version"], { encoding: "utf-8" });
  return r.status === 0;
})();

const PORT = 8786;
const BASE = `http://127.0.0.1:${PORT}`;

let serverProc: { kill: () => void } | null = null;

async function startServer(): Promise<void> {
  // Boot the API in a child process so we test it via real HTTP.
  // The route's `runBuild` path uses the existing sandbox detection;
  // a server-out-of-test ensures we exercise the full stack.
  const { spawn } = await import("node:child_process");
  const proc = spawn("bun", ["src/index.ts"], {
    cwd: "/home/pk/Anvil/api",
    env: {
      ...process.env,
      PORT: String(PORT),
      NODE_ENV: "test",
      // Skip Sentry / Redis paths.
      SENTRY_DSN: "",
      REDIS_URL: "",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  serverProc = proc;
  // Wait for the listening message. Generous budget: this server boots while
  // the rest of the suite (~158 files) competes for CPU/IO, so a tight 5s
  // budget flaked under load. Capture stderr + an early-exit so a real boot
  // failure surfaces immediately with diagnostics instead of a blind timeout.
  await new Promise<void>((resolve, reject) => {
    let buf = "";
    let errBuf = "";
    const timer = setTimeout(
      () => reject(new Error(`server did not start within 60s. stderr tail:\n${errBuf.slice(-2000)}`)),
      60_000,
    );
    const onData = (d: Buffer) => {
      buf += d.toString();
      if (/Anvil API running/.test(buf)) {
        clearTimeout(timer);
        proc.stdout!.removeListener("data", onData);
        resolve();
      }
    };
    proc.stdout!.on("data", onData);
    proc.stderr!.on("data", (d: Buffer) => { errBuf += d.toString(); });
    proc.on("error", (e) => { clearTimeout(timer); reject(e); });
    proc.on("exit", (code) => {
      if (code !== null && code !== 0) {
        clearTimeout(timer);
        reject(new Error(`server exited (code ${code}) before becoming ready. stderr tail:\n${errBuf.slice(-2000)}`));
      }
    });
  });
}

function stopServer(): void {
  if (serverProc) {
    try { serverProc.kill(); } catch { /* ignore */ }
    serverProc = null;
  }
}

async function emitWithGate(source: string, target = "pinocchio"): Promise<{
  status: number;
  body: Record<string, unknown>;
}> {
  const p = await parseAnchor(source);
  if (!p.ok) throw new Error(`parse failed: ${p.error}`);
  const res = await fetch(`${BASE}/emit?gate=cargo`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ir: p.ir, target, multiFile: true }),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

const GOOD_SOURCE = `
use anchor_lang::prelude::*;
declare_id!("Fg6PaFpoGXkYsidMpWTK6W2BeZ7FEfcYkg476zPFsLnS");
#[program]
pub mod good {
    use super::*;
    pub fn initialize(_ctx: Context<NoAccs>) -> Result<()> {
        msg!("hello");
        Ok(())
    }
}
#[derive(Accounts)]
pub struct NoAccs<'info> {
    pub signer: Signer<'info>,
}
`;

// H1 — pre-2026-05-19 this was a composite-Accounts source that cargo
// rejected (Anvil emitted `ctx.accounts.foo.dummy_a` against a single
// AccountInfo binding → E0609). Post-H1 composite flatten makes that
// source build cleanly, so the test now uses an unambiguously broken
// shape: a handler body that pass_through-carries a reference to an
// undefined identifier. The emitter preserves the source verbatim and
// cargo refuses with E0425 "cannot find value `nonexistent_function`".
const BROKEN_SOURCE = `
use anchor_lang::prelude::*;
declare_id!("EHthziFziNoac9LBGxEaVN47Y3uUiRoXvqAiR6oes4iU");
#[program]
mod broken_passthrough {
    use super::*;
    pub fn do_stuff(_ctx: Context<Plain>) -> Result<()> {
        let _ = nonexistent_function_that_cargo_must_refuse();
        Ok(())
    }
}
#[derive(Accounts)]
pub struct Plain<'info> {
    pub signer: Signer<'info>,
}
`;

describe("/emit?gate=cargo (#22 / B2 backend)", () => {
  if (!CARGO_AVAILABLE) {
    test.skip("cargo not on PATH — skipping API cargo-gate tests", () => {});
    return;
  }

  // Boot the API once for the whole file, lazily, INSIDE the first test that
  // needs it — NOT in beforeAll. Two flakes drove this:
  //   1. Per-test respawn on the same fixed port raced on port release between
  //      the two tests ("server did not start within 5s"). One memoized
  //      lifecycle removes the race and pays startup once.
  //   2. bun's beforeAll has a fixed ~5s hook timeout and does NOT accept a
  //      timeout arg, so a cold boot under full-suite CPU load (~160 files)
  //      died at 5s in the hook. Booting inside the test body runs the boot
  //      under the test's own 240s budget instead.
  let serverPromise: Promise<void> | null = null;
  const ensureServer = (): Promise<void> => {
    if (!serverPromise) serverPromise = startServer();
    return serverPromise;
  };
  afterAll(() => { stopServer(); });

  test(
    "good source: cargoGate.ok=true, validationIssues unchanged",
    async () => {
      await ensureServer();
      const { status, body } = await emitWithGate(GOOD_SOURCE);
      expect(status).toBe(200);
      expect(body.cargoGate).toBeDefined();
      const gate = body.cargoGate as { ok: boolean; errors: unknown[]; durationMs: number };
      if (!gate.ok) {
        console.log("Unexpected cargo failure:", JSON.stringify(gate, null, 2));
      }
      expect(gate.ok).toBe(true);
      expect(gate.errors).toHaveLength(0);
      // durationMs is a wall-clock timing field, not part of the verdict —
      // ok + empty errors are. Assert it's a sane non-negative number; the
      // previous `> 0` flaked under load.
      expect(typeof gate.durationMs).toBe("number");
      expect(gate.durationMs).toBeGreaterThanOrEqual(0);
    },
    240_000,
  );

  test(
    "broken source: cargoGate.ok=false, errors mirrored into validationIssues",
    async () => {
      await ensureServer();
      const { status, body } = await emitWithGate(BROKEN_SOURCE);
      expect(status).toBe(200);
      const gate = body.cargoGate as { ok: boolean; errors: unknown[] };
      const issues = body.validationIssues as Array<{ severity: string; message: string }>;
      // Validator already refuses composite (per #21) — that's a
      // validator-side error. Cargo also refuses it. We want BOTH.
      expect(gate.ok).toBe(false);
      expect(gate.errors.length).toBeGreaterThan(0);
      // The mirrored cargo issues carry the `cargo:` prefix.
      const cargoIssues = issues.filter((i) => i.severity === "error" && i.message.startsWith("cargo:"));
      expect(cargoIssues.length).toBeGreaterThan(0);
    },
    240_000,
  );
});

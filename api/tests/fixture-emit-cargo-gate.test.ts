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
import { describe, test, expect } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { parseAnchor } from "../src/parser/anchor-parser.js";

const CARGO_AVAILABLE = (() => {
  const r = spawnSync("cargo", ["--version"], { encoding: "utf-8" });
  return r.status === 0;
})();

const PORT = 8786;
const BASE = `http://127.0.0.1:${PORT}`;

let serverHandle: { proc: ReturnType<typeof spawnSync> | null } = { proc: null };
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
  // Wait for the listening message.
  await new Promise<void>((resolve, reject) => {
    let buf = "";
    const timer = setTimeout(() => reject(new Error("server did not start within 5s")), 5000);
    const onData = (d: Buffer) => {
      buf += d.toString();
      if (/Anvil API running/.test(buf)) {
        clearTimeout(timer);
        proc.stdout!.removeListener("data", onData);
        resolve();
      }
    };
    proc.stdout!.on("data", onData);
    proc.on("error", (e) => { clearTimeout(timer); reject(e); });
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

const BROKEN_SOURCE = `
use anchor_lang::prelude::*;
declare_id!("EHthziFziNoac9LBGxEaVN47Y3uUiRoXvqAiR6oes4iU");
#[program]
mod composite_broken {
    use super::*;
    pub fn composite_update(ctx: Context<CompositeUpdate>, dummy_a: u64) -> Result<()> {
        let a = &mut ctx.accounts.foo.dummy_a;
        a.data = dummy_a;
        Ok(())
    }
}
#[derive(Accounts)]
pub struct CompositeUpdate<'info> {
    foo: Foo<'info>,
}
#[derive(Accounts)]
pub struct Foo<'info> {
    #[account(mut)]
    pub dummy_a: Account<'info, DummyA>,
}
#[account]
pub struct DummyA { pub data: u64 }
`;

describe("/emit?gate=cargo (#22 / B2 backend)", () => {
  if (!CARGO_AVAILABLE) {
    test.skip("cargo not on PATH — skipping API cargo-gate tests", () => {});
    return;
  }

  test(
    "good source: cargoGate.ok=true, validationIssues unchanged",
    async () => {
      await startServer();
      try {
        const { status, body } = await emitWithGate(GOOD_SOURCE);
        expect(status).toBe(200);
        expect(body.cargoGate).toBeDefined();
        const gate = body.cargoGate as { ok: boolean; errors: unknown[]; durationMs: number };
        if (!gate.ok) {
          console.log("Unexpected cargo failure:", JSON.stringify(gate, null, 2));
        }
        expect(gate.ok).toBe(true);
        expect(gate.errors).toHaveLength(0);
        expect(gate.durationMs).toBeGreaterThan(0);
      } finally {
        stopServer();
      }
    },
    240_000,
  );

  test(
    "broken source: cargoGate.ok=false, errors mirrored into validationIssues",
    async () => {
      await startServer();
      try {
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
      } finally {
        stopServer();
      }
    },
    240_000,
  );
});

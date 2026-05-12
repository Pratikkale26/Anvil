/**
 * Orchestrator-side regression for #22 — the CLI's cargo-gate wiring.
 *
 * Unit test of runCargoCheckGate lives at api/tests/fixture-cargo-gate.test.ts.
 * This file spawns the CLI as a subprocess to lock the exit-code contract that
 * users see: default-on auto, --no-cargo-check escape, --cargo-check force.
 *
 * The fixtures share /home/pk/Anvil/api/src/demo-programs/counter.rs (known-
 * good) and the token-proxy if-let shape (known-broken at cargo).
 */
import { describe, test, expect, beforeAll } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const CARGO_AVAILABLE = (() => {
  const r = spawnSync("cargo", ["--version"], { encoding: "utf-8" });
  return r.status === 0;
})();

const REPO_ROOT = "/home/pk/Anvil";
const CLI_ENTRY = join(REPO_ROOT, "cli", "anvil.ts");
const SCRATCH = "/tmp/anvil-cli-gate-tests";

// Anchor's composite Accounts test case — Anvil's parser doesn't yet
// flatten nested #[derive(Accounts)] fields. #21 escalated this to a
// validator error, but the cargo gate would refuse it independently
// anyway (emit references AccountInfo.dummy_a which doesn't exist).
// Used here because the simpler if-let case happens to transpile via
// the walker.ts regex post-process for single-instruction shapes; the
// composite case fails cargo reliably.
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

beforeAll(() => {
  rmSync(SCRATCH, { recursive: true, force: true });
  mkdirSync(SCRATCH, { recursive: true });
  writeFileSync(join(SCRATCH, "broken.rs"), BROKEN_SOURCE, "utf-8");
  // counter is a known-good fixture shipped in api/src/demo-programs.
  const counterSrc = readFileSync(
    join(REPO_ROOT, "api", "src", "demo-programs", "counter.rs"),
    "utf-8",
  );
  writeFileSync(join(SCRATCH, "counter.rs"), counterSrc, "utf-8");
});

function runCli(args: string[]): { code: number; stdout: string; stderr: string } {
  const r = spawnSync("bun", [CLI_ENTRY, ...args], {
    cwd: REPO_ROOT,
    encoding: "utf-8",
    timeout: 240_000,
  });
  return { code: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

describe("CLI cargo-gate wiring (#22)", () => {
  if (!CARGO_AVAILABLE) {
    test.skip("cargo not on PATH — skipping CLI orchestrator tests", () => {});
    return;
  }

  test(
    "default (auto) on good source: gate runs, exit 0",
    () => {
      const out = join(SCRATCH, "good-out");
      rmSync(out, { recursive: true, force: true });
      const r = runCli([
        "compile",
        join(SCRATCH, "counter.rs"),
        "--target",
        "pinocchio",
        "--output",
        out,
      ]);
      expect(r.code).toBe(0);
      expect(r.stdout + r.stderr).toMatch(/cargo check: clean/i);
    },
    240_000,
  );

  test(
    "default (auto) on broken source: gate refuses, exit 3",
    () => {
      const out = join(SCRATCH, "broken-out");
      rmSync(out, { recursive: true, force: true });
      const r = runCli([
        "compile",
        join(SCRATCH, "broken.rs"),
        "--target",
        "pinocchio",
        "--output",
        out,
      ]);
      expect(r.code).toBe(3);
      expect(r.stdout + r.stderr).toMatch(/cargo check:.*error/i);
      // Files are still written so the user can inspect.
      expect(existsSync(out)).toBe(true);
    },
    240_000,
  );

  test(
    "--no-cargo-check skips the gate, exit 0 on broken source",
    () => {
      const out = join(SCRATCH, "broken-out-skip");
      rmSync(out, { recursive: true, force: true });
      const r = runCli([
        "compile",
        join(SCRATCH, "broken.rs"),
        "--target",
        "pinocchio",
        "--output",
        out,
        "--no-cargo-check",
      ]);
      expect(r.code).toBe(0);
      // Gate didn't run, so no cargo-error report in output.
      expect(r.stdout + r.stderr).not.toMatch(/cargo check: \d+ error/i);
    },
    240_000,
  );
});

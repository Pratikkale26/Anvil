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
// Must be broken on TWO independent axes so the test exercises both gates:
//   (a) a VALIDATOR error → the v0.4 strict gate refuses (exit 2);
//   (b) a CARGO error → the cargo gate refuses (exit 3) once strict is opted
//       out via --permissive.
// Earlier this used a composite #[derive(Accounts)] case, but Anvil's composite
// flatten now handles that cleanly (it emits 0 errors → exit 0), so the fixture
// went stale. This 2-instruction shape is robustly broken on current Anvil:
//   custom_cpi → uncataloged invoke_signed → cpi_custom unimplemented!() stub →
//                validator ERROR (#17) → strict refuses;
//   undef      → an undefined symbol carried verbatim in pass_through → cargo
//                E0425 (the cpi_custom stub itself compiles, so the cargo error
//                comes from this instruction).
const BROKEN_SOURCE = `
use anchor_lang::prelude::*;
use anchor_lang::solana_program::program::invoke_signed;
use anchor_lang::solana_program::instruction::Instruction;
declare_id!("EHthziFziNoac9LBGxEaVN47Y3uUiRoXvqAiR6oes4iU");
#[program]
mod stub_and_undef_broken {
    use super::*;
    pub fn custom_cpi(ctx: Context<Plain>, data: Vec<u8>) -> Result<()> {
        let ix = Instruction { program_id: *ctx.accounts.target.key, accounts: vec![], data };
        invoke_signed(&ix, &[ctx.accounts.target.to_account_info()], &[&[b"s", &[1u8]]])?;
        Ok(())
    }
    pub fn undef(_ctx: Context<Plain>) -> Result<()> {
        let _ = totally_undefined_symbol_xyz();
        Ok(())
    }
}
#[derive(Accounts)]
pub struct Plain<'info> {
    /// CHECK: target program for the raw CPI
    pub target: UncheckedAccount<'info>,
}
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
      // --permissive is needed to test the cargo-gate path in isolation;
      // post-v0.4 the validator-side --strict gate fires first and exits 2
      // before cargo even runs. This test is specifically about the
      // cargo-gate semantics, so we opt out of the parallel validator gate.
      const out = join(SCRATCH, "broken-out");
      rmSync(out, { recursive: true, force: true });
      const r = runCli([
        "compile",
        join(SCRATCH, "broken.rs"),
        "--target",
        "pinocchio",
        "--output",
        out,
        "--permissive",
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
      // Same rationale as the test above: --permissive opts out of the
      // validator-side strict gate (v0.4+ default) so we can isolate
      // the cargo-gate behavior.
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
        "--permissive",
      ]);
      expect(r.code).toBe(0);
      // Gate didn't run, so no cargo-error report in output.
      expect(r.stdout + r.stderr).not.toMatch(/cargo check: \d+ error/i);
    },
    240_000,
  );

  test(
    "v0.4 BREAKING: --strict is default — broken source refused without --permissive",
    () => {
      // Sanity check that the safe-by-default flip actually took effect.
      // Pre-v0.4 this same invocation would have exit 0 (strict opt-in;
      // emit written with warnings). Post-v0.4 the gate exits 2 before
      // any cargo gate runs.
      const out = join(SCRATCH, "default-broken-refusal");
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
      expect(r.code).toBe(2);
      expect(r.stdout + r.stderr).toMatch(/safe-by-default/i);
      expect(r.stdout + r.stderr).toMatch(/--permissive/);
    },
    240_000,
  );

  test(
    "--strict + --permissive is a hard error",
    () => {
      const r = runCli(["compile", "--strict", "--permissive", "foo.rs", "--target", "pinocchio"]);
      expect(r.code).toBe(1);
      expect(r.stderr).toMatch(/mutually exclusive/i);
    },
    30_000,
  );
});

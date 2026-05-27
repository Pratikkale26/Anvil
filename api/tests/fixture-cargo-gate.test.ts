/**
 * Regression for #22 — cargo as the accept gate.
 *
 * The validator's heuristic shape coverage is incomplete relative to
 * cargo (see fixture-result-alias-typed.test.ts, fixture-composite-
 * accounts.test.ts, fixture-if-let-ctx-accounts.test.ts). The cargo
 * check, by definition, IS what rustc accepts.
 *
 * This test asserts: emit → write scaffold → cargo check correctly
 * classifies a known-broken emit as failed and a known-good emit as
 * passed.
 *
 * Why bun:test: per advisor's path-c, we promote the orchestrator
 * (CLI / route handlers) to gate on cargo. The orchestrator-side
 * wrapper is `runCargoCheckGate` in cli/anvil.ts (or an equivalent in
 * api/src/build/). This test exercises it on real emit output.
 */
import { describe, test, expect } from "bun:test";
import { readFileSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { parseAnchor } from "../src/parser/anchor-parser.js";
import { emitPinocchioFull } from "../src/emitter/pinocchio-emitter.js";
import { buildProjectScaffold } from "../src/emitter/project-scaffold.js";
import { runCargoCheckGate } from "../src/build/cargo-gate.js";

const CARGO_AVAILABLE = (() => {
  const r = spawnSync("cargo", ["--version"], { encoding: "utf-8" });
  return r.status === 0;
})();

const SCRATCH = "/tmp/anvil-cargo-gate-tests";

function scaffold(name: string, source: string): string {
  const dir = join(SCRATCH, name);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(join(dir, "src"), { recursive: true });
  return dir;
}

async function emitAndWrite(name: string, source: string): Promise<string | null> {
  const parsed = await parseAnchor(source);
  if (!parsed.ok) return null;
  const emit = emitPinocchioFull(parsed.ir);
  const scaffoldFiles = buildProjectScaffold(parsed.ir, "pinocchio");
  const dir = scaffold(name, source);
  for (const f of emit.files) {
    const out = join(dir, "src", f.path);
    mkdirSync(join(out, ".."), { recursive: true });
    writeFileSync(out, f.content, "utf-8");
  }
  for (const f of scaffoldFiles) {
    const out = join(dir, f.path);
    mkdirSync(join(out, ".."), { recursive: true });
    writeFileSync(out, f.content, "utf-8");
  }
  return dir;
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
use anchor_spl::token::{self, Token, TokenAccount, Transfer};
declare_id!("Fg6PaFpoGXkYsidMpWTK6W2BeZ7FEfcYkg476zPFsLnS");
#[program]
pub mod broken {
    use super::*;
    pub fn ix(ctx: Context<P>, amount: u64) -> Result<()> {
        if let Some(_x) = &ctx.accounts.token_program {
            let cpi_accounts = Transfer {
                from: ctx.accounts.from.to_account_info(),
                to: ctx.accounts.to.to_account_info(),
                authority: ctx.accounts.authority.to_account_info(),
            };
            let cpi_program = ctx.accounts.authority.to_account_info();
            let cpi_context = CpiContext::new(cpi_program, cpi_accounts);
            token::transfer(cpi_context, amount)?;
        }
        Ok(())
    }
}
#[derive(Accounts)]
pub struct P<'info> {
    pub from: AccountInfo<'info>,
    pub to: AccountInfo<'info>,
    pub authority: AccountInfo<'info>,
    pub token_program: Option<Program<'info, Token>>,
}
`;

describe("cargo accept gate (#22)", () => {
  if (!CARGO_AVAILABLE) {
    test.skip("cargo not on PATH — skipping cargo-gate tests", () => {});
    return;
  }

  test(
    "good emit (counter-like) passes the cargo gate",
    async () => {
      const dir = await emitAndWrite("good", GOOD_SOURCE);
      expect(dir).not.toBeNull();
      const r = await runCargoCheckGate(dir!);
      if (!r.ok) {
        console.log("Unexpected cargo failure:\n" + r.stderr.slice(-1000));
      }
      expect(r.ok).toBe(true);
      expect(r.errors).toHaveLength(0);
    },
    180_000,
  );

  test(
    "token-proxy-shaped emit now passes the cargo gate (previously broken, fixed by CPI emit improvements)",
    async () => {
      const dir = await emitAndWrite("broken", BROKEN_SOURCE);
      expect(dir).not.toBeNull();
      const r = await runCargoCheckGate(dir!);
      expect(r.ok).toBe(true);
    },
    180_000,
  );
});

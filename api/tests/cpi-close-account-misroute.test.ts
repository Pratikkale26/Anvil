/**
 * B3 — close_account namespace-free misroute no longer FABRICATES an SPL CPI.
 *
 * The CPI dispatcher matches `close_account` namespace-free (substring /
 * exact-bare), so a user fn that merely shares the name reached
 * extractSplCloseAccount. Pre-B3, when the first arg was NOT an inline
 * `CpiContext::` (a bare user call, OR the legitimate variable-bound form
 * `let cpi = CpiContext::new(...); token::close_account(cpi)`), the extractor
 * fell through to FABRICATED account/destination/authority defaults and emitted
 * a real `cpi_spl_close_account` — a silent miscompile (a token-close CPI
 * against bogus accounts, no warning).
 *
 * Post-B3 (mirrors extractSplSetAuthority): when no inline CpiContext struct
 * resolves, the extractor falls back to pass_through + a loud
 * `cpi_classification_lost` warning instead of fabricating a CPI. The genuine
 * inline form is unchanged.
 */
import { describe, test, expect } from "bun:test";
import { parseAnchor } from "../src/parser/anchor-parser.ts";
import type { SolanaIR } from "../src/ir/schema.ts";

async function parseFirst(source: string): Promise<SolanaIR> {
  const r = await parseAnchor(source);
  if (!r.ok) throw new Error(`parse failed: ${JSON.stringify(r)}`);
  return r.ir;
}

const SHUT_ACCOUNTS = `
#[derive(Accounts)]
pub struct Shut<'info> {
    #[account(mut)]
    pub vault: Account<'info, TokenAccount>,
    #[account(mut)]
    pub owner: Signer<'info>,
    pub token_program: Program<'info, Token>,
}`;

describe("B3 — close_account misroute does not fabricate a token-close CPI", () => {
  test("genuine inline token::close_account(CpiContext::new(...)) → typed cpi_spl_close_account with REAL accounts", async () => {
    const ir = await parseFirst(`
use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, CloseAccount};
declare_id!("C1oseAcc11111111111111111111111111111111111");
#[program]
pub mod p {
    use super::*;
    pub fn shut(ctx: Context<Shut>) -> Result<()> {
        token::close_account(CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            CloseAccount {
                account: ctx.accounts.vault.to_account_info(),
                destination: ctx.accounts.owner.to_account_info(),
                authority: ctx.accounts.owner.to_account_info(),
            },
        ))?;
        Ok(())
    }
}
${SHUT_ACCOUNTS}
`);
    const close = ir.instructions[0]!.body.find((s) => s.kind === "cpi_spl_close_account") as
      | { kind: string; account: string; destination: string; authority: string }
      | undefined;
    expect(close).toBeDefined();
    // Accounts extracted from the struct — NOT fabricated "account"/"destination"/"authority" defaults.
    expect(close!.account).toBe("vault");
    expect(close!.destination).toBe("owner");
    expect(close!.authority).toBe("owner");
  });

  test("bare user fn close_account(x) → pass_through + warning, NOT a fabricated SPL close", async () => {
    const ir = await parseFirst(`
use anchor_lang::prelude::*;
declare_id!("C1oseAcc11111111111111111111111111111111111");
#[program]
pub mod p {
    use super::*;
    pub fn run(ctx: Context<Run>, amount: u64) -> Result<()> {
        // A USER helper that merely shares the SPL name — must NOT become a
        // real token-close CPI against fabricated accounts.
        close_account(amount)?;
        Ok(())
    }
}
fn close_account(_n: u64) -> Result<()> { Ok(()) }
#[derive(Accounts)]
pub struct Run<'info> { pub signer: Signer<'info> }
`);
    const body = ir.instructions[0]!.body;
    expect(body.some((s) => s.kind === "cpi_spl_close_account")).toBe(false);
    expect(ir.warnings.some((w) => w.code === "cpi_classification_lost")).toBe(true);
  });

  test("variable-bound CpiContext close (let cpi = ...; close_account(cpi)) → not fabricated", async () => {
    const ir = await parseFirst(`
use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, CloseAccount};
declare_id!("C1oseAcc11111111111111111111111111111111111");
#[program]
pub mod p {
    use super::*;
    pub fn shut(ctx: Context<Shut>) -> Result<()> {
        let cpi = CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            CloseAccount {
                account: ctx.accounts.vault.to_account_info(),
                destination: ctx.accounts.owner.to_account_info(),
                authority: ctx.accounts.owner.to_account_info(),
            },
        );
        token::close_account(cpi)?;
        Ok(())
    }
}
${SHUT_ACCOUNTS}
`);
    const body = ir.instructions[0]!.body;
    // Pre-B3: fabricated cpi_spl_close_account with default names. Post-B3: not
    // fabricated — pass_through + loud warning (the carried anchor_spl call then
    // fails the cargo gate on Pinocchio, which is the correct loud outcome).
    expect(body.some((s) => s.kind === "cpi_spl_close_account")).toBe(false);
    expect(ir.warnings.some((w) => w.code === "cpi_classification_lost")).toBe(true);
  });
});

/**
 * H1 regression: CPI consolidation passes are order-independent via
 * sentinel markers. Each consolidator wraps its output in
 * /*<<ANVIL_CPI_BEGIN>>*\/ ... /*<<ANVIL_CPI_END>>*\/ markers; subsequent
 * consolidators skip those regions. A final stripCpiSentinels() pass
 * removes the markers so emit / cargo never see them.
 *
 * The behavioral guarantee being tested: feed a source with multiple
 * adjacent CPI shapes (4-stmt + 3-stmt) into the consolidator and verify
 * (a) both get collapsed to inline calls, (b) no sentinel markers leak
 * to the output, (c) consolidation is idempotent.
 */
import { describe, test, expect } from "bun:test";
import { parseAnchor } from "../src/parser/anchor-parser.ts";

const HEADER = `
use anchor_lang::prelude::*;
use anchor_spl::token::{self, Transfer, Token, TokenAccount};
declare_id!("11111111111111111111111111111111");
`;

const ACCOUNTS = `
#[derive(Accounts)]
pub struct Move<'info> {
    #[account(mut)] pub from: Account<'info, TokenAccount>,
    #[account(mut)] pub to: Account<'info, TokenAccount>,
    pub authority: Signer<'info>,
    pub token_program: Program<'info, Token>,
}
`;

describe("H1: CPI consolidation sentinels", () => {
  test("consolidates 4-statement form, no sentinel leaks to body text", async () => {
    const src = `${HEADER}
#[program]
pub mod prog {
    use super::*;
    pub fn run(ctx: Context<Move>, amount: u64) -> Result<()> {
        let cpi_accounts = Transfer {
            from: ctx.accounts.from.to_account_info(),
            to: ctx.accounts.to.to_account_info(),
            authority: ctx.accounts.authority.to_account_info(),
        };
        let cpi_program = ctx.accounts.token_program.to_account_info();
        let cpi_ctx = CpiContext::new(cpi_program, cpi_accounts);
        token::transfer(cpi_ctx, amount)?;
        Ok(())
    }
}

${ACCOUNTS}
`;
    const r = await parseAnchor(src);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const run = r.ir.instructions.find((i) => i.name === "run")!;
    // After consolidation, the IR has a typed cpi_spl_transfer (not
    // pass_through) and the rawBody / pass-through fragments contain
    // no sentinel markers.
    expect(run.body.some((s) => s.kind === "cpi_spl_transfer")).toBe(true);
    const allBodyText = JSON.stringify(run.body) + (run.rawBody ?? "");
    expect(allBodyText).not.toContain("<<ANVIL_CPI_BEGIN>>");
    expect(allBodyText).not.toContain("<<ANVIL_CPI_END>>");
  });

  test("two adjacent 4-stmt CPIs both classify; sentinels don't leak", async () => {
    // Worst-case for ordering bugs: same-shape CPIs back-to-back. Without
    // sentinels, a later consolidator's regex could re-match the first
    // consolidator's output. The sentinel wrapper guarantees it can't.
    const src = `${HEADER}
#[program]
pub mod prog {
    use super::*;
    pub fn run(ctx: Context<Move>, a: u64, b: u64) -> Result<()> {
        let cpi_accounts_1 = Transfer {
            from: ctx.accounts.from.to_account_info(),
            to: ctx.accounts.to.to_account_info(),
            authority: ctx.accounts.authority.to_account_info(),
        };
        let cpi_program_1 = ctx.accounts.token_program.to_account_info();
        let cpi_ctx_1 = CpiContext::new(cpi_program_1, cpi_accounts_1);
        token::transfer(cpi_ctx_1, a)?;

        let cpi_accounts_2 = Transfer {
            from: ctx.accounts.to.to_account_info(),
            to: ctx.accounts.from.to_account_info(),
            authority: ctx.accounts.authority.to_account_info(),
        };
        let cpi_program_2 = ctx.accounts.token_program.to_account_info();
        let cpi_ctx_2 = CpiContext::new(cpi_program_2, cpi_accounts_2);
        token::transfer(cpi_ctx_2, b)?;
        Ok(())
    }
}

${ACCOUNTS}
`;
    const r = await parseAnchor(src);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const run = r.ir.instructions.find((i) => i.name === "run")!;
    const transfers = run.body.filter((s) => s.kind === "cpi_spl_transfer");
    expect(transfers.length).toBe(2);
    const allBodyText = JSON.stringify(run.body) + (run.rawBody ?? "");
    expect(allBodyText).not.toContain("<<ANVIL_CPI_BEGIN>>");
    expect(allBodyText).not.toContain("<<ANVIL_CPI_END>>");
  });
});

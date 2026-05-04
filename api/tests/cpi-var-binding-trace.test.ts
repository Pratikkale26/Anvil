/**
 * H2 regression: variable-bound CpiContext recovers signer_seeds via the
 * cpiContexts lookup callback that body-classifier supplies into the CPI
 * detector. Without H2, `let cpi_ctx = CpiContext::new_with_signer(prog,
 * Transfer{...}, &signers); transfer(cpi_ctx, amount)?;` lost
 * signer_seeds — the detector dropped them when firstArg.text didn't
 * include "CpiContext::". H2 looks up the binding and recovers.
 *
 * The IR's cpi_spl_transfer should carry signerSeeds when the rescue
 * succeeds, and only emit the loud warning when the binding wasn't tracked.
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

describe("H2: variable-bound CpiContext signer_seeds rescue", () => {
  test("variable-bound cpi_ctx (with inline struct) recovers signer_seeds — no warning", async () => {
    // Shape body-classifier tracks today: `let cpi_ctx = CpiContext::new_with_signer(
    //   prog, Transfer{...inline...}, signer_seeds);` followed by `transfer(cpi_ctx, amount)?;`.
    // extractCpiContextInfo captures from/to/authority/signerSeeds at the let;
    // H2's lookup pulls them at the call site.
    const src = `${HEADER}
#[program]
pub mod prog {
    use super::*;
    pub fn run(ctx: Context<Move>, amount: u64) -> Result<()> {
        let cpi_ctx = CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.from.to_account_info(),
                to: ctx.accounts.to.to_account_info(),
                authority: ctx.accounts.authority.to_account_info(),
            },
            signer_seeds,
        );
        token::transfer(cpi_ctx, amount)?;
        Ok(())
    }
}

${ACCOUNTS}
`;
    const r = await parseAnchor(src);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const transfer = r.ir.instructions[0]!.body.find((s) => s.kind === "cpi_spl_transfer");
    expect(transfer).toBeDefined();
    if (transfer?.kind === "cpi_spl_transfer") {
      expect(transfer.signerSeeds).toBeDefined();
      // from / to / authority recovered from the tracked binding.
      expect(transfer.from).toBe("from");
      expect(transfer.to).toBe("to");
    }
    const lostWarnings = r.ir.warnings.filter((w) => w.code === "signer_seeds_lost_variable_binding");
    expect(lostWarnings).toEqual([]);
  });

  test("CHAINED: let cpi_accounts = Transfer{}; let cpi_ctx = CpiContext::new(prog, cpi_accounts); transfer(cpi_ctx, ...) — H2-followup #35", async () => {
    // The H2 commit's known limitation: extractCpiContextInfo only saw
    // inline-struct CpiContext lets. The chained let-binding shape produced
    // signer_seeds_lost_variable_binding even though the data was right
    // there in the surrounding scope. #35 wires a parallel cpiAccountsByVar
    // map so the chain resolves end-to-end.
    const src = `${HEADER}
#[program]
pub mod prog {
    use super::*;
    pub fn run(ctx: Context<Move>, amount: u64) -> Result<()> {
        let seeds: &[&[&[u8]]] = &[&[b"vault", &[1u8]]];
        let cpi_accounts = Transfer {
            from: ctx.accounts.from.to_account_info(),
            to: ctx.accounts.to.to_account_info(),
            authority: ctx.accounts.authority.to_account_info(),
        };
        let cpi_program = ctx.accounts.token_program.to_account_info();
        let cpi_ctx = CpiContext::new_with_signer(cpi_program, cpi_accounts, seeds);
        token::transfer(cpi_ctx, amount)?;
        Ok(())
    }
}

${ACCOUNTS}
`;
    const r = await parseAnchor(src);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const transfer = r.ir.instructions[0]!.body.find((s) => s.kind === "cpi_spl_transfer");
    expect(transfer).toBeDefined();
    if (transfer?.kind === "cpi_spl_transfer") {
      expect(transfer.from).toBe("from");
      expect(transfer.to).toBe("to");
      expect(transfer.signerSeeds).toBeDefined();
    }
    const lostWarnings = r.ir.warnings.filter((w) => w.code === "signer_seeds_lost_variable_binding");
    expect(lostWarnings).toEqual([]);
  });

  test("warning still fires when binding genuinely isn't tracked", async () => {
    // Source where the cpi_ctx came from an extern (let cpi_ctx = some_helper();)
    // — the body-classifier's cpiContexts map never sees the binding, so the
    // lookup misses and the warning fires loud. This is the "honest miss"
    // case: H2 doesn't try to follow the helper return-value chain.
    const src = `${HEADER}
#[program]
pub mod prog {
    use super::*;
    pub fn run(_ctx: Context<Move>, amount: u64) -> Result<()> {
        let cpi_ctx = unimplemented!();
        token::transfer(cpi_ctx, amount)?;
        Ok(())
    }
}

${ACCOUNTS}
`;
    const r = await parseAnchor(src);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const codes = r.ir.warnings.map((w) => w.code);
    expect(codes).toContain("signer_seeds_lost_variable_binding");
    const w = r.ir.warnings.find((w) => w.code === "signer_seeds_lost_variable_binding")!;
    expect(w.message).toContain("'cpi_ctx'"); // includes the offending var name
  });
});

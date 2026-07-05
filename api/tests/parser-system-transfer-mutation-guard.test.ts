/**
 * Phase 6 Increment 9 — a let-bound system_instruction::transfer whose amount
 * (or from/to) is MUTATED between the binding and the invoke must NOT fold into
 * a clean cpi_system_transfer.
 *
 * system_instruction::transfer snapshots its args eagerly into the built
 * Instruction; the fold re-reads them at the later invoke(&ix) site. So
 *   let ix = system_instruction::transfer(&from.key(), &to.key(), amount);
 *   amount = amount * 2;
 *   invoke(&ix, ...)?;
 * originally sends the ORIGINAL amount, but a naive fold sends 2*amount — a
 * silent wrong-lamports miscompile (byte-compared, not a log). letBoundTransfer-
 * IsClean now bails on the fold, leaving the raw invoke as cpi_custom (which
 * emits a loud manual-port marker) instead of folding wrong bytes.
 */
import { describe, test, expect } from "bun:test";
import { parseAnchor } from "../src/parser/anchor-parser.ts";

async function bodyKinds(source: string): Promise<string[]> {
  const r = await parseAnchor(source);
  if (!r.ok) throw new Error(`parse failed: ${JSON.stringify(r)}`);
  return r.ir.instructions[0]!.body.map((s) => s.kind);
}

const PROGRAM = (mutLine: string) => `
use anchor_lang::prelude::*;
use anchor_lang::solana_program::{system_instruction, program::invoke};
declare_id!("Counter111111111111111111111111111111111111");

#[program]
pub mod p {
    use super::*;
    pub fn pay(ctx: Context<Pay>, amount: u64) -> Result<()> {
        let mut amount = amount;
        let ix = system_instruction::transfer(&ctx.accounts.from.key(), &ctx.accounts.to.key(), amount);
        ${mutLine}
        invoke(&ix, &[ctx.accounts.from.to_account_info(), ctx.accounts.to.to_account_info()])?;
        Ok(())
    }
}

#[derive(Accounts)]
pub struct Pay<'info> {
    #[account(mut)] pub from: Signer<'info>,
    #[account(mut)] pub to: SystemAccount<'info>,
    pub system_program: Program<'info, System>,
}
`;

describe("Phase 6 Inc 9 — mutated transfer arg is not silently folded", () => {
  test("amount reassigned after binding → does NOT fold to cpi_system_transfer", async () => {
    const kinds = await bodyKinds(PROGRAM("amount = amount * 2;"));
    // Pre-fix this folded to cpi_system_transfer and silently sent 2*amount.
    expect(kinds).not.toContain("cpi_system_transfer");
  });

  test("compound-assign of amount after binding → does NOT fold", async () => {
    const kinds = await bodyKinds(PROGRAM("amount += 1;"));
    expect(kinds).not.toContain("cpi_system_transfer");
  });

  test("CONTROL: unmutated amount still folds to cpi_system_transfer", async () => {
    // No mutation between binding and invoke — the fold is safe and must remain
    // (guards against the fix over-bailing and regressing byte-equal coverage).
    const src = `
use anchor_lang::prelude::*;
use anchor_lang::solana_program::{system_instruction, program::invoke};
declare_id!("Counter111111111111111111111111111111111111");

#[program]
pub mod p {
    use super::*;
    pub fn pay(ctx: Context<Pay>, amount: u64) -> Result<()> {
        let ix = system_instruction::transfer(&ctx.accounts.from.key(), &ctx.accounts.to.key(), amount);
        invoke(&ix, &[ctx.accounts.from.to_account_info(), ctx.accounts.to.to_account_info()])?;
        Ok(())
    }
}

#[derive(Accounts)]
pub struct Pay<'info> {
    #[account(mut)] pub from: Signer<'info>,
    #[account(mut)] pub to: SystemAccount<'info>,
    pub system_program: Program<'info, System>,
}
`;
    const kinds = await bodyKinds(src);
    expect(kinds).toContain("cpi_system_transfer");
  });
});

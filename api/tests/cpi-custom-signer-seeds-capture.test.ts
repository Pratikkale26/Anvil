/**
 * #28 (prereq for #23 generic-CPI emit) — cpi_custom must capture the ACTUAL
 * invoke_signed signer-seeds argument, not a hardcoded "signer_seeds" placeholder.
 *
 * extractCustomCpi previously set `signerSeeds = funcText === "invoke_signed" ?
 * "signer_seeds" : undefined` — a placeholder that happens to match the variable
 * name when the source binds seeds to a `signer_seeds` var, but LOSES the real
 * seeds when they're inline (`invoke_signed(&ix, &infos, &[&[b"x", &[bump]]])`).
 * Masked today because the cpi_custom stub ignores signerSeeds; a BLOCKER for #23,
 * where the emit translates these seeds (e.g. into Pinocchio's Signer type).
 *
 * Now: capture the 3rd argument verbatim. A bare identifier is captured as-is and
 * stays compatible with the emit's `signer_seeds` sentinel; an inline expression
 * is preserved for the generic-CPI emit to translate.
 */
import { describe, test, expect } from "bun:test";
import { parseAnchor } from "../src/parser/anchor-parser.ts";

function cpiCustomOf(ir: { instructions: Array<{ name: string; body: Array<{ kind: string }> }> }, fn: string) {
  return ir.instructions.find((i) => i.name === fn)?.body.find((s) => s.kind === "cpi_custom") as
    | { kind: "cpi_custom"; signerSeeds?: string; rawCode: string }
    | undefined;
}

const HEADER = `
use anchor_lang::prelude::*;
use anchor_lang::solana_program::program::invoke_signed;
use anchor_lang::solana_program::instruction::{Instruction, AccountMeta};
declare_id!("SeedCap11111111111111111111111111111111111111");
`;
const ACCOUNTS = `
#[derive(Accounts)]
pub struct Go<'info> {
    /// CHECK: program
    pub p: AccountInfo<'info>,
    /// CHECK: acct
    pub a: AccountInfo<'info>,
}
`;

describe("#28 — cpi_custom captures the real invoke_signed seeds", () => {
  test("INLINE seeds are captured verbatim (not the placeholder)", async () => {
    const src = `${HEADER}
#[program] pub mod m { use super::*;
  pub fn go(ctx: Context<Go>) -> Result<()> {
    let ix = Instruction { program_id: *ctx.accounts.p.key, accounts: vec![], data: vec![] };
    invoke_signed(&ix, &[ctx.accounts.a.to_account_info()], &[&[b"authority", &[ctx.bumps.x]]])?;
    Ok(())
  }
}
${ACCOUNTS}`;
    const r = await parseAnchor(src);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const c = cpiCustomOf(r.ir, "go");
    expect(c).toBeDefined();
    expect(c?.signerSeeds).toBe('&[&[b"authority", &[ctx.bumps.x]]]');
  });

  test("VARIABLE-bound seeds capture the identifier (stays sentinel-compatible)", async () => {
    const src = `${HEADER}
#[program] pub mod m { use super::*;
  pub fn go(ctx: Context<Go>) -> Result<()> {
    let ix = Instruction { program_id: *ctx.accounts.p.key, accounts: vec![], data: vec![] };
    let signer_seeds: &[&[&[u8]]] = &[&[b"x"]];
    invoke_signed(&ix, &[ctx.accounts.a.to_account_info()], signer_seeds)?;
    Ok(())
  }
}
${ACCOUNTS}`;
    const r = await parseAnchor(src);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(cpiCustomOf(r.ir, "go")?.signerSeeds).toBe("signer_seeds");
  });

  test("plain invoke (no signer) leaves signerSeeds undefined", async () => {
    const src = `${HEADER.replace("program::invoke_signed", "program::invoke")}
#[program] pub mod m { use super::*;
  pub fn go(ctx: Context<Go>) -> Result<()> {
    let ix = Instruction { program_id: *ctx.accounts.p.key, accounts: vec![], data: vec![] };
    invoke(&ix, &[ctx.accounts.a.to_account_info()])?;
    Ok(())
  }
}
${ACCOUNTS}`;
    const r = await parseAnchor(src);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(cpiCustomOf(r.ir, "go")?.signerSeeds).toBeUndefined();
  });
});

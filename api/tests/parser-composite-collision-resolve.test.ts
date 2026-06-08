/**
 * H9/H8 / #34 — composite-flattened inner-struct constraints must resolve to
 * the inner sibling, not a colliding TOP-LEVEL account.
 *
 * When a #[derive(Accounts)] struct embeds another, the inner accounts are
 * flattened with a `<field>_` prefix. The H1c rewrite only fixed up DOTTED
 * sibling refs (`mint.key()` -> `inner_mint.key()`); BARE constraint values
 * (`token::mint = mint`, `token::authority = authority`) and the dedicated
 * `initPayer` field (`payer = payer`) were left un-rewritten. When the inner
 * sibling name collides with a same-named top-level account, the un-rewritten
 * reference first-matched the WRONG (top-level) account — so a token account
 * was initialized with the wrong owner/mint and the wrong signer was debited
 * for rent (silent — without the collision the lookup would loudly miss).
 *
 * Fix: rewrite BARE identifiers (negative lookbehind, literal-masked) AND the
 * initPayer field, not just dotted refs.
 */
import { describe, test, expect } from "bun:test";
import { parseAnchor } from "../src/parser/anchor-parser.ts";

const SRC = `
use anchor_lang::prelude::*;
use anchor_spl::token::{Token, Mint, TokenAccount};
declare_id!("Counter111111111111111111111111111111111111");
#[program]
pub mod h9 { use super::*; pub fn go(ctx: Context<Parent>) -> Result<()> { Ok(()) } }

#[derive(Accounts)]
pub struct Parent<'info> {
    pub inner: TokenInit<'info>,
    pub mint: Account<'info, Mint>,
    #[account(mut)] pub payer: Signer<'info>,
    pub authority: Signer<'info>,
}

#[derive(Accounts)]
pub struct TokenInit<'info> {
    #[account(init, payer = payer, token::mint = mint, token::authority = authority,
              seeds = [b"vault", mint.key().as_ref()], bump)]
    pub vault: Account<'info, TokenAccount>,
    pub mint: Account<'info, Mint>,
    #[account(mut)] pub payer: Signer<'info>,
    pub authority: Signer<'info>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}
`;

describe("H9/H8 — composite collision resolves to inner sibling", () => {
  test("token::mint / token::authority / initPayer / seeds resolve to inner_*", async () => {
    const r = await parseAnchor(SRC);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const accts = r.ir.instructions[0]!.accounts;
    // both the prefixed inner siblings AND the top-level collisions exist
    expect(accts.map((a) => a.name)).toEqual(
      expect.arrayContaining(["inner_mint", "inner_payer", "inner_authority", "mint", "payer", "authority"]),
    );
    const vault = accts.find((a) => a.name.endsWith("vault"))!;
    const tm = vault.constraints.find((c) => c.kind === "token::mint");
    const ta = vault.constraints.find((c) => c.kind === "token::authority");
    // H9 — bare constraint values rewritten to the inner siblings
    expect(tm?.value).toBe("inner_mint");
    expect(ta?.value).toBe("inner_authority");
    // H8 — the dedicated initPayer field rewritten too
    expect(vault.initPayer).toBe("inner_payer");
    // dotted seed ref rewritten; byte-string literal left intact (no clobber)
    expect(vault.pdaSeeds?.some((s) => s.includes("inner_mint.key"))).toBe(true);
    expect(vault.pdaSeeds?.some((s) => s.includes('b"vault"'))).toBe(true);
    expect(vault.pdaSeeds?.some((s) => s.includes('b"inner_vault"'))).toBe(false);
  });
});

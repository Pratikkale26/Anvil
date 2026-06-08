/**
 * G8 / #30 — inline `CpiContext::new(prog, <hoisted-struct-var>)` must recover
 * the accounts struct's field bindings.
 *
 * When the SPL accounts struct is hoisted to a `let X = Transfer {…};` and then
 * passed by reference into an inline `CpiContext::new(prog, X)`, the extractor's
 * struct_expression descendant search finds nothing (X is an identifier) and
 * from/to/authority fell back to the literal defaults "from"/"to"/"authority".
 * For a crosswise mapping that silently REVERSES the transfer direction.
 *
 * Fix: the extractors look the hoisted var up in cpiAccountsByVar via the new
 * cpiAccountsLookup. The inline-struct form must keep working unchanged.
 */
import { describe, test, expect } from "bun:test";
import { parseAnchor } from "../src/parser/anchor-parser.ts";

async function cpiStmt(body: string, kind: string) {
  const src = `
use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, Mint, TokenAccount, Transfer, MintTo, Burn};
declare_id!("Counter111111111111111111111111111111111111");
#[program]
pub mod g8 {
    use super::*;
    pub fn act(ctx: Context<Act>, amount: u64) -> Result<()> {
${body}
        Ok(())
    }
}
#[derive(Accounts)]
pub struct Act<'info> {
    #[account(mut)] pub alpha: Account<'info, TokenAccount>,
    #[account(mut)] pub beta: Account<'info, TokenAccount>,
    #[account(mut)] pub the_mint: Account<'info, Mint>,
    pub auth: Signer<'info>,
    pub token_program: Program<'info, Token>,
}
`;
  const r = await parseAnchor(src);
  expect(r.ok).toBe(true);
  if (!r.ok) throw new Error("parse failed");
  const ix = r.ir.instructions.find((i) => i.name === "act");
  return ix?.body.find((s) => s.kind === kind) as any;
}

describe("G8 — hoisted CpiContext accounts struct resolution", () => {
  test("hoisted Transfer struct resolves crosswise from/to (not reversed defaults)", async () => {
    const cpi = await cpiStmt(
      `        let accts = Transfer {
            from: ctx.accounts.beta.to_account_info(),
            to: ctx.accounts.alpha.to_account_info(),
            authority: ctx.accounts.auth.to_account_info(),
        };
        token::transfer(CpiContext::new(ctx.accounts.token_program.to_account_info(), accts), amount)?;`,
      "cpi_spl_transfer",
    );
    expect(cpi.from).toBe("beta");
    expect(cpi.to).toBe("alpha");
    expect(cpi.authority).toBe("auth");
  });

  test("hoisted MintTo struct resolves mint/to/authority", async () => {
    const cpi = await cpiStmt(
      `        let accts = MintTo {
            mint: ctx.accounts.the_mint.to_account_info(),
            to: ctx.accounts.beta.to_account_info(),
            authority: ctx.accounts.auth.to_account_info(),
        };
        token::mint_to(CpiContext::new(ctx.accounts.token_program.to_account_info(), accts), amount)?;`,
      "cpi_spl_mint_to",
    );
    expect(cpi.mint).toBe("the_mint");
    expect(cpi.to).toBe("beta");
    expect(cpi.authority).toBe("auth");
  });

  test("hoisted Burn struct resolves from/mint/authority", async () => {
    const cpi = await cpiStmt(
      `        let accts = Burn {
            mint: ctx.accounts.the_mint.to_account_info(),
            from: ctx.accounts.alpha.to_account_info(),
            authority: ctx.accounts.auth.to_account_info(),
        };
        token::burn(CpiContext::new(ctx.accounts.token_program.to_account_info(), accts), amount)?;`,
      "cpi_spl_burn",
    );
    expect(cpi.mint).toBe("the_mint");
    expect(cpi.from).toBe("alpha");
    expect(cpi.authority).toBe("auth");
  });

  test("NO REGRESSION: inline struct form still resolves directly", async () => {
    const cpi = await cpiStmt(
      `        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.beta.to_account_info(),
                    to: ctx.accounts.alpha.to_account_info(),
                    authority: ctx.accounts.auth.to_account_info(),
                },
            ),
            amount,
        )?;`,
      "cpi_spl_transfer",
    );
    expect(cpi.from).toBe("beta");
    expect(cpi.to).toBe("alpha");
  });
});

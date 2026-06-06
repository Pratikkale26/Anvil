/**
 * F14 guard — a DataV2 field whose value contains commas/braces (e.g.
 * `name: format!("Staked {}", x)`) must be captured INTACT.
 *
 * The scalar field extractor used a naive `[^,}]+` regex that stopped at the
 * first `,` or `}` — so `format!("Staked {}", x)` was truncated to
 * `format!("Staked {`, producing unbalanced (non-compiling) emit. The extractor
 * is now brace/paren-depth-aware.
 */
import { describe, test, expect } from "bun:test";
import { parseAnchor } from "../src/parser/anchor-parser.ts";

const SRC = `
use anchor_lang::prelude::*;
declare_id!("11111111111111111111111111111111");

#[program]
pub mod p {
    use super::*;
    pub fn make(ctx: Context<MakeNft>) -> Result<()> {
        create_metadata_accounts_v3(
            CpiContext::new(
                ctx.accounts.token_metadata_program.to_account_info(),
                CreateMetadataAccountsV3 {
                    metadata: ctx.accounts.metadata_account.to_account_info(),
                    mint: ctx.accounts.mint_account.to_account_info(),
                    mint_authority: ctx.accounts.payer.to_account_info(),
                    payer: ctx.accounts.payer.to_account_info(),
                    update_authority: ctx.accounts.payer.to_account_info(),
                    system_program: ctx.accounts.system_program.to_account_info(),
                    rent: ctx.accounts.rent.to_account_info(),
                },
            ),
            DataV2 {
                name: format!("Staked {}", ctx.accounts.payer.key()),
                symbol: "STK".to_string(),
                uri: format!("{}/{}", BASE, ctx.accounts.mint_account.key()),
                seller_fee_basis_points: 0,
                creators: None,
                collection: None,
                uses: None,
            },
            true,
            true,
            None,
        )?;
        Ok(())
    }
}

#[derive(Accounts)]
pub struct MakeNft<'info> {
    #[account(mut)] pub metadata_account: AccountInfo<'info>,
    #[account(mut)] pub mint_account: AccountInfo<'info>,
    #[account(mut)] pub payer: Signer<'info>,
    pub token_metadata_program: AccountInfo<'info>,
    pub system_program: Program<'info, System>,
    pub rent: AccountInfo<'info>,
}
`;

describe("F14: DataV2 field with format!() is captured intact", () => {
  test("name/uri format!() are not truncated at the inner `,`/`}`", async () => {
    const r = await parseAnchor(SRC);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const make = r.ir.instructions.find((i) => i.name === "make")!;
    const stmt = make.body.find((s) => s.kind === "cpi_mpl_create_metadata_v3");
    expect(stmt).toBeDefined();
    if (stmt?.kind === "cpi_mpl_create_metadata_v3") {
      // Full format! macro, not the truncated `format!("Staked {`.
      expect(stmt.name).toBe(`format!("Staked {}", ctx.accounts.payer.key())`);
      expect(stmt.uri).toBe(`format!("{}/{}", BASE, ctx.accounts.mint_account.key())`);
      // Balanced delimiters (the regression symptom was an unbalanced capture).
      const balanced = (s: string) =>
        [...s].reduce((d, c) => d + (c === "(" || c === "{" ? 1 : c === ")" || c === "}" ? -1 : 0), 0);
      expect(balanced(stmt.name)).toBe(0);
      expect(balanced(stmt.uri)).toBe(0);
    }
  });
});

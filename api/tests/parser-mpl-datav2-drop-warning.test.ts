/**
 * Locks the parser's `mpl_datav2_fields_dropped` warning behavior.
 * Task #84 phases 1-5 captured all three DataV2 Option fields
 * (creators, collection, uses) in the IR — the warning no longer
 * fires for any of them. This test now asserts the warning is silent
 * for the canonical Some(...) shape across all three fields.
 *
 * Kept the file as a regression guard against the warning re-firing
 * (e.g. if a future refactor accidentally re-introduces a hard-coded
 * silent drop in the emitter or parser).
 */
import { describe, test, expect } from "bun:test";
import { parseAnchor } from "../src/parser/anchor-parser.ts";

const HEADER = `
use anchor_lang::prelude::*;
use anchor_spl::metadata::{create_metadata_accounts_v3, update_metadata_accounts_v2, CreateMetadataAccountsV3, Metadata, UpdateMetadataAccountsV2};
use anchor_spl::token::{Mint, Token};
use anchor_spl::metadata::mpl_token_metadata::types::{DataV2, Creator, Collection, Uses, UseMethod};
declare_id!("11111111111111111111111111111111");
`;

describe("parser captures all DataV2 nested fields without firing the drop warning", () => {
  test("All three fields populated: warning silent + all captured in IR", async () => {
    const src = `${HEADER}
#[program]
pub mod p {
    use super::*;
    pub fn make(ctx: Context<MakeNft>, name: String, symbol: String, uri: String) -> Result<()> {
        create_metadata_accounts_v3(
            CpiContext::new(
                ctx.accounts.token_metadata_program.to_account_info(),
                CreateMetadataAccountsV3 {
                    metadata: ctx.accounts.metadata.to_account_info(),
                    mint: ctx.accounts.mint.to_account_info(),
                    mint_authority: ctx.accounts.payer.to_account_info(),
                    payer: ctx.accounts.payer.to_account_info(),
                    update_authority: ctx.accounts.payer.to_account_info(),
                    system_program: ctx.accounts.system_program.to_account_info(),
                    rent: ctx.accounts.rent.to_account_info(),
                },
            ),
            DataV2 {
                name, symbol, uri, seller_fee_basis_points: 500,
                creators: Some(vec![Creator { address: ctx.accounts.payer.key(), verified: false, share: 100 }]),
                collection: Some(Collection { verified: false, key: ctx.accounts.mint.key() }),
                uses: Some(Uses { use_method: UseMethod::Burn, remaining: 10, total: 10 }),
            },
            true, true, None,
        )?;
        Ok(())
    }
}
#[derive(Accounts)]
pub struct MakeNft<'info> {
    #[account(mut)] pub metadata: UncheckedAccount<'info>,
    pub mint: Account<'info, Mint>,
    #[account(mut)] pub payer: Signer<'info>,
    pub token_metadata_program: Program<'info, Metadata>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}
`;
    const r = await parseAnchor(src);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const w = r.ir.warnings?.find((x) => x.code === "mpl_datav2_fields_dropped");
    expect(w).toBeUndefined();
    const stmt = r.ir.instructions[0]?.body[0];
    expect(stmt?.kind).toBe("cpi_mpl_create_metadata_v3");
    if (stmt?.kind === "cpi_mpl_create_metadata_v3") {
      expect(stmt.creators).toMatch(/Some\(vec!\[Creator/);
      expect(stmt.collection).toMatch(/Some\(Collection/);
      expect(stmt.uses).toMatch(/Some\(Uses/);
    }
  });

  test("All three fields = None: warning silent", async () => {
    const src = `${HEADER}
#[program]
pub mod p {
    use super::*;
    pub fn make(ctx: Context<MakeNft>, name: String, symbol: String, uri: String) -> Result<()> {
        create_metadata_accounts_v3(
            CpiContext::new(
                ctx.accounts.token_metadata_program.to_account_info(),
                CreateMetadataAccountsV3 {
                    metadata: ctx.accounts.metadata.to_account_info(),
                    mint: ctx.accounts.mint.to_account_info(),
                    mint_authority: ctx.accounts.payer.to_account_info(),
                    payer: ctx.accounts.payer.to_account_info(),
                    update_authority: ctx.accounts.payer.to_account_info(),
                    system_program: ctx.accounts.system_program.to_account_info(),
                    rent: ctx.accounts.rent.to_account_info(),
                },
            ),
            DataV2 {
                name, symbol, uri, seller_fee_basis_points: 0,
                creators: None, collection: None, uses: None,
            },
            true, true, None,
        )?;
        Ok(())
    }
}
#[derive(Accounts)]
pub struct MakeNft<'info> {
    #[account(mut)] pub metadata: UncheckedAccount<'info>,
    pub mint: Account<'info, Mint>,
    #[account(mut)] pub payer: Signer<'info>,
    pub token_metadata_program: Program<'info, Metadata>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}
`;
    const r = await parseAnchor(src);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const w = r.ir.warnings?.find((x) => x.code === "mpl_datav2_fields_dropped");
    expect(w).toBeUndefined();
  });
});

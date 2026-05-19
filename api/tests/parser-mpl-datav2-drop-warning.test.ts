/**
 * Locks the parser's `mpl_datav2_fields_dropped` warning. The IR for
 * cpi_mpl_create_metadata_v3 / cpi_mpl_update_metadata_accounts_v2 has
 * no fields for DataV2.creators / collection / uses — the emit hard-
 * codes them to None even when source writes Some(...). For programs
 * using royalty creators (most NFT minters), this silently drops
 * critical state.
 *
 * Until task #84 lands the actual IR extension, this warning surfaces
 * the silent drop at lint time so users can't deploy a misemitted
 * binary unknowingly.
 */
import { describe, test, expect } from "bun:test";
import { parseAnchor } from "../src/parser/anchor-parser.ts";

const HEADER = `
use anchor_lang::prelude::*;
use anchor_spl::metadata::{create_metadata_accounts_v3, update_metadata_accounts_v2, CreateMetadataAccountsV3, Metadata, UpdateMetadataAccountsV2};
use anchor_spl::token::{Mint, Token};
use anchor_spl::metadata::mpl_token_metadata::types::{DataV2, Creator};
declare_id!("11111111111111111111111111111111");
`;

describe("parser warns on DataV2 fields the IR drops", () => {
  test("creators: Some(vec![Creator{...}]) in create_metadata_v3 → mpl_datav2_fields_dropped warning", async () => {
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
                collection: None, uses: None,
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
    expect(w).toBeDefined();
    expect(w?.message).toMatch(/creators/);
  });

  test("DataV2 with creators=None doesn't emit the warning", async () => {
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

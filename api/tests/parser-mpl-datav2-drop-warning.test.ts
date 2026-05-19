/**
 * Locks the parser's `mpl_datav2_fields_dropped` warning. The IR for
 * cpi_mpl_create_metadata_v3 / cpi_mpl_update_metadata_accounts_v2
 * now carries `creators` (task #84 Phase 1), but still drops
 * `collection` and `uses`. This warning surfaces those two remaining
 * silent-drop classes at lint time.
 */
import { describe, test, expect } from "bun:test";
import { parseAnchor } from "../src/parser/anchor-parser.ts";

const HEADER = `
use anchor_lang::prelude::*;
use anchor_spl::metadata::{create_metadata_accounts_v3, update_metadata_accounts_v2, CreateMetadataAccountsV3, Metadata, UpdateMetadataAccountsV2};
use anchor_spl::token::{Mint, Token};
use anchor_spl::metadata::mpl_token_metadata::types::{DataV2, Creator, Collection};
declare_id!("11111111111111111111111111111111");
`;

describe("parser warns on DataV2 fields the IR drops", () => {
  test("collection: Some(...) in create_metadata_v3 → mpl_datav2_fields_dropped warning", async () => {
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
                creators: None,
                collection: Some(Collection { verified: false, key: ctx.accounts.payer.key() }),
                uses: None,
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
    expect(w?.message).toMatch(/collection/);
  });

  test("creators: Some(vec![...]) NO LONGER fires warning — IR captures it now (task #84 Phase 1)", async () => {
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
    expect(w).toBeUndefined();
    // creators should now be captured in IR
    const stmt = r.ir.instructions[0]?.body[0];
    expect(stmt?.kind).toBe("cpi_mpl_create_metadata_v3");
    if (stmt?.kind === "cpi_mpl_create_metadata_v3") {
      expect(stmt.creators).toBeDefined();
      expect(stmt.creators).toMatch(/Some\(vec!\[Creator/);
    }
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

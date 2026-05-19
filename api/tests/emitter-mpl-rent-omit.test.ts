/**
 * Regression contract: the four MPL helpers that take a `rent` AccountInfo
 * argument for ABI compat (`mpl_create_metadata_accounts_v3`,
 * `mpl_create_master_edition_v3`, `mpl_mint_new_edition_from_master`,
 * `mpl_approve_collection_authority`) MUST NOT include `rent.key()` /
 * `*rent.key` in the meta list they pass to the MPL CPI.
 *
 * Why: anchor-spl 0.31's wrappers hard-code `rent: None` on the MPL
 * Instruction struct, which produces N accounts (rent omitted). Anvil's
 * helpers used to include rent → N+1 accounts → divergence on every
 * MPL CPI from emit. Three fixes (commits 4bca2cf + e8f8f37) closed the
 * bugs; this test locks them so a future refactor can't re-introduce
 * the divergence without an extremely loud failure.
 *
 * If you remove the `let _ = rent;` lines + uncomment the rent meta,
 * this test fires loudly — exactly the signal a future contributor
 * needs.
 */
import { describe, test, expect } from "bun:test";
import { parseAnchor } from "../src/parser/anchor-parser.ts";
import { emitPinocchioFull } from "../src/emitter/pinocchio-emitter.ts";
import { emitNativeFull } from "../src/emitter/native-emitter.ts";

const HEADER = `
use anchor_lang::prelude::*;
use anchor_spl::metadata::{
    create_metadata_accounts_v3, create_master_edition_v3,
    mint_new_edition_from_master_edition_via_token,
    approve_collection_authority,
    CreateMetadataAccountsV3, CreateMasterEditionV3,
    MintNewEditionFromMasterEditionViaToken, ApproveCollectionAuthority,
    Metadata,
};
use anchor_spl::token::{Mint, Token, TokenAccount};
use anchor_spl::metadata::mpl_token_metadata::types::DataV2;
declare_id!("11111111111111111111111111111111");
`;

const SOURCE = `${HEADER}
#[program]
pub mod p {
    use super::*;
    pub fn make(ctx: Context<MakeNft>) -> Result<()> {
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
            DataV2 { name: "x".to_string(), symbol: "X".to_string(), uri: "".to_string(),
                seller_fee_basis_points: 0, creators: None, collection: None, uses: None },
            true, true, None,
        )?;
        Ok(())
    }

    pub fn lock_supply(ctx: Context<LockSupply>) -> Result<()> {
        create_master_edition_v3(
            CpiContext::new(
                ctx.accounts.token_metadata_program.to_account_info(),
                CreateMasterEditionV3 {
                    edition: ctx.accounts.edition.to_account_info(),
                    mint: ctx.accounts.mint.to_account_info(),
                    update_authority: ctx.accounts.payer.to_account_info(),
                    mint_authority: ctx.accounts.payer.to_account_info(),
                    payer: ctx.accounts.payer.to_account_info(),
                    metadata: ctx.accounts.metadata.to_account_info(),
                    token_program: ctx.accounts.token_program.to_account_info(),
                    system_program: ctx.accounts.system_program.to_account_info(),
                    rent: ctx.accounts.rent.to_account_info(),
                },
            ),
            Some(0),
        )?;
        Ok(())
    }

    pub fn print_edition(ctx: Context<PrintEd>, edition: u64) -> Result<()> {
        mint_new_edition_from_master_edition_via_token(
            CpiContext::new(
                ctx.accounts.token_metadata_program.to_account_info(),
                MintNewEditionFromMasterEditionViaToken {
                    new_metadata: ctx.accounts.new_metadata.to_account_info(),
                    new_edition: ctx.accounts.new_edition.to_account_info(),
                    master_edition: ctx.accounts.master_edition.to_account_info(),
                    new_mint: ctx.accounts.new_mint.to_account_info(),
                    edition_mark_pda: ctx.accounts.edition_mark_pda.to_account_info(),
                    new_mint_authority: ctx.accounts.payer.to_account_info(),
                    payer: ctx.accounts.payer.to_account_info(),
                    token_account_owner: ctx.accounts.payer.to_account_info(),
                    token_account: ctx.accounts.token_account.to_account_info(),
                    new_metadata_update_authority: ctx.accounts.payer.to_account_info(),
                    metadata: ctx.accounts.metadata.to_account_info(),
                    token_program: ctx.accounts.token_program.to_account_info(),
                    system_program: ctx.accounts.system_program.to_account_info(),
                    rent: ctx.accounts.rent.to_account_info(),
                },
            ),
            edition,
        )?;
        Ok(())
    }

    pub fn approve_auth(ctx: Context<ApproveAuth>) -> Result<()> {
        approve_collection_authority(
            CpiContext::new(
                ctx.accounts.token_metadata_program.to_account_info(),
                ApproveCollectionAuthority {
                    collection_authority_record: ctx.accounts.record.to_account_info(),
                    new_collection_authority: ctx.accounts.new_auth.to_account_info(),
                    update_authority: ctx.accounts.update_authority.to_account_info(),
                    payer: ctx.accounts.payer.to_account_info(),
                    metadata: ctx.accounts.metadata.to_account_info(),
                    mint: ctx.accounts.mint.to_account_info(),
                    system_program: ctx.accounts.system_program.to_account_info(),
                    rent: ctx.accounts.rent.to_account_info(),
                },
            ),
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
#[derive(Accounts)]
pub struct LockSupply<'info> {
    #[account(mut)] pub edition: UncheckedAccount<'info>,
    #[account(mut)] pub metadata: UncheckedAccount<'info>,
    #[account(mut)] pub mint: Account<'info, Mint>,
    #[account(mut)] pub payer: Signer<'info>,
    pub token_metadata_program: Program<'info, Metadata>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}
#[derive(Accounts)]
pub struct PrintEd<'info> {
    #[account(mut)] pub new_metadata: UncheckedAccount<'info>,
    #[account(mut)] pub new_edition: UncheckedAccount<'info>,
    #[account(mut)] pub master_edition: UncheckedAccount<'info>,
    #[account(mut)] pub new_mint: Account<'info, Mint>,
    #[account(mut)] pub edition_mark_pda: UncheckedAccount<'info>,
    #[account(mut)] pub payer: Signer<'info>,
    pub token_account: Account<'info, TokenAccount>,
    pub metadata: UncheckedAccount<'info>,
    pub token_metadata_program: Program<'info, Metadata>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}
#[derive(Accounts)]
pub struct ApproveAuth<'info> {
    #[account(mut)] pub record: UncheckedAccount<'info>,
    pub new_auth: UncheckedAccount<'info>,
    pub update_authority: Signer<'info>,
    #[account(mut)] pub payer: Signer<'info>,
    pub metadata: UncheckedAccount<'info>,
    pub mint: Account<'info, Mint>,
    pub token_metadata_program: Program<'info, Metadata>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}
`;

describe("MPL helpers DO NOT pass rent.key into the MPL CPI account list", () => {
  // The helper body texts contain `rent: &AccountInfo` as a fn parameter
  // (kept for ABI compat), and a `let _ = rent;` line that silences unused
  // warnings. What MUST NOT appear is `rent.key()` / `*rent.key` inside
  // the metas array — that's the wire-format bug class.

  test("Pinocchio emit: rent.key() doesn't appear in helpers.rs metas (4 helpers)", async () => {
    const r = await parseAnchor(SOURCE);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const out = emitPinocchioFull(r.ir);
    const helpers = out.files.find((f) => f.path === "helpers.rs")?.content ?? "";
    expect(helpers).toContain("mpl_create_metadata_accounts_v3");
    expect(helpers).toContain("mpl_create_master_edition_v3");
    expect(helpers).toContain("mpl_mint_new_edition_from_master");
    expect(helpers).toContain("mpl_approve_collection_authority");
    // Each helper drops the rent arg via let _ = rent;
    expect(helpers.match(/let _ = rent;/g)?.length).toBeGreaterThanOrEqual(4);
    // No helper passes rent into AccountMeta::new inside its metas array.
    // This catches the "added rent back to the meta list" regression class.
    const rentInMeta = helpers.match(/AccountMeta::new\(rent\.key\(\)/g);
    expect(rentInMeta, `rent.key() should never appear in metas — found ${rentInMeta?.length}`).toBeNull();
  });

  test("Native emit: *rent.key doesn't appear in helpers.rs accounts (4 helpers)", async () => {
    const r = await parseAnchor(SOURCE);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const out = emitNativeFull(r.ir);
    const helpers = out.files.find((f) => f.path === "helpers.rs")?.content ?? "";
    expect(helpers).toContain("mpl_create_metadata_accounts_v3");
    expect(helpers).toContain("mpl_create_master_edition_v3");
    expect(helpers).toContain("mpl_mint_new_edition_from_master");
    expect(helpers).toContain("mpl_approve_collection_authority");
    expect(helpers.match(/let _ = rent;/g)?.length).toBeGreaterThanOrEqual(4);
    // Native's AccountMeta form: `AccountMeta::new[_readonly](*rent.key, ...)`.
    const rentInAccounts = helpers.match(/AccountMeta::(?:new|new_readonly)\(\*rent\.key/g);
    expect(rentInAccounts, `*rent.key should never appear in accounts — found ${rentInAccounts?.length}`).toBeNull();
  });
});

use anchor_lang::prelude::*;
use anchor_spl::metadata::{
    create_master_edition_v3, create_metadata_accounts_v3,
    mint_new_edition_from_master_edition_via_token,
    CreateMasterEditionV3, CreateMetadataAccountsV3, Metadata,
    MintNewEditionFromMasterEditionViaToken,
};
use anchor_spl::metadata::mpl_token_metadata::types::DataV2;
use anchor_spl::token::{Mint, Token, TokenAccount};

declare_id!("H2h6s8Pci1EpgSbny7KGzHz3QvV1RM1qBwmdyYFAeV6h");

#[program]
pub mod mpl_mint_new_edition {
    use super::*;

    pub fn make_master(
        ctx: Context<MakeMaster>,
        name: String,
        symbol: String,
        uri: String,
    ) -> Result<()> {
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
                name,
                symbol,
                uri,
                seller_fee_basis_points: 0,
                creators: None,
                collection: None,
                uses: None,
            },
            true,
            true,
            None,
        )?;
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
            Some(10),
        )?;
        Ok(())
    }

    pub fn print_edition(ctx: Context<PrintEdition>, edition: u64) -> Result<()> {
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
                    token_account: ctx.accounts.master_token_account.to_account_info(),
                    new_metadata_update_authority: ctx.accounts.payer.to_account_info(),
                    metadata: ctx.accounts.metadata.to_account_info(),
                    token_program: ctx.accounts.token_program.to_account_info(),
                    system_program: ctx.accounts.system_program.to_account_info(),
                    rent: ctx.accounts.rent.to_account_info(),
                    metadata_mint: ctx.accounts.master_mint.to_account_info(),
                },
            ),
            edition,
        )?;
        Ok(())
    }
}

#[derive(Accounts)]
pub struct MakeMaster<'info> {
    /// CHECK: written by MPL CPI.
    #[account(mut)]
    pub metadata: UncheckedAccount<'info>,
    /// CHECK: written by MPL.
    #[account(mut)]
    pub edition: UncheckedAccount<'info>,
    #[account(mut)]
    pub mint: Account<'info, Mint>,
    #[account(mut)]
    pub payer: Signer<'info>,
    pub token_metadata_program: Program<'info, Metadata>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct PrintEdition<'info> {
    /// CHECK: created by MPL CPI.
    #[account(mut)]
    pub new_metadata: UncheckedAccount<'info>,
    /// CHECK: created by MPL CPI.
    #[account(mut)]
    pub new_edition: UncheckedAccount<'info>,
    /// CHECK: existing master edition pda.
    #[account(mut)]
    pub master_edition: UncheckedAccount<'info>,
    /// CHECK: existing master metadata pda.
    pub metadata: UncheckedAccount<'info>,
    /// CHECK: created by MPL CPI; edition marker tracking.
    #[account(mut)]
    pub edition_mark_pda: UncheckedAccount<'info>,
    #[account(mut)]
    pub new_mint: Account<'info, Mint>,
    /// Master holder's token account containing 1 master NFT.
    pub master_token_account: Account<'info, TokenAccount>,
    /// Master NFT mint — needed by anchor-spl 0.31 wrapper for edition_mark_pda
    /// derivation. anchor-spl's MintNewEditionFromMasterEditionViaToken struct
    /// has a trailing `metadata_mint` field that's not in the MPL ix metas
    /// (passed only as an extra unused trailing AccountInfo via ToAccountInfos).
    pub master_mint: Account<'info, Mint>,
    #[account(mut)]
    pub payer: Signer<'info>,
    pub token_metadata_program: Program<'info, Metadata>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

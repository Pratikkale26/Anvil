use anchor_lang::prelude::*;
use anchor_spl::metadata::{
    create_master_edition_v3, create_metadata_accounts_v3,
    update_metadata_accounts_v2, CreateMasterEditionV3,
    CreateMetadataAccountsV3, Metadata, UpdateMetadataAccountsV2,
};
use anchor_spl::token::{Mint, Token};
use anchor_spl::metadata::mpl_token_metadata::types::DataV2;

declare_id!("HYoSg3PQeyrytfiDptkAoBVbqqqbqouQn6ziJV9bNmjf");

#[program]
pub mod mpl_create_metadata {
    use super::*;

    pub fn make(
        ctx: Context<MakeNft>,
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
                seller_fee_basis_points: 500,
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

    pub fn rename(
        ctx: Context<UpdateNft>,
        new_name: String,
        new_symbol: String,
        new_uri: String,
    ) -> Result<()> {
        update_metadata_accounts_v2(
            CpiContext::new(
                ctx.accounts.token_metadata_program.to_account_info(),
                UpdateMetadataAccountsV2 {
                    metadata: ctx.accounts.metadata.to_account_info(),
                    update_authority: ctx.accounts.update_authority.to_account_info(),
                },
            ),
            None,
            Some(DataV2 {
                name: new_name,
                symbol: new_symbol,
                uri: new_uri,
                seller_fee_basis_points: 750,
                creators: None,
                collection: None,
                uses: None,
            }),
            None,
            Some(true),
        )?;
        Ok(())
    }
}

#[derive(Accounts)]
pub struct MakeNft<'info> {
    /// CHECK: written by MPL CPI; PDA derivation is enforced off-chain via
    /// findProgramAddress in the differential test.
    #[account(mut)]
    pub metadata: UncheckedAccount<'info>,
    pub mint: Account<'info, Mint>,
    #[account(mut)]
    pub payer: Signer<'info>,
    pub token_metadata_program: Program<'info, Metadata>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct LockSupply<'info> {
    /// CHECK: written by MPL; PDA enforced off-chain.
    #[account(mut)]
    pub edition: UncheckedAccount<'info>,
    /// CHECK: written by MPL (existing metadata PDA).
    #[account(mut)]
    pub metadata: UncheckedAccount<'info>,
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
pub struct UpdateNft<'info> {
    /// CHECK: written by MPL CPI; existence enforced by MPL itself.
    #[account(mut)]
    pub metadata: UncheckedAccount<'info>,
    pub update_authority: Signer<'info>,
    pub token_metadata_program: Program<'info, Metadata>,
}

use anchor_lang::prelude::*;
use anchor_spl::metadata::{
    create_master_edition_v3, create_metadata_accounts_v3,
    freeze_delegated_account, thaw_delegated_account,
    CreateMasterEditionV3, CreateMetadataAccountsV3,
    FreezeDelegatedAccount, Metadata, ThawDelegatedAccount,
};
use anchor_spl::metadata::mpl_token_metadata::types::DataV2;
use anchor_spl::token::{Mint, Token, TokenAccount};

declare_id!("FrEEzpY8xMFqXmS9DGw1mwm9JBeQXdT4nz4LkXfqsiqu");

#[program]
pub mod mpl_freeze_thaw {
    use super::*;

    pub fn make_nft(
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
            Some(0),
        )?;
        Ok(())
    }

    pub fn freeze(ctx: Context<FreezeCtx>) -> Result<()> {
        freeze_delegated_account(CpiContext::new(
            ctx.accounts.token_metadata_program.to_account_info(),
            FreezeDelegatedAccount {
                metadata: ctx.accounts.metadata.to_account_info(),
                delegate: ctx.accounts.delegate.to_account_info(),
                token_account: ctx.accounts.token_account.to_account_info(),
                edition: ctx.accounts.edition.to_account_info(),
                mint: ctx.accounts.mint.to_account_info(),
                token_program: ctx.accounts.token_program.to_account_info(),
            },
        ))?;
        Ok(())
    }

    pub fn thaw(ctx: Context<FreezeCtx>) -> Result<()> {
        thaw_delegated_account(CpiContext::new(
            ctx.accounts.token_metadata_program.to_account_info(),
            ThawDelegatedAccount {
                metadata: ctx.accounts.metadata.to_account_info(),
                delegate: ctx.accounts.delegate.to_account_info(),
                token_account: ctx.accounts.token_account.to_account_info(),
                edition: ctx.accounts.edition.to_account_info(),
                mint: ctx.accounts.mint.to_account_info(),
                token_program: ctx.accounts.token_program.to_account_info(),
            },
        ))?;
        Ok(())
    }
}

#[derive(Accounts)]
pub struct MakeNft<'info> {
    /// CHECK: written by MPL CPI; PDA enforced off-chain.
    #[account(mut)]
    pub metadata: UncheckedAccount<'info>,
    /// CHECK: written by MPL; PDA enforced off-chain.
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
pub struct FreezeCtx<'info> {
    /// CHECK: MPL reads to verify master edition pairing.
    pub metadata: UncheckedAccount<'info>,
    /// CHECK: master edition pda — MPL reads to permit freeze.
    pub edition: UncheckedAccount<'info>,
    pub mint: Account<'info, Mint>,
    #[account(mut)]
    pub token_account: Account<'info, TokenAccount>,
    pub delegate: Signer<'info>,
    pub token_program: Program<'info, Token>,
    pub token_metadata_program: Program<'info, Metadata>,
}

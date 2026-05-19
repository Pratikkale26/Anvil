use anchor_lang::prelude::*;
use anchor_spl::metadata::{
    approve_collection_authority, create_master_edition_v3,
    create_metadata_accounts_v3, revoke_collection_authority,
    ApproveCollectionAuthority, CreateMasterEditionV3,
    CreateMetadataAccountsV3, Metadata, RevokeCollectionAuthority,
};
use anchor_spl::metadata::mpl_token_metadata::types::DataV2;
use anchor_spl::token::{Mint, Token};

declare_id!("AvpRvKWUNz2zWPJ4iAuTGRPF6NeRpqDXJ8TfHTUuBcDw");

#[program]
pub mod mpl_approve_revoke {
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

    pub fn approve(ctx: Context<ApproveCtx>) -> Result<()> {
        approve_collection_authority(CpiContext::new(
            ctx.accounts.token_metadata_program.to_account_info(),
            ApproveCollectionAuthority {
                collection_authority_record: ctx.accounts.record.to_account_info(),
                new_collection_authority: ctx.accounts.new_auth.to_account_info(),
                update_authority: ctx.accounts.payer.to_account_info(),
                payer: ctx.accounts.payer.to_account_info(),
                metadata: ctx.accounts.metadata.to_account_info(),
                mint: ctx.accounts.mint.to_account_info(),
            },
        ))?;
        Ok(())
    }

    pub fn revoke(ctx: Context<RevokeCtx>) -> Result<()> {
        revoke_collection_authority(CpiContext::new(
            ctx.accounts.token_metadata_program.to_account_info(),
            RevokeCollectionAuthority {
                collection_authority_record: ctx.accounts.record.to_account_info(),
                delegate_authority: ctx.accounts.delegate_authority.to_account_info(),
                revoke_authority: ctx.accounts.payer.to_account_info(),
                metadata: ctx.accounts.metadata.to_account_info(),
                mint: ctx.accounts.mint.to_account_info(),
            },
        ))?;
        Ok(())
    }
}

#[derive(Accounts)]
pub struct MakeNft<'info> {
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
pub struct ApproveCtx<'info> {
    /// CHECK: created by MPL CPI; PDA enforced off-chain.
    #[account(mut)]
    pub record: UncheckedAccount<'info>,
    /// CHECK: read-only by MPL — the pubkey being granted authority.
    pub new_auth: UncheckedAccount<'info>,
    /// CHECK: existing metadata PDA.
    pub metadata: UncheckedAccount<'info>,
    pub mint: Account<'info, Mint>,
    #[account(mut)]
    pub payer: Signer<'info>,
    pub token_metadata_program: Program<'info, Metadata>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct RevokeCtx<'info> {
    /// CHECK: existing collection_authority_record PDA — closed by MPL.
    #[account(mut)]
    pub record: UncheckedAccount<'info>,
    /// CHECK: the delegated authority being revoked.
    pub delegate_authority: UncheckedAccount<'info>,
    /// CHECK: existing metadata PDA.
    pub metadata: UncheckedAccount<'info>,
    pub mint: Account<'info, Mint>,
    #[account(mut)]
    pub payer: Signer<'info>,
    pub token_metadata_program: Program<'info, Metadata>,
}

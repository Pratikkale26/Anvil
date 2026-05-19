use anchor_lang::prelude::*;
use anchor_spl::metadata::{
    create_master_edition_v3, create_metadata_accounts_v3,
    set_and_verify_collection, unverify_collection, verify_collection,
    CreateMasterEditionV3, CreateMetadataAccountsV3, Metadata,
    SetAndVerifyCollection, UnverifyCollection, VerifyCollection,
};
use anchor_spl::metadata::mpl_token_metadata::types::DataV2;
use anchor_spl::token::{Mint, Token};

declare_id!("CHQqELvHkRwCu4QXSdAcYbXgvxbe5dh89nWmZmF2bbVK");

#[program]
pub mod mpl_collection_verify {
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

    pub fn set_and_verify(ctx: Context<VerifyCtx>) -> Result<()> {
        set_and_verify_collection(
            CpiContext::new(
                ctx.accounts.token_metadata_program.to_account_info(),
                SetAndVerifyCollection {
                    metadata: ctx.accounts.metadata.to_account_info(),
                    collection_authority: ctx.accounts.payer.to_account_info(),
                    payer: ctx.accounts.payer.to_account_info(),
                    update_authority: ctx.accounts.payer.to_account_info(),
                    collection_mint: ctx.accounts.collection_mint.to_account_info(),
                    collection_metadata: ctx.accounts.collection_metadata.to_account_info(),
                    collection_master_edition: ctx.accounts.collection_master_edition.to_account_info(),
                },
            ),
            None,
        )?;
        Ok(())
    }

    pub fn unverify(ctx: Context<VerifyCtx>) -> Result<()> {
        unverify_collection(
            CpiContext::new(
                ctx.accounts.token_metadata_program.to_account_info(),
                UnverifyCollection {
                    metadata: ctx.accounts.metadata.to_account_info(),
                    collection_authority: ctx.accounts.payer.to_account_info(),
                    collection_mint: ctx.accounts.collection_mint.to_account_info(),
                    collection: ctx.accounts.collection_metadata.to_account_info(),
                    collection_master_edition_account: ctx.accounts.collection_master_edition.to_account_info(),
                },
            ),
            None,
        )?;
        Ok(())
    }

    pub fn verify(ctx: Context<VerifyCtx>) -> Result<()> {
        verify_collection(
            CpiContext::new(
                ctx.accounts.token_metadata_program.to_account_info(),
                VerifyCollection {
                    payer: ctx.accounts.payer.to_account_info(),
                    metadata: ctx.accounts.metadata.to_account_info(),
                    collection_authority: ctx.accounts.payer.to_account_info(),
                    collection_mint: ctx.accounts.collection_mint.to_account_info(),
                    collection_metadata: ctx.accounts.collection_metadata.to_account_info(),
                    collection_master_edition: ctx.accounts.collection_master_edition.to_account_info(),
                },
            ),
            None,
        )?;
        Ok(())
    }
}

#[derive(Accounts)]
pub struct MakeNft<'info> {
    /// CHECK: written by MPL CPI; PDA enforced off-chain in the differential.
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
pub struct VerifyCtx<'info> {
    /// CHECK: written by MPL CPI; existing metadata PDA of the ITEM NFT.
    #[account(mut)]
    pub metadata: UncheckedAccount<'info>,
    /// CHECK: read by MPL CPI; collection NFT's metadata PDA.
    pub collection_metadata: UncheckedAccount<'info>,
    /// CHECK: read by MPL CPI; collection NFT's master edition PDA.
    pub collection_master_edition: UncheckedAccount<'info>,
    pub collection_mint: Account<'info, Mint>,
    #[account(mut)]
    pub payer: Signer<'info>,
    pub token_metadata_program: Program<'info, Metadata>,
}

use anchor_lang::prelude::*;
use anchor_spl::metadata::{
    create_metadata_accounts_v3, sign_metadata,
    CreateMetadataAccountsV3, Metadata, SignMetadata,
};
use anchor_spl::metadata::mpl_token_metadata::types::{Creator, DataV2};
use anchor_spl::token::Mint;

declare_id!("9tjA7cNjLeAwdGgoi26HwCq1CPWojPThsm3myShDJokR");

#[program]
pub mod mpl_sign_metadata {
    use super::*;

    pub fn make_with_unverified(ctx: Context<MakeNft>, name: String) -> Result<()> {
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
                symbol: "SIGN".to_string(),
                uri: "ipfs://sign-test".to_string(),
                seller_fee_basis_points: 250,
                creators: Some(vec![
                    Creator {
                        address: ctx.accounts.creator.key(),
                        verified: false,
                        share: 100,
                    },
                ]),
                collection: None,
                uses: None,
            },
            true,
            true,
            None,
        )?;
        Ok(())
    }

    pub fn sign(ctx: Context<SignCtx>) -> Result<()> {
        sign_metadata(CpiContext::new(
            ctx.accounts.token_metadata_program.to_account_info(),
            SignMetadata {
                creator: ctx.accounts.creator.to_account_info(),
                metadata: ctx.accounts.metadata.to_account_info(),
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
    pub mint: Account<'info, Mint>,
    /// CHECK: the creator pubkey that will be registered in the metadata's
    /// creators array with verified=false. sign_metadata later flips this.
    pub creator: UncheckedAccount<'info>,
    #[account(mut)]
    pub payer: Signer<'info>,
    pub token_metadata_program: Program<'info, Metadata>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct SignCtx<'info> {
    /// CHECK: existing metadata PDA — MPL writes the verified flag here.
    #[account(mut)]
    pub metadata: UncheckedAccount<'info>,
    pub creator: Signer<'info>,
    pub token_metadata_program: Program<'info, Metadata>,
}

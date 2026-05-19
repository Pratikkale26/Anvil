use anchor_lang::prelude::*;
use anchor_spl::metadata::{
    create_metadata_accounts_v3, CreateMetadataAccountsV3, Metadata,
};
use anchor_spl::token::{Mint, Token};
use anchor_spl::metadata::mpl_token_metadata::types::DataV2;

declare_id!("Mp1CreateMeta11111111111111111111111111111");

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

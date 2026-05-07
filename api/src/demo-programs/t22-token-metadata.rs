use anchor_lang::prelude::*;
use anchor_spl::token_interface::{
    token_metadata_initialize, Token2022, TokenMetadataInitialize,
};

declare_id!("48VXaU9ZU9MqStoezSehvGA7Tqm7wedzDEbMVk2MweGE");

#[program]
pub mod t22_token_metadata {
    use super::*;

    /// Initialize TokenMetadata on a mint already configured with the
    /// MetadataPointer extension pointing at itself. Mint must have
    /// pre-allocated space for the metadata bytes (variable-length —
    /// computed by caller from String sizes).
    pub fn make_metadata(
        ctx: Context<MakeMetadata>,
        name: String,
        symbol: String,
        uri: String,
    ) -> Result<()> {
        token_metadata_initialize(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                TokenMetadataInitialize {
                    program_id: ctx.accounts.token_program.to_account_info(),
                    mint: ctx.accounts.mint.to_account_info(),
                    metadata: ctx.accounts.mint.to_account_info(),
                    mint_authority: ctx.accounts.payer.to_account_info(),
                    update_authority: ctx.accounts.payer.to_account_info(),
                },
            ),
            name,
            symbol,
            uri,
        )?;
        Ok(())
    }
}

#[derive(Accounts)]
pub struct MakeMetadata<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    /// CHECK: Pre-allocated mint with MetadataPointer + variable-length
    /// metadata extension space; Token-2022 program validates state.
    #[account(mut)]
    pub mint: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token2022>,
}

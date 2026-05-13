use anchor_lang::prelude::*;
use anchor_spl::token_2022_extensions::{
    metadata_pointer_initialize, MetadataPointerInitialize,
};
use anchor_spl::token_interface::Token2022;

declare_id!("3xRtNVv3oUfz6C6w7KroQRENraPRG4gRwmyqniy8U6H1");

#[program]
pub mod t22_metadata_pointer {
    use super::*;

    /// Token-2022 MetadataPointer extension init — EM2 Session 2
    /// differential. Mint must be pre-allocated with space for
    /// `[ExtensionType::MetadataPointer]`. The pointer records an
    /// off-mint account that holds the metadata bytes (often the mint
    /// itself, for the in-mint TokenMetadata extension case).
    pub fn make_metadata_pointer(ctx: Context<MakeMetadataPointer>) -> Result<()> {
        metadata_pointer_initialize(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                MetadataPointerInitialize {
                    token_program_id: ctx.accounts.token_program.to_account_info(),
                    mint: ctx.accounts.mint.to_account_info(),
                },
            ),
            Some(ctx.accounts.payer.key()),
            Some(ctx.accounts.metadata.key()),
        )?;
        Ok(())
    }
}

#[derive(Accounts)]
pub struct MakeMetadataPointer<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    /// CHECK: Pre-allocated mint with extension space; Token-2022
    /// validates state on the CPI.
    #[account(mut)]
    pub mint: UncheckedAccount<'info>,
    /// CHECK: Metadata account address recorded in the pointer; the
    /// Token-2022 program writes the bytes without verifying the
    /// account exists or has any particular shape.
    pub metadata: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token2022>,
}

use anchor_lang::prelude::*;
use anchor_spl::token_2022_extensions::{
    mint_close_authority_initialize, MintCloseAuthorityInitialize,
};
use anchor_spl::token_interface::Token2022;

declare_id!("Mca7H4M9pPXq3vYz1k8Q2w5L9P0sR3tU6V8W0X1Y2Z3");

#[program]
pub mod t22_mint_close_authority {
    use super::*;

    /// Token-2022 MintCloseAuthority extension init — EM2 Session 1
    /// differential. Mint must be pre-allocated by the caller with
    /// space for `[ExtensionType::MintCloseAuthority]`. After this
    /// call, the close_authority can close the mint (via
    /// `token::close_account` on the mint).
    pub fn make_mint_close_authority(ctx: Context<MakeMintCloseAuthority>) -> Result<()> {
        mint_close_authority_initialize(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                MintCloseAuthorityInitialize {
                    token_program_id: ctx.accounts.token_program.to_account_info(),
                    mint: ctx.accounts.mint.to_account_info(),
                },
            ),
            Some(&ctx.accounts.payer.key()),
        )?;
        Ok(())
    }
}

#[derive(Accounts)]
pub struct MakeMintCloseAuthority<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    /// CHECK: Pre-allocated mint with extension space; Token-2022
    /// program validates state on the CPI. Anchor's InterfaceAccount
    /// <Mint> would reject the uninitialized mint at constraint time,
    /// blocking the extension init that must precede initialize_mint.
    #[account(mut)]
    pub mint: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token2022>,
}

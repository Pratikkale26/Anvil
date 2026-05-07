use anchor_lang::prelude::*;
use anchor_spl::token_interface::{
    non_transferable_mint_initialize, NonTransferableMintInitialize, Token2022,
};

declare_id!("Gn7q4tH9JWJ6N7p7Mp9eEThbV5zSV1Q2vJ7rGXAEJUWB");

#[program]
pub mod t22_non_transferable {
    use super::*;

    /// Token-2022 NonTransferable extension init — single-instruction
    /// EM2 differential. Mint must be pre-allocated by the caller with
    /// space for `[ExtensionType::NonTransferable]`. After this call,
    /// any `transfer_checked` against the mint reverts at the
    /// Token-2022 program level.
    pub fn make_non_transferable(ctx: Context<MakeNonTransferable>) -> Result<()> {
        non_transferable_mint_initialize(CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            NonTransferableMintInitialize {
                token_program_id: ctx.accounts.token_program.to_account_info(),
                mint: ctx.accounts.mint.to_account_info(),
            },
        ))?;
        Ok(())
    }
}

#[derive(Accounts)]
pub struct MakeNonTransferable<'info> {
    /// CHECK: Pre-allocated mint with extension space; Token-2022 program
    /// validates state on the CPI. Anchor's InterfaceAccount<Mint> would
    /// reject the uninitialized mint at constraint time, blocking the
    /// extension init that must precede initialize_mint.
    #[account(mut)]
    pub mint: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token2022>,
}

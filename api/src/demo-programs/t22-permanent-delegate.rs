use anchor_lang::prelude::*;
use anchor_spl::token_2022_extensions::{
    permanent_delegate_initialize, PermanentDelegateInitialize,
};
use anchor_spl::token_interface::Token2022;

declare_id!("PdL9k1mNoP3Q4R5S6T7U8V9W0X1Y2Z3aA4bB5cC6dD7");

#[program]
pub mod t22_permanent_delegate {
    use super::*;

    /// Token-2022 PermanentDelegate extension init — EM2 Session 1
    /// differential. Mint must be pre-allocated by the caller with
    /// space for `[ExtensionType::PermanentDelegate]`. After this
    /// call, the delegate has authority to transfer/burn from ANY
    /// holder of this mint — permanently (no revoke instruction).
    pub fn make_permanent_delegate(ctx: Context<MakePermanentDelegate>) -> Result<()> {
        permanent_delegate_initialize(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                PermanentDelegateInitialize {
                    token_program_id: ctx.accounts.token_program.to_account_info(),
                    mint: ctx.accounts.mint.to_account_info(),
                },
            ),
            &ctx.accounts.payer.key(),
        )?;
        Ok(())
    }
}

#[derive(Accounts)]
pub struct MakePermanentDelegate<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    /// CHECK: Pre-allocated mint with extension space; Token-2022
    /// program validates state on the CPI.
    #[account(mut)]
    pub mint: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token2022>,
}

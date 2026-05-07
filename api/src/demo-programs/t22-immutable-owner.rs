use anchor_lang::prelude::*;
use anchor_spl::token_interface::{
    immutable_owner_initialize, ImmutableOwnerInitialize, Token2022,
};

declare_id!("HHGgMthP3YZQDAzwWrXiLzwNsVjZE4arwoUy6qHypJzT");

#[program]
pub mod t22_immutable_owner {
    use super::*;

    /// Initialize the ImmutableOwner extension on a token account.
    /// Token account must be pre-allocated with extension space.
    /// After this call, the account owner is locked — SetAuthority
    /// AccountOwner attempts revert at the Token-2022 program level.
    pub fn lock_owner(ctx: Context<LockOwner>) -> Result<()> {
        immutable_owner_initialize(CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            ImmutableOwnerInitialize {
                token_program_id: ctx.accounts.token_program.to_account_info(),
                token_account: ctx.accounts.token_account.to_account_info(),
            },
        ))?;
        Ok(())
    }
}

#[derive(Accounts)]
pub struct LockOwner<'info> {
    /// CHECK: Pre-allocated token account with extension space; Token-2022
    /// program validates state on the CPI.
    #[account(mut)]
    pub token_account: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token2022>,
}

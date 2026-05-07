use anchor_lang::prelude::*;
use anchor_spl::{
    token_2022::spl_token_2022::state::AccountState,
    token_interface::{
        default_account_state_initialize, default_account_state_update,
        DefaultAccountStateInitialize, DefaultAccountStateUpdate, Token2022,
    },
};

declare_id!("D4gKwUkfMhRbcxr2Enp3D7eQSf1jVdWbaGVm4nKmHZzk");

#[program]
pub mod t22_default_account_state {
    use super::*;

    /// Initialize the DefaultAccountState extension on a fresh mint.
    /// Sets newly-minted accounts to start in Frozen state.
    pub fn make_frozen_default(ctx: Context<MakeFrozenDefault>) -> Result<()> {
        default_account_state_initialize(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                DefaultAccountStateInitialize {
                    token_program_id: ctx.accounts.token_program.to_account_info(),
                    mint: ctx.accounts.mint.to_account_info(),
                },
            ),
            &AccountState::Frozen,
        )?;
        Ok(())
    }

    /// Switch the default state to Initialized so newly-minted
    /// accounts start unfrozen. Requires the mint's freeze_authority.
    pub fn unfreeze_default(ctx: Context<UnfreezeDefault>) -> Result<()> {
        default_account_state_update(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                DefaultAccountStateUpdate {
                    token_program_id: ctx.accounts.token_program.to_account_info(),
                    mint: ctx.accounts.mint.to_account_info(),
                    freeze_authority: ctx.accounts.freeze_authority.to_account_info(),
                },
            ),
            &AccountState::Initialized,
        )?;
        Ok(())
    }
}

#[derive(Accounts)]
pub struct MakeFrozenDefault<'info> {
    /// CHECK: Pre-allocated mint with DefaultAccountState extension space.
    #[account(mut)]
    pub mint: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token2022>,
}

#[derive(Accounts)]
pub struct UnfreezeDefault<'info> {
    pub freeze_authority: Signer<'info>,
    /// CHECK: Mint with DefaultAccountState extension already
    /// initialized AND base mint init'd with this signer as
    /// freeze_authority.
    #[account(mut)]
    pub mint: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token2022>,
}

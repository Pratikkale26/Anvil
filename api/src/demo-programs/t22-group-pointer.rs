use anchor_lang::prelude::*;
use anchor_spl::token_2022_extensions::{
    group_pointer_initialize, group_pointer_update,
    GroupPointerInitialize, GroupPointerUpdate,
};
use anchor_spl::token_interface::Token2022;

declare_id!("FpAhHvWnX7eHwGNpfxGc7YPiA3tfC84sTVXAm5biCwWR");

#[program]
pub mod t22_group_pointer {
    use super::*;

    /// Token-2022 GroupPointer extension init — EM2 Session 3
    /// differential. Mint must be pre-allocated with space for
    /// `[ExtensionType::GroupPointer]`. After this call, the
    /// `group_address` points at a TokenGroup account (or None);
    /// `authority` may later update the pointer.
    pub fn make_group_pointer(ctx: Context<MakeGroupPointer>) -> Result<()> {
        group_pointer_initialize(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                GroupPointerInitialize {
                    token_program_id: ctx.accounts.token_program.to_account_info(),
                    mint: ctx.accounts.mint.to_account_info(),
                },
            ),
            Some(ctx.accounts.payer.key()),
            Some(ctx.accounts.group_account.key()),
        )?;
        Ok(())
    }

    /// Token-2022 GroupPointer extension update — flips the
    /// group_address on an existing GroupPointer-enabled mint.
    pub fn update_group_pointer(ctx: Context<UpdateGroupPointer>) -> Result<()> {
        group_pointer_update(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                GroupPointerUpdate {
                    token_program_id: ctx.accounts.token_program.to_account_info(),
                    mint: ctx.accounts.mint.to_account_info(),
                    authority: ctx.accounts.authority.to_account_info(),
                },
            ),
            Some(ctx.accounts.new_group_account.key()),
        )?;
        Ok(())
    }
}

#[derive(Accounts)]
pub struct MakeGroupPointer<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    /// CHECK: Pre-allocated mint with extension space; Token-2022
    /// validates state on the CPI.
    #[account(mut)]
    pub mint: UncheckedAccount<'info>,
    /// CHECK: Group account address recorded in the pointer; the
    /// Token-2022 program writes the bytes without checking that the
    /// account exists or holds TokenGroup data.
    pub group_account: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token2022>,
}

#[derive(Accounts)]
pub struct UpdateGroupPointer<'info> {
    /// CHECK: The GroupPointer-enabled mint to update.
    #[account(mut)]
    pub mint: UncheckedAccount<'info>,
    /// The authority recorded during init — must sign the update.
    pub authority: Signer<'info>,
    /// CHECK: New group account address to write into the mint.
    pub new_group_account: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token2022>,
}

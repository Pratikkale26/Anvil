use anchor_lang::prelude::*;
use anchor_spl::token_2022_extensions::{
    group_member_pointer_initialize, group_member_pointer_update,
    GroupMemberPointerInitialize, GroupMemberPointerUpdate,
};
use anchor_spl::token_interface::Token2022;

declare_id!("3Y8d52oF7TL3vYDBWjWARyHQ46MNUQzBRTVa1Zw19u7c");

#[program]
pub mod t22_group_member_pointer {
    use super::*;

    /// Token-2022 GroupMemberPointer extension init — EM2 Session 3
    /// differential. Mint must be pre-allocated with space for
    /// `[ExtensionType::GroupMemberPointer]`.
    pub fn make_group_member_pointer(ctx: Context<MakeGroupMemberPointer>) -> Result<()> {
        group_member_pointer_initialize(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                GroupMemberPointerInitialize {
                    token_program_id: ctx.accounts.token_program.to_account_info(),
                    mint: ctx.accounts.mint.to_account_info(),
                },
            ),
            Some(ctx.accounts.payer.key()),
            Some(ctx.accounts.member_account.key()),
        )?;
        Ok(())
    }

    pub fn update_group_member_pointer(ctx: Context<UpdateGroupMemberPointer>) -> Result<()> {
        group_member_pointer_update(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                GroupMemberPointerUpdate {
                    token_program_id: ctx.accounts.token_program.to_account_info(),
                    mint: ctx.accounts.mint.to_account_info(),
                    authority: ctx.accounts.authority.to_account_info(),
                },
            ),
            Some(ctx.accounts.new_member_account.key()),
        )?;
        Ok(())
    }
}

#[derive(Accounts)]
pub struct MakeGroupMemberPointer<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    /// CHECK: Pre-allocated mint with extension space; Token-2022
    /// validates state on the CPI.
    #[account(mut)]
    pub mint: UncheckedAccount<'info>,
    /// CHECK: Member account address recorded in the pointer.
    pub member_account: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token2022>,
}

#[derive(Accounts)]
pub struct UpdateGroupMemberPointer<'info> {
    /// CHECK: The GroupMemberPointer-enabled mint to update.
    #[account(mut)]
    pub mint: UncheckedAccount<'info>,
    /// The authority recorded during init — must sign the update.
    pub authority: Signer<'info>,
    /// CHECK: New member account address.
    pub new_member_account: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token2022>,
}

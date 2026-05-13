use anchor_lang::prelude::*;
use anchor_spl::token_2022_extensions::{
    transfer_hook_initialize, transfer_hook_update,
    TransferHookInitialize, TransferHookUpdate,
};
use anchor_spl::token_interface::Token2022;

declare_id!("Ei3rChupo8BEWEnFZjVHEBRZvg1FmoVKM9kCnHJdXRFc");

#[program]
pub mod t22_transfer_hook {
    use super::*;

    /// Token-2022 TransferHook extension init — EM2 Session 2
    /// differential. Mint must be pre-allocated with space for
    /// `[ExtensionType::TransferHook]`. After this call, every
    /// `transfer_checked` against this mint will CPI into the
    /// `transfer_hook_program_id` for additional validation.
    pub fn make_transfer_hook(ctx: Context<MakeTransferHook>) -> Result<()> {
        transfer_hook_initialize(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                TransferHookInitialize {
                    token_program_id: ctx.accounts.token_program.to_account_info(),
                    mint: ctx.accounts.mint.to_account_info(),
                },
            ),
            Some(ctx.accounts.payer.key()),
            Some(ctx.accounts.hook_program.key()),
        )?;
        Ok(())
    }

    /// Token-2022 TransferHook extension update — flips the hook
    /// program id on an existing TransferHook-enabled mint. The
    /// authority that was set during init signs the update.
    pub fn update_transfer_hook(ctx: Context<UpdateTransferHook>) -> Result<()> {
        transfer_hook_update(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                TransferHookUpdate {
                    token_program_id: ctx.accounts.token_program.to_account_info(),
                    mint: ctx.accounts.mint.to_account_info(),
                    authority: ctx.accounts.authority.to_account_info(),
                },
            ),
            Some(ctx.accounts.new_hook_program.key()),
        )?;
        Ok(())
    }
}

#[derive(Accounts)]
pub struct MakeTransferHook<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    /// CHECK: Pre-allocated mint with extension space; Token-2022
    /// validates state on the CPI.
    #[account(mut)]
    pub mint: UncheckedAccount<'info>,
    /// CHECK: The hook program id we want to install on this mint.
    /// Just a pubkey — the Token-2022 program records it without
    /// validating that the account is a deployed program.
    pub hook_program: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token2022>,
}

#[derive(Accounts)]
pub struct UpdateTransferHook<'info> {
    /// CHECK: The TransferHook-enabled mint to update.
    #[account(mut)]
    pub mint: UncheckedAccount<'info>,
    /// The authority recorded during init — must sign the update.
    pub authority: Signer<'info>,
    /// CHECK: New hook program id to write into the mint.
    pub new_hook_program: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token2022>,
}

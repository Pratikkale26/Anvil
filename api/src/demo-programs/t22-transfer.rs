use anchor_lang::prelude::*;
use anchor_spl::token_interface::{self, TokenInterface, TokenAccount, Mint, TransferChecked};

declare_id!("4bejS8bLDMyJSshuJwWaf73ZKF9EASdUb71Y59E3NQX9");

#[program]
pub mod t22_transfer {
    use super::*;

    /// Token-2022 transfer_checked. The `_checked` variant requires the
    /// caller to pass mint + decimals so the program can verify it's
    /// transferring the expected denomination. Anvil's emit MUST resolve
    /// the decimals expression at parse time — the silent
    /// `0u8 /* TODO: decimals */` fallback corrupts on-chain transfers.
    pub fn do_transfer(ctx: Context<DoTransfer>, amount: u64) -> Result<()> {
        token_interface::transfer_checked(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                TransferChecked {
                    from: ctx.accounts.from.to_account_info(),
                    mint: ctx.accounts.mint.to_account_info(),
                    to: ctx.accounts.to.to_account_info(),
                    authority: ctx.accounts.authority.to_account_info(),
                },
            ),
            amount,
            ctx.accounts.mint.decimals,
        )?;
        Ok(())
    }
}

#[derive(Accounts)]
pub struct DoTransfer<'info> {
    pub mint: InterfaceAccount<'info, Mint>,
    #[account(mut)]
    pub from: InterfaceAccount<'info, TokenAccount>,
    #[account(mut)]
    pub to: InterfaceAccount<'info, TokenAccount>,
    pub authority: Signer<'info>,
    pub token_program: Interface<'info, TokenInterface>,
}

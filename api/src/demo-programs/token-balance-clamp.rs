use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};

declare_id!("ADMVc4SFrupMV9xMhagvQ1ALRPjPjALsMCVw2JYZRbus");

// Finding B gate — a payout CLAMPED by a token-balance read
// (`let bal = ctx.accounts.vault.amount;`). This read used to silently mangle
// to `0u64` on Pinocchio (resolved correctly on Native via the
// token_account_amount helper). With `bal == 0`, `requested.min(bal) == 0` →
// no transfer; with the real balance, the clamp behaves correctly. The
// byte-equal differential exercises a requested amount BELOW and ABOVE the
// vault balance, so the 0-vs-real difference shows up in the recipient's
// balance bytes on both branch paths.
#[program]
pub mod token_balance_clamp {
    use super::*;

    pub fn payout(ctx: Context<Payout>, requested: u64) -> Result<()> {
        let vault_balance = ctx.accounts.vault.amount;
        let actual = requested.min(vault_balance);
        if actual > 0 {
            token::transfer(
                CpiContext::new(
                    ctx.accounts.token_program.to_account_info(),
                    Transfer {
                        from: ctx.accounts.vault.to_account_info(),
                        to: ctx.accounts.recipient.to_account_info(),
                        authority: ctx.accounts.authority.to_account_info(),
                    },
                ),
                actual,
            )?;
        }
        Ok(())
    }
}

#[derive(Accounts)]
pub struct Payout<'info> {
    #[account(mut)]
    pub vault: Account<'info, TokenAccount>,
    #[account(mut)]
    pub recipient: Account<'info, TokenAccount>,
    pub authority: Signer<'info>,
    pub token_program: Program<'info, Token>,
}

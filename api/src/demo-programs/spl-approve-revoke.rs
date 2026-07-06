use anchor_lang::prelude::*;
use anchor_spl::token::{self, Approve, Revoke, Token, TokenAccount};

declare_id!("De1eg8teAppRove1111111111111111111111111111");

#[program]
pub mod delegate_token {
    use super::*;

    /// Approve a delegate for `amount` on the token account (cpi_spl_approve).
    pub fn delegate(ctx: Context<Delegate>, amount: u64) -> Result<()> {
        token::approve(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Approve {
                    to: ctx.accounts.token_account.to_account_info(),
                    delegate: ctx.accounts.delegate.to_account_info(),
                    authority: ctx.accounts.authority.to_account_info(),
                },
            ),
            amount,
        )?;
        Ok(())
    }

    /// Revoke the account's delegate (cpi_spl_revoke).
    pub fn undelegate(ctx: Context<Undelegate>) -> Result<()> {
        token::revoke(CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            Revoke {
                source: ctx.accounts.token_account.to_account_info(),
                authority: ctx.accounts.authority.to_account_info(),
            },
        ))?;
        Ok(())
    }
}

#[derive(Accounts)]
pub struct Delegate<'info> {
    #[account(mut)]
    pub token_account: Account<'info, TokenAccount>,
    /// CHECK: delegate pubkey only
    pub delegate: AccountInfo<'info>,
    pub authority: Signer<'info>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct Undelegate<'info> {
    #[account(mut)]
    pub token_account: Account<'info, TokenAccount>,
    pub authority: Signer<'info>,
    pub token_program: Program<'info, Token>,
}

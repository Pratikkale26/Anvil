use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};

declare_id!("2GMS2v2T4wqDwkfuZSmDcTKffxRKd63879ofy5J6vT34");

#[program]
pub mod spl_transfer {
    use super::*;

    /// Transfer `amount` tokens from `from` ATA to `to` ATA, signed by
    /// `authority`. Inline CpiContext so the parser detects this as
    /// cpi_spl_transfer (without `with_signer`).
    pub fn do_transfer(ctx: Context<DoTransfer>, amount: u64) -> Result<()> {
        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.from.to_account_info(),
                    to: ctx.accounts.to.to_account_info(),
                    authority: ctx.accounts.authority.to_account_info(),
                },
            ),
            amount,
        )?;
        Ok(())
    }
}

#[derive(Accounts)]
pub struct DoTransfer<'info> {
    #[account(mut)]
    pub from: Account<'info, TokenAccount>,
    #[account(mut)]
    pub to: Account<'info, TokenAccount>,
    pub authority: Signer<'info>,
    pub token_program: Program<'info, Token>,
}

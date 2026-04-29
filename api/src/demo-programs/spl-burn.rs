use anchor_lang::prelude::*;
use anchor_spl::token::{self, Burn, Mint, Token, TokenAccount};

declare_id!("2Ytt3TVz3AyEzWQCuSmoSZPyWqqvrF2Ko64rdWJgfcBN");

#[program]
pub mod spl_burn {
    use super::*;

    /// Burn `amount` tokens from `from`'s ATA, decrementing the mint's
    /// total supply. Inline CpiContext so the parser detects this as
    /// cpi_spl_burn (without `with_signer`).
    pub fn do_burn(ctx: Context<DoBurn>, amount: u64) -> Result<()> {
        token::burn(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Burn {
                    mint: ctx.accounts.mint.to_account_info(),
                    from: ctx.accounts.from.to_account_info(),
                    authority: ctx.accounts.authority.to_account_info(),
                },
            ),
            amount,
        )?;
        Ok(())
    }
}

#[derive(Accounts)]
pub struct DoBurn<'info> {
    #[account(mut)]
    pub mint: Account<'info, Mint>,
    #[account(mut)]
    pub from: Account<'info, TokenAccount>,
    pub authority: Signer<'info>,
    pub token_program: Program<'info, Token>,
}

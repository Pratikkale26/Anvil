use anchor_lang::prelude::*;
use anchor_spl::token_interface::{
    interest_bearing_mint_initialize, interest_bearing_mint_update_rate,
    InterestBearingMintInitialize, InterestBearingMintUpdateRate, Token2022,
};

declare_id!("6wowAPDC2z3aLJQy8yNPrZ7RWSThXpCBTKLgLG12JkaG");

#[program]
pub mod t22_interest_bearing {
    use super::*;

    /// Initialize an InterestBearing mint with a fixed rate.
    pub fn make_bearing(ctx: Context<MakeBearing>, rate: i16) -> Result<()> {
        interest_bearing_mint_initialize(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                InterestBearingMintInitialize {
                    token_program_id: ctx.accounts.token_program.to_account_info(),
                    mint: ctx.accounts.mint.to_account_info(),
                },
            ),
            Some(ctx.accounts.payer.key()),
            rate,
        )?;
        Ok(())
    }

    /// Update the interest rate. Requires the rate authority signer.
    pub fn change_rate(ctx: Context<ChangeRate>, rate: i16) -> Result<()> {
        interest_bearing_mint_update_rate(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                InterestBearingMintUpdateRate {
                    token_program_id: ctx.accounts.token_program.to_account_info(),
                    mint: ctx.accounts.mint.to_account_info(),
                    rate_authority: ctx.accounts.rate_authority.to_account_info(),
                },
            ),
            rate,
        )?;
        Ok(())
    }
}

#[derive(Accounts)]
pub struct MakeBearing<'info> {
    pub payer: Signer<'info>,
    /// CHECK: Pre-allocated mint with InterestBearingConfig extension space.
    #[account(mut)]
    pub mint: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token2022>,
}

#[derive(Accounts)]
pub struct ChangeRate<'info> {
    pub rate_authority: Signer<'info>,
    /// CHECK: Mint with InterestBearingConfig extension already initialized;
    /// rate_authority signer + Token-2022 program validate runtime state.
    #[account(mut)]
    pub mint: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token2022>,
}

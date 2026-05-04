// Demo: exercises the `sysvar_rent` BodyStatement kind via Rent::get().
// Programs that need to compute rent-exempt minimums for variable-size
// allocations or before native CreateAccount commonly call Rent::get();
// Anchor exposes this as a let binding the body classifier picks up.
// M3 coverage fixture.
use anchor_lang::prelude::*;

declare_id!("SysvRent11111111111111111111111111111111111");

#[program]
pub mod sysvar_rent {
    use super::*;

    pub fn record_min_balance(ctx: Context<Record>) -> Result<()> {
        let rent = Rent::get()?;
        let min_balance = rent.minimum_balance(StateAccount::INIT_SPACE + 8);
        let state = &mut ctx.accounts.state;
        state.min_balance = min_balance;
        Ok(())
    }
}

#[derive(Accounts)]
pub struct Record<'info> {
    #[account(
        init,
        payer = authority,
        space = 8 + StateAccount::INIT_SPACE,
        seeds = [b"sysvar-rent", authority.key().as_ref()],
        bump
    )]
    pub state: Account<'info, StateAccount>,
    #[account(mut)]
    pub authority: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[account]
#[derive(InitSpace)]
pub struct StateAccount {
    pub min_balance: u64,
}

use anchor_lang::prelude::*;

use crate::state::Counter;
use crate::errors::ProgramError;
use crate::MAX_VALUE;

#[derive(Accounts)]
pub struct UpdateValue<'info> {
    #[account(mut, has_one = authority)]
    pub counter: Account<'info, Counter>,
    pub authority: Signer<'info>,
}

pub fn handler(ctx: Context<UpdateValue>, new_value: u64) -> Result<()> {
    require!(new_value <= MAX_VALUE, ProgramError::ValueTooLarge);
    let counter = &mut ctx.accounts.counter;
    counter.value = new_value;
    Ok(())
}

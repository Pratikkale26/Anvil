use anchor_lang::prelude::*;

use crate::state::Counter;

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(init, payer = payer, space = 8 + Counter::LEN)]
    pub counter: Account<'info, Counter>,
    #[account(mut)]
    pub payer: Signer<'info>,
    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<Initialize>, value: u64) -> Result<()> {
    let counter = &mut ctx.accounts.counter;
    counter.value = value;
    counter.authority = ctx.accounts.payer.key();
    Ok(())
}

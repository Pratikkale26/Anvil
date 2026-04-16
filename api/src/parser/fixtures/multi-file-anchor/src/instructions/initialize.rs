use anchor_lang::prelude::*;

use crate::state::Initialize;

pub fn handler(ctx: Context<Initialize>, value: u64) -> Result<()> {
    let counter = &mut ctx.accounts.counter;
    counter.value = value;
    Ok(())
}

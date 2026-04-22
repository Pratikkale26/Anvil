use anchor_lang::prelude::*;

declare_id!("22222222222222222222222222222222");

mod state;
mod instructions;
mod errors;

use instructions::*;

pub const MAX_VALUE: u64 = 1_000_000;

#[program]
pub mod complex_program {
    use super::*;

    pub fn initialize(ctx: Context<Initialize>, value: u64) -> Result<()> {
        instructions::initialize::handler(ctx, value)
    }

    pub fn update(ctx: Context<UpdateValue>, new_value: u64) -> Result<()> {
        instructions::update::handler(ctx, new_value)
    }
}

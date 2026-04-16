use anchor_lang::prelude::*;

declare_id!("11111111111111111111111111111111");

mod state;
mod instructions;

use instructions::*;

#[program]
pub mod multi_file_anchor {
    use super::*;

    pub fn initialize(ctx: Context<Initialize>, value: u64) -> Result<()> {
        instructions::initialize::handler(ctx, value)
    }
}

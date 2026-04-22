use anchor_lang::prelude::*;

#[account]
pub struct Counter {
    pub value: u64,
    pub authority: Pubkey,
    pub bump: u8,
}

impl Counter {
    pub const LEN: usize = 8 + 32 + 1;
}

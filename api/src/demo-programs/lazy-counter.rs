use anchor_lang::prelude::*;

declare_id!("5WJSTh75J37jHrKN6wvDWTXk8v9BPvZ5d9Eo8FFSXWMG");

#[program]
pub mod lazy_counter {
    use super::*;

    /// Mutate a `LazyAccount<Counter>` via whole-struct `load_mut()` (task #19).
    /// LazyAccount is Borsh-lazy, so this is the same Borsh deserialize →
    /// mutate → write-back the mutable `Account<Counter>` path emits. The
    /// caller pre-allocates + pre-initialises the counter (disc + count).
    pub fn bump(ctx: Context<Bump>) -> Result<()> {
        let mut c = ctx.accounts.counter.load_mut()?;
        c.count = 42;
        Ok(())
    }
}

#[derive(Accounts)]
pub struct Bump<'info> {
    #[account(mut)]
    pub counter: LazyAccount<'info, Counter>,
    pub authority: Signer<'info>,
}

#[account]
pub struct Counter {
    pub count: u64,
}

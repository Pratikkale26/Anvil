// Event-emit differential fixture.
//
// Exercises Anchor's emit! macro: a counter program that emits an event
// every increment. The differential gate compares the `Program data: …`
// lines (sol_log_data outputs) between Anchor + Anvil-Pinocchio runs,
// asserting the borsh-encoded payload + 8-byte discriminator are
// byte-identical.

use anchor_lang::prelude::*;

declare_id!("evMit11111111111111111111111111111111111111");

#[program]
pub mod event_emit_demo {
    use super::*;

    pub fn initialize(ctx: Context<Initialize>) -> Result<()> {
        let counter = &mut ctx.accounts.counter;
        counter.value = 0;
        counter.bump = ctx.bumps.counter;
        Ok(())
    }

    pub fn increment(ctx: Context<Update>, amount: u64) -> Result<()> {
        let counter = &mut ctx.accounts.counter;
        counter.value = counter.value.checked_add(amount).ok_or(EventError::Overflow)?;
        emit!(Incremented {
            new_value: counter.value,
            delta: amount,
        });
        Ok(())
    }
}

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(
        init,
        payer = authority,
        space = 8 + 8 + 1,
        seeds = [b"evt-counter", authority.key().as_ref()],
        bump
    )]
    pub counter: Account<'info, EventCounter>,
    #[account(mut)]
    pub authority: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Update<'info> {
    #[account(
        mut,
        seeds = [b"evt-counter", authority.key().as_ref()],
        bump = counter.bump
    )]
    pub counter: Account<'info, EventCounter>,
    pub authority: Signer<'info>,
}

#[account]
pub struct EventCounter {
    pub value: u64,
    pub bump: u8,
}

#[event]
pub struct Incremented {
    pub new_value: u64,
    pub delta: u64,
}

#[error_code]
pub enum EventError {
    #[msg("Overflow")]
    Overflow,
}

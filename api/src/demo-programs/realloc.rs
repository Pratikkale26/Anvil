// Realloc differential fixture.
//
// Exercises Anchor's `realloc = expr` constraint: an existing PDA account
// gets its data buffer resized + rent topped up by the system_program.
// Two-call scenario: init creates the account at minimum size with an
// empty Vec<u8>, then `append` grows it by one byte (8 + 4 + 1 = 13 bytes
// → 8 + 4 + 2 = 14 bytes) via `realloc = 8 + 4 + log.len() + 1`.
//
// The byte-equal compare validates that:
//   1. Realloc grows the buffer to the right size on both targets
//   2. The Vec<u8> push round-trips identically through borsh re-serialize
//   3. Rent delta is moved between the same source + destination on both
//      sides (no off-by-one lamport divergence)

use anchor_lang::prelude::*;

declare_id!("rea11oc111111111111111111111111111111111111");

#[program]
pub mod realloc_demo {
    use super::*;

    pub fn init(ctx: Context<Init>) -> Result<()> {
        let s = &mut ctx.accounts.state;
        s.bump = ctx.bumps.state;
        s.log = vec![];
        Ok(())
    }

    pub fn append(ctx: Context<Append>, byte: u8) -> Result<()> {
        let s = &mut ctx.accounts.state;
        s.log.push(byte);
        Ok(())
    }
}

#[derive(Accounts)]
pub struct Init<'info> {
    #[account(
        init,
        payer = owner,
        space = 8 + 1 + 4,
        seeds = [b"realloc-st", owner.key().as_ref()],
        bump
    )]
    pub state: Account<'info, LogState>,
    #[account(mut)]
    pub owner: Signer<'info>,
    pub system_program: Program<'info, System>,
}

// Append uses `realloc = 8 + 1 + 4 + state.log.len() + 1`. Anchor's
// macro deserializes `state` before evaluating the realloc expression;
// Anvil's emit replicates this by detecting state-field references in
// the size expression and emitting a from_account_info() call inside
// the new-size scope before the realloc CPI fires.
#[derive(Accounts)]
pub struct Append<'info> {
    #[account(
        mut,
        seeds = [b"realloc-st", owner.key().as_ref()],
        bump = state.bump,
        realloc = 8 + 1 + 4 + state.log.len() + 1,
        realloc::payer = owner,
        realloc::zero = false,
    )]
    pub state: Account<'info, LogState>,
    #[account(mut)]
    pub owner: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[account]
pub struct LogState {
    pub bump: u8,
    pub log: Vec<u8>,
}

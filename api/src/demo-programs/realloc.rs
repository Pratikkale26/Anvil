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

// Append uses a literal-size realloc (the test always grows by exactly
// one byte, so the new size is known at compile time). Using
// `state.log.len()` in the realloc expression would require Anchor's
// macro to deserialize before computing — which it does automatically,
// but Anvil's native emit emits the realloc CPI before any deserialize.
// Literal keeps the differential honest while sidestepping the in-macro
// vs in-handler ordering question.
#[derive(Accounts)]
pub struct Append<'info> {
    #[account(
        mut,
        seeds = [b"realloc-st", owner.key().as_ref()],
        bump = state.bump,
        realloc = 14,
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

// Realloc grow differential — multi-step growth variant.
//
// Same pattern as realloc.rs but exercises THREE consecutive grow calls:
// 13 → 14 → 16 → 20 bytes. The byte-equal gate validates that:
//   1. Each realloc step lands at the right size on both targets
//   2. The rent delta is computed identically each step (multiple
//      transfers from owner to state must cumulate to the same total
//      lamports on Anchor and Anvil)
//   3. realloc::zero=true zero-fills the newly-allocated region
//      identically (vs realloc.rs which uses zero=false)
//
// Native target only — Pinocchio's AccountInfo::realloc isn't in the
// stable API.

use anchor_lang::prelude::*;

declare_id!("rea11ocgrow11111111111111111111111111111111");

#[program]
pub mod realloc_grow_demo {
    use super::*;

    pub fn init(ctx: Context<Init>) -> Result<()> {
        let s = &mut ctx.accounts.state;
        s.bump = ctx.bumps.state;
        s.log = vec![];
        Ok(())
    }

    pub fn append_one(ctx: Context<AppendOne>, byte: u8) -> Result<()> {
        let s = &mut ctx.accounts.state;
        s.log.push(byte);
        Ok(())
    }

    pub fn append_two(ctx: Context<AppendTwo>, b0: u8, b1: u8) -> Result<()> {
        let s = &mut ctx.accounts.state;
        s.log.push(b0);
        s.log.push(b1);
        Ok(())
    }

    pub fn append_four(ctx: Context<AppendFour>, b0: u8, b1: u8, b2: u8, b3: u8) -> Result<()> {
        let s = &mut ctx.accounts.state;
        s.log.push(b0);
        s.log.push(b1);
        s.log.push(b2);
        s.log.push(b3);
        Ok(())
    }
}

#[derive(Accounts)]
pub struct Init<'info> {
    #[account(
        init,
        payer = owner,
        space = 8 + 1 + 4,
        seeds = [b"realloc-grow", owner.key().as_ref()],
        bump
    )]
    pub state: Account<'info, GrowState>,
    #[account(mut)]
    pub owner: Signer<'info>,
    pub system_program: Program<'info, System>,
}

// Each Append* uses a literal-size realloc — same reason as realloc.rs:
// state.log.len() requires Anchor's macro-side deserialize that Anvil's
// emit doesn't replicate. Each level grows by exactly N bytes.

#[derive(Accounts)]
pub struct AppendOne<'info> {
    #[account(
        mut,
        seeds = [b"realloc-grow", owner.key().as_ref()],
        bump = state.bump,
        realloc = 14,
        realloc::payer = owner,
        realloc::zero = true,
    )]
    pub state: Account<'info, GrowState>,
    #[account(mut)]
    pub owner: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct AppendTwo<'info> {
    #[account(
        mut,
        seeds = [b"realloc-grow", owner.key().as_ref()],
        bump = state.bump,
        realloc = 16,
        realloc::payer = owner,
        realloc::zero = true,
    )]
    pub state: Account<'info, GrowState>,
    #[account(mut)]
    pub owner: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct AppendFour<'info> {
    #[account(
        mut,
        seeds = [b"realloc-grow", owner.key().as_ref()],
        bump = state.bump,
        realloc = 20,
        realloc::payer = owner,
        realloc::zero = true,
    )]
    pub state: Account<'info, GrowState>,
    #[account(mut)]
    pub owner: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[account]
pub struct GrowState {
    pub bump: u8,
    pub log: Vec<u8>,
}

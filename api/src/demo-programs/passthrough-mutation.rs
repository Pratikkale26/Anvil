use anchor_lang::prelude::*;

declare_id!("PassMut111111111111111111111111111111111111");

// Regression fixture for the pass-through state-mutation silent-loss class
// (prod-readiness eval 2026-06-21, #11). `copy_from_slice` and a `&mut` deref
// mutate state fields without an `acc.field =` assignment — pre-fix the
// detector missed them, so the hoisted writeback was skipped and the mutation
// was computed in a local that was never persisted.
#[program]
pub mod passthrough_mutation {
    use super::*;

    pub fn initialize(_ctx: Context<Initialize>) -> Result<()> {
        Ok(())
    }

    pub fn mutate(ctx: Context<Mutate>, value: u64) -> Result<()> {
        let acc = &mut ctx.accounts.acc;
        acc.blob.copy_from_slice(&value.to_le_bytes()); // copy_from_slice path
        let r = &mut acc.counter;                       // &mut deref path
        *r = r.wrapping_add(value);
        Ok(())
    }
}

#[account]
pub struct Blob {
    pub blob: [u8; 8],
    pub counter: u64,
}

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(init, payer = payer, space = 8 + 8 + 8)]
    pub acc: Account<'info, Blob>,
    #[account(mut)]
    pub payer: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Mutate<'info> {
    #[account(mut)]
    pub acc: Account<'info, Blob>,
}

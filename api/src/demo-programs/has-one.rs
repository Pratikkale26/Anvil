use anchor_lang::prelude::*;

declare_id!("Absfps8DboaQrCi71THcW4r1CuhrQLokx6DVufbnDmUZ");

#[program]
pub mod has_one_demo {
    use super::*;

    pub fn initialize(ctx: Context<Initialize>) -> Result<()> {
        let safe = &mut ctx.accounts.safe;
        safe.owner = ctx.accounts.owner.key();
        safe.value = 0;
        Ok(())
    }

    /// Increments `safe.value`. The has_one constraint forces
    /// `safe.owner == owner.key`; if the wrong owner signs, Anchor
    /// returns ConstraintHasOne — Anvil emits the equivalent runtime
    /// check. Both must reject the wrong-owner case identically.
    pub fn bump_value(ctx: Context<BumpValue>, by: u64) -> Result<()> {
        ctx.accounts.safe.value = ctx.accounts.safe.value.saturating_add(by);
        Ok(())
    }
}

#[account]
pub struct Safe {
    pub owner: Pubkey,
    pub value: u64,
}

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(init, payer = owner, space = 8 + 32 + 8)]
    pub safe: Account<'info, Safe>,
    #[account(mut)]
    pub owner: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct BumpValue<'info> {
    #[account(mut, has_one = owner)]
    pub safe: Account<'info, Safe>,
    pub owner: Signer<'info>,
}

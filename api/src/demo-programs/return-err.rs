// Demo: exercises the `return_err` BodyStatement kind via `return Err(...)`.
// Distinct from `require!(...)` (which lowers to a separate `require` IR
// kind) and from the implicit `Ok(())` (return_ok). M3 coverage fixture.
use anchor_lang::prelude::*;

declare_id!("ReturnErr1111111111111111111111111111111111");

#[program]
pub mod return_err {
    use super::*;

    pub fn try_set(ctx: Context<TrySet>, value: u64) -> Result<()> {
        if value == 0 {
            return Err(DemoError::ZeroNotAllowed.into());
        }
        let state = &mut ctx.accounts.state;
        state.value = value;
        Ok(())
    }

    /// Always-fail handler — the body classifier only picks up `return_err`
    /// at the top level (return inside `if` is pass_through). This handler
    /// guarantees the kind is produced regardless of branching shape.
    pub fn always_fails(_ctx: Context<TrySet>) -> Result<()> {
        return Err(DemoError::ZeroNotAllowed.into());
    }
}

#[derive(Accounts)]
pub struct TrySet<'info> {
    #[account(
        init_if_needed,
        payer = authority,
        space = 8 + StateAccount::INIT_SPACE,
        seeds = [b"return-err", authority.key().as_ref()],
        bump
    )]
    pub state: Account<'info, StateAccount>,
    #[account(mut)]
    pub authority: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[account]
#[derive(InitSpace)]
pub struct StateAccount {
    pub value: u64,
}

#[error_code]
pub enum DemoError {
    #[msg("Zero is not allowed")]
    ZeroNotAllowed,
}

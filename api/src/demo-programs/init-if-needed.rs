// init_if_needed differential fixture.
//
// Exercises Anchor's `init_if_needed` constraint family: an instruction that
// can be called multiple times with the same accounts — first call inits
// the PDA, subsequent calls just mutate it. The emitter has to generate
// a runtime branch (account empty? init : read) instead of unconditional
// default-init that overwrites pre-existing state.
//
// State: a per-user profile holding visit_count + last_visit_ts, both
// updated on every call. A test that calls visit() twice should see
// count=2 with state from the first call preserved across the second.

use anchor_lang::prelude::*;

declare_id!("initifneeded1111111111111111111111111111111");

#[program]
pub mod init_if_needed_demo {
    use super::*;

    pub fn visit(ctx: Context<Visit>) -> Result<()> {
        // Use the on-chain clock as the timestamp source. The previous
        // version accepted a `ts: i64` arg, which trusted client input —
        // production programs must read Clock::get() so timestamps reflect
        // actual block time, not whatever the caller wants to claim.
        // Differential tests pin the LiteSVM clock so both Anchor and
        // Anvil runs read the same value byte-for-byte.
        let clock = Clock::get()?;
        let profile = &mut ctx.accounts.profile;
        profile.user = ctx.accounts.user.key();
        profile.visit_count = profile.visit_count.checked_add(1).ok_or(VisitError::Overflow)?;
        profile.last_visit_ts = clock.unix_timestamp;
        Ok(())
    }
}

#[derive(Accounts)]
pub struct Visit<'info> {
    #[account(
        init_if_needed,
        payer = user,
        space = 8 + VisitProfile::INIT_SPACE,
        seeds = [b"profile", user.key().as_ref()],
        bump
    )]
    pub profile: Account<'info, VisitProfile>,
    #[account(mut)]
    pub user: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[account]
#[derive(InitSpace)]
pub struct VisitProfile {
    pub user: Pubkey,
    pub visit_count: u64,
    pub last_visit_ts: i64,
}

#[error_code]
pub enum VisitError {
    #[msg("Visit count overflow")]
    Overflow,
}

// Demo: exercises the `bumps_access` BodyStatement kind via
// `let bump = ctx.bumps.X;` shape — the canonical PDA bump-extraction
// pattern Anchor produces for handlers that need to sign with the bump
// after the canonical-bump derivation. M3 coverage fixture.
use anchor_lang::prelude::*;

declare_id!("BumpsAcc11111111111111111111111111111111111");

#[program]
pub mod bumps_access {
    use super::*;

    pub fn initialize(ctx: Context<Initialize>) -> Result<()> {
        let bump = ctx.bumps.state;
        let state = &mut ctx.accounts.state;
        state.authority = ctx.accounts.authority.key();
        state.bump = bump;
        Ok(())
    }
}

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(
        init,
        payer = authority,
        space = 8 + StateAccount::INIT_SPACE,
        seeds = [b"bumps-access", authority.key().as_ref()],
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
    pub authority: Pubkey,
    pub bump: u8,
}

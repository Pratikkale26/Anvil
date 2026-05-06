//! Regex-pattern fixture: `*X.key` deref strip in comparison context.
//!
//! Locks the behavior of the body-walker post-process at
//! body-emitter/walker.ts:236-252. When `*X.key` (or `*X.key()`) appears
//! in a comparison whose sibling is `&<expr>`, the deref is stripped so
//! both sides remain `&Pubkey == &Pubkey` instead of the asymmetric
//! `&Pubkey == Pubkey`. Closure-param shapes (Vec<Pubkey>::iter()
//! yielding `&Pubkey`) are handled by the same regex group.
//!
//! The fixture covers two trigger shapes from the same file:
//!   1. Explicit `&` LHS in if-condition
//!   2. Closure body in iter().any() / position()
//!
//! Both targets exercise this path — walker.ts is target-agnostic.
use anchor_lang::prelude::*;

declare_id!("DerefCm11111111111111111111111111111111111");

#[program]
pub mod deref_strip_comparison_pattern {
    use super::*;

    pub fn approve(ctx: Context<Approve>) -> Result<()> {
        let proposal = &mut ctx.accounts.proposal;
        let signer_key = ctx.accounts.signer.key();
        // Shape 1: explicit `&` LHS comparison.
        if &signer_key == ctx.accounts.signer.key {
            proposal.approvals = proposal.approvals.saturating_add(1);
        }
        // Shape 2: closure-param comparison (iter yields &Pubkey).
        let already = proposal
            .signers
            .iter()
            .any(|s| s == ctx.accounts.signer.key);
        if !already {
            proposal.signers.push(signer_key);
        }
        Ok(())
    }
}

#[account]
#[derive(InitSpace)]
pub struct Proposal {
    pub approvals: u32,
    #[max_len(8)]
    pub signers: Vec<Pubkey>,
}

#[derive(Accounts)]
pub struct Approve<'info> {
    #[account(mut)]
    pub proposal: Account<'info, Proposal>,
    pub signer: Signer<'info>,
}

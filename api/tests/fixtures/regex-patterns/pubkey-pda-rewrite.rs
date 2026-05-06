//! Regex-pattern fixture: `Pubkey::find_program_address` rewrite on Pinocchio.
//!
//! Locks the behavior of pinocchio-emitter.ts:1120 — Pinocchio's Pubkey
//! is `[u8; 32]` (a type alias, not a struct), so it has no associated
//! methods. Source-level `Pubkey::find_program_address(...)` and
//! `Pubkey::create_program_address(...)` need to route to standalone
//! fns at `pinocchio::pubkey::*`. Native target leaves the calls as-is
//! (solana-program ships a struct-typed Pubkey with these methods),
//! so the snapshot captures the divergence between targets — exactly
//! the kind of target-specific rewrite the AST migration must
//! preserve.
//!
//! This swap (instead of the `&mut Pubkey` deref-strip the original
//! plan called out) was advisor-validated: `&mut Pubkey` doesn't have
//! a dedicated post-process site, while the Pubkey associated-method
//! rewrite does — exactly one regex on pinocchio-emitter.ts:1120.
use anchor_lang::prelude::*;

declare_id!("PkPda111111111111111111111111111111111111");

#[program]
pub mod pubkey_pda_rewrite_pattern {
    use super::*;

    pub fn check_pda(ctx: Context<CheckPda>, seed: Vec<u8>) -> Result<()> {
        let (derived, _bump) = Pubkey::find_program_address(
            &[b"counter", seed.as_ref()],
            ctx.program_id,
        );
        if derived != ctx.accounts.candidate.key() {
            return Err(error!(PdaError::Mismatch));
        }
        Ok(())
    }
}

#[derive(Accounts)]
pub struct CheckPda<'info> {
    /// CHECK: candidate PDA being verified
    pub candidate: AccountInfo<'info>,
}

#[error_code]
pub enum PdaError {
    #[msg("PDA mismatch")]
    Mismatch,
}

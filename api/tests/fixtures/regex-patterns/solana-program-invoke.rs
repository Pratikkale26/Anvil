//! Regex-pattern fixture: solana_program::program::invoke commentout.
//!
//! Locks the behavior of `commentOutSolanaProgramInvoke` in
//! pinocchio-emitter.ts. Direct calls to
//! `solana_program::program::invoke{,_signed}(...)` cannot be retargeted
//! to pinocchio (different Instruction/AccountMeta types, different CPI
//! entry point), so they're commented out together with the
//! `let mut ix: Instruction = …;` setup that feeds them and any
//! `ix.accounts = …` mutations on the now-dead binding.
//!
//! Source uses the qualified `solana_program::program::invoke` form so
//! the regex `SOLANA_INVOKE_RE` matches; native target keeps the call
//! site (different post-process layer) so this fixture exercises both
//! native pass-through AND pinocchio commentout shapes.
use anchor_lang::prelude::*;
use anchor_lang::solana_program::instruction::{AccountMeta, Instruction};

declare_id!("SpInv1111111111111111111111111111111111111");

#[program]
pub mod solana_program_invoke_pattern {
    use super::*;

    pub fn raw_invoke(ctx: Context<RawInvoke>, payload: Vec<u8>) -> Result<()> {
        let ix = Instruction {
            program_id: *ctx.accounts.target_program.key,
            accounts: vec![
                AccountMeta::new(*ctx.accounts.target_account.key, false),
                AccountMeta::new_readonly(*ctx.accounts.authority.key, true),
            ],
            data: payload,
        };
        anchor_lang::solana_program::program::invoke(
            &ix,
            &[
                ctx.accounts.target_account.to_account_info(),
                ctx.accounts.authority.to_account_info(),
                ctx.accounts.target_program.to_account_info(),
            ],
        )?;
        Ok(())
    }
}

#[derive(Accounts)]
pub struct RawInvoke<'info> {
    /// CHECK: arbitrary CPI target
    #[account(mut)]
    pub target_account: AccountInfo<'info>,
    pub authority: Signer<'info>,
    /// CHECK: arbitrary CPI program
    pub target_program: AccountInfo<'info>,
}

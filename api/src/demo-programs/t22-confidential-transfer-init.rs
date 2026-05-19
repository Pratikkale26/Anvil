//! Token-2022 Confidential Transfer extension — initialize_mint (task #49).
//!
//! Wire-format-only init: enables the confidential-transfer extension on
//! a mint with a Pod-typed payload (no zk-proofs). Actual confidential
//! Configure / Transfer / Deposit / Withdraw operations are out of scope
//! v1 — they require a companion ProofInstruction CPI to the zk-program.

use anchor_lang::prelude::*;
use spl_token_2022::extension::confidential_transfer;
use solana_program::program::invoke;

declare_id!("7EPEQWHoYysCt5PtVXVsi3jmgteWXScfnnRjLLCLZTYY");

#[program]
pub mod t22_confidential_transfer_init_demo {
    use super::*;

    pub fn init_no_auditor(ctx: Context<InitCtMint>) -> Result<()> {
        invoke(
            &confidential_transfer::instruction::initialize_mint(
                &ctx.accounts.token_program.key(),
                &ctx.accounts.mint.key(),
                Some(ctx.accounts.authority.key()),
                true,
                None,
            )?,
            &[ctx.accounts.mint.to_account_info()],
        )?;
        Ok(())
    }
}

#[derive(Accounts)]
pub struct InitCtMint<'info> {
    /// CHECK: mint (writable)
    #[account(mut)]
    pub mint: AccountInfo<'info>,
    /// CHECK: authority pubkey
    pub authority: AccountInfo<'info>,
    /// CHECK: token-2022 program
    pub token_program: AccountInfo<'info>,
}

// MagicBlock Ephemeral Rollups counter — modeled on
// magicblock-labs/magicblock-engine-examples `counter/anchor`
// (ephemeral-rollups-sdk 0.16.2). Exercises the full supported catalog:
//   #[ephemeral]  → injected process_undelegation callback
//   #[delegate]   → companion accounts + delegate_pda() method call
//   #[commit]     → magic_program / magic_context injection
//   commit_accounts(...)            (classic ephem API, 5-arg form)
//   MagicIntentBundleBuilder chain  (modern API, commit_and_undelegate)
use anchor_lang::prelude::*;
use ephemeral_rollups_sdk::anchor::{commit, delegate, ephemeral};
use ephemeral_rollups_sdk::cpi::DelegateConfig;
use ephemeral_rollups_sdk::ephem::{commit_accounts, MagicIntentBundleBuilder};

declare_id!("79sGyNW41g8TrKyQwk7SZu432SH9ZfHmtRzEtR6CSt3n");

pub const COUNTER_SEED: &[u8] = b"mb_counter";

#[ephemeral]
#[program]
pub mod magicblock_counter {
    use super::*;

    /// Initialize the counter PDA.
    pub fn initialize(ctx: Context<Initialize>) -> Result<()> {
        let counter = &mut ctx.accounts.counter;
        counter.count = 0;
        Ok(())
    }

    /// Increment the counter (runs on base layer or inside the ER).
    pub fn increment(ctx: Context<Increment>) -> Result<()> {
        let counter = &mut ctx.accounts.counter;
        counter.count += 1;
        Ok(())
    }

    /// Delegate the counter PDA to the MagicBlock delegation program.
    pub fn delegate(ctx: Context<DelegateInput>) -> Result<()> {
        ctx.accounts.delegate_pda(
            &ctx.accounts.payer,
            &[COUNTER_SEED],
            DelegateConfig::default(),
        )?;
        Ok(())
    }

    /// Manual commit of the counter state in the ER (classic ephem API).
    pub fn commit(ctx: Context<IncrementAndCommit>) -> Result<()> {
        commit_accounts(
            &ctx.accounts.payer,
            vec![&ctx.accounts.counter.to_account_info()],
            &ctx.accounts.magic_context,
            &ctx.accounts.magic_program,
            None,
        )?;
        Ok(())
    }

    /// Increment, then commit + undelegate via the modern intent-bundle API.
    pub fn increment_and_undelegate(ctx: Context<IncrementAndCommit>) -> Result<()> {
        let counter = &mut ctx.accounts.counter;
        counter.count += 1;
        MagicIntentBundleBuilder::new(
            ctx.accounts.payer.to_account_info(),
            ctx.accounts.magic_context.to_account_info(),
            ctx.accounts.magic_program.to_account_info(),
        )
        .commit_and_undelegate(&[ctx.accounts.counter.to_account_info()])
        .build_and_invoke()?;
        Ok(())
    }
}

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(init, payer = user, space = 8 + 8, seeds = [COUNTER_SEED], bump)]
    pub counter: Account<'info, Counter>,
    #[account(mut)]
    pub user: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Increment<'info> {
    #[account(mut, seeds = [COUNTER_SEED], bump)]
    pub counter: Account<'info, Counter>,
}

/// #[delegate] injects buffer_pda / delegation_record_pda /
/// delegation_metadata_pda companions + owner_program / delegation_program /
/// system_program tail fields, and generates delegate_pda().
#[delegate]
#[derive(Accounts)]
pub struct DelegateInput<'info> {
    pub payer: Signer<'info>,
    /// CHECK: the counter PDA to delegate
    #[account(mut, del)]
    pub pda: UncheckedAccount<'info>,
}

/// #[commit] injects magic_program + magic_context.
#[commit]
#[derive(Accounts)]
pub struct IncrementAndCommit<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(mut, seeds = [COUNTER_SEED], bump)]
    pub counter: Account<'info, Counter>,
}

#[account]
pub struct Counter {
    pub count: u64,
}

// Multisig n-of-m differential fixture.
//
// Exercises: Vec<Pubkey> and Vec<bool> account fields, has_one constraint
// against multiple owner pubkeys, runtime quorum check on signer count.
// The 2-of-3 scenario in the test creates a transaction proposal, has
// owner-1 and owner-2 approve it, then executes — the byte-equal compare
// asserts the proposal account's `approved: Vec<bool>` ends up [true, true,
// false] in both Anchor and Anvil-Pinocchio runs.

use anchor_lang::prelude::*;

declare_id!("MuLtisig11111111111111111111111111111111111");

#[program]
pub mod multisig_demo {
    use super::*;

    pub fn create(ctx: Context<Create>, owners: Vec<Pubkey>, threshold: u8) -> Result<()> {
        require!(threshold > 0 && (threshold as usize) <= owners.len(), MultisigError::InvalidThreshold);
        require!(owners.len() <= 8, MultisigError::TooManyOwners);
        let m = &mut ctx.accounts.multisig;
        m.owners = owners;
        m.threshold = threshold;
        m.proposal_count = 0;
        m.bump = ctx.bumps.multisig;
        Ok(())
    }

    pub fn propose(ctx: Context<Propose>, proposal_id: u64, amount: u64) -> Result<()> {
        // proposal_id is bound to the seed via #[instruction(proposal_id)].
        let _ = proposal_id;
        let m = &ctx.accounts.multisig;
        let p = &mut ctx.accounts.proposal;
        // Reject if proposer isn't an owner.
        let proposer_key = ctx.accounts.proposer.key();
        let is_owner = m.owners.iter().any(|o| o == &proposer_key);
        require!(is_owner, MultisigError::NotAnOwner);
        p.multisig = m.key();
        p.amount = amount;
        p.approved = vec![false; m.owners.len()];
        p.executed = false;
        p.bump = ctx.bumps.proposal;
        Ok(())
    }

    pub fn approve(ctx: Context<Approve>) -> Result<()> {
        let m = &ctx.accounts.multisig;
        let p = &mut ctx.accounts.proposal;
        require!(!p.executed, MultisigError::AlreadyExecuted);
        let signer_key = ctx.accounts.signer.key();
        let idx = m.owners.iter().position(|o| o == &signer_key)
            .ok_or(MultisigError::NotAnOwner)?;
        p.approved[idx] = true;
        Ok(())
    }

    pub fn execute(ctx: Context<Execute>) -> Result<()> {
        let m = &ctx.accounts.multisig;
        let p = &mut ctx.accounts.proposal;
        require!(!p.executed, MultisigError::AlreadyExecuted);
        // Gate execute on the executor being one of the multisig owners.
        // Without this, any signer could call execute once the threshold
        // was met — fine for a demo, but not idiomatic; real programs
        // should also enforce executor membership.
        let executor_key = ctx.accounts.executor.key();
        let is_owner = m.owners.iter().any(|o| o == &executor_key);
        require!(is_owner, MultisigError::NotAnOwner);
        let approval_count: u8 = p.approved.iter().filter(|&&a| a).count() as u8;
        require!(approval_count >= m.threshold, MultisigError::NotEnoughApprovals);
        p.executed = true;
        Ok(())
    }
}

#[derive(Accounts)]
pub struct Create<'info> {
    // Space: 8 disc + 4 vec-len + 32*8 owners + 1 threshold + 8 proposal_count + 1 bump.
    // The previous calc had an extraneous +32 from a now-removed field.
    #[account(
        init,
        payer = payer,
        space = 8 + 4 + 32 * 8 + 1 + 8 + 1,
        seeds = [b"multisig", payer.key().as_ref()],
        bump
    )]
    pub multisig: Account<'info, MultisigAccount>,
    #[account(mut)]
    pub payer: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(proposal_id: u64)]
pub struct Propose<'info> {
    #[account(seeds = [b"multisig", multisig_payer.key().as_ref()], bump = multisig.bump)]
    pub multisig: Account<'info, MultisigAccount>,
    /// CHECK: just the seed source for multisig PDA
    pub multisig_payer: AccountInfo<'info>,
    #[account(
        init,
        payer = proposer,
        space = 256,
        seeds = [b"proposal", multisig.key().as_ref(), &proposal_id.to_le_bytes()],
        bump
    )]
    pub proposal: Account<'info, ProposalAccount>,
    #[account(mut)]
    pub proposer: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Approve<'info> {
    #[account(seeds = [b"multisig", multisig_payer.key().as_ref()], bump = multisig.bump)]
    pub multisig: Account<'info, MultisigAccount>,
    /// CHECK: seed source
    pub multisig_payer: AccountInfo<'info>,
    #[account(mut, has_one = multisig)]
    pub proposal: Account<'info, ProposalAccount>,
    pub signer: Signer<'info>,
}

#[derive(Accounts)]
pub struct Execute<'info> {
    #[account(seeds = [b"multisig", multisig_payer.key().as_ref()], bump = multisig.bump)]
    pub multisig: Account<'info, MultisigAccount>,
    /// CHECK: seed source
    pub multisig_payer: AccountInfo<'info>,
    #[account(mut, has_one = multisig)]
    pub proposal: Account<'info, ProposalAccount>,
    pub executor: Signer<'info>,
}

#[account]
pub struct MultisigAccount {
    pub owners: Vec<Pubkey>,
    pub threshold: u8,
    pub proposal_count: u64,
    pub bump: u8,
}

#[account]
pub struct ProposalAccount {
    pub multisig: Pubkey,
    pub amount: u64,
    pub approved: Vec<bool>,
    pub executed: bool,
    pub bump: u8,
}

#[error_code]
pub enum MultisigError {
    #[msg("Threshold must be > 0 and ≤ owners.len()")]
    InvalidThreshold,
    #[msg("Too many owners (max 8)")]
    TooManyOwners,
    #[msg("Signer is not an owner")]
    NotAnOwner,
    #[msg("Proposal already executed")]
    AlreadyExecuted,
    #[msg("Not enough approvals to reach threshold")]
    NotEnoughApprovals,
}

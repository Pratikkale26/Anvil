use anchor_lang::prelude::*;
use anchor_lang::solana_program::clock::Clock;

declare_id!("Stake11111111111111111111111111111111111111");

#[program]
pub mod simple_staking {
    use super::*;

    pub fn initialize_stake(ctx: Context<InitializeStake>, reward_rate: u64) -> Result<()> {
        let clock = Clock::get()?;
        let now = clock.unix_timestamp;
        let stake = &mut ctx.accounts.stake;
        stake.owner = ctx.accounts.user.key();
        stake.reward_rate = reward_rate;
        stake.amount = 0;
        stake.last_claim = now;
        stake.accumulated_rewards = 0;
        msg!("stake initialized");
        Ok(())
    }

    pub fn deposit(ctx: Context<UpdateStake>, amount: u64) -> Result<()> {
        let clock = Clock::get()?;
        let now = clock.unix_timestamp;
        let stake = &mut ctx.accounts.stake;
        let elapsed = (now - stake.last_claim) as u64;
        let earned = stake.amount
            .saturating_mul(elapsed)
            .saturating_mul(stake.reward_rate) / 1_000_000;
        stake.accumulated_rewards = stake.accumulated_rewards.saturating_add(earned);
        stake.amount = stake.amount.saturating_add(amount);
        stake.last_claim = now;
        emit!(StakeUpdated {
            owner: stake.owner,
            new_amount: stake.amount,
            earned_this_period: earned,
            timestamp: now,
        });
        msg!("deposit recorded");
        Ok(())
    }

    pub fn claim(ctx: Context<UpdateStake>) -> Result<()> {
        let clock = Clock::get()?;
        let now = clock.unix_timestamp;
        let stake = &mut ctx.accounts.stake;
        let elapsed = (now - stake.last_claim) as u64;
        let earned = stake.amount
            .saturating_mul(elapsed)
            .saturating_mul(stake.reward_rate) / 1_000_000;
        let total = stake.accumulated_rewards.saturating_add(earned);
        stake.accumulated_rewards = 0;
        stake.last_claim = now;
        emit!(RewardsClaimed {
            owner: stake.owner,
            amount: total,
            timestamp: now,
        });
        msg!("rewards claimed");
        Ok(())
    }
}

#[derive(Accounts)]
pub struct InitializeStake<'info> {
    #[account(
        init,
        payer = user,
        space = 8 + UserStake::LEN,
        seeds = [b"stake", user.key().as_ref()],
        bump
    )]
    pub stake: Account<'info, UserStake>,
    #[account(mut)]
    pub user: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct UpdateStake<'info> {
    #[account(
        mut,
        seeds = [b"stake", owner.key().as_ref()],
        bump,
        has_one = owner @ StakeError::Unauthorized,
    )]
    pub stake: Account<'info, UserStake>,
    pub owner: Signer<'info>,
}

#[account]
pub struct UserStake {
    pub owner: Pubkey,
    pub reward_rate: u64,
    pub amount: u64,
    pub last_claim: i64,
    pub accumulated_rewards: u64,
}

impl UserStake {
    pub const LEN: usize = 32 + 8 + 8 + 8 + 8;
}

#[event]
pub struct StakeUpdated {
    pub owner: Pubkey,
    pub new_amount: u64,
    pub earned_this_period: u64,
    pub timestamp: i64,
}

#[event]
pub struct RewardsClaimed {
    pub owner: Pubkey,
    pub amount: u64,
    pub timestamp: i64,
}

#[error_code]
pub enum StakeError {
    #[msg("Unauthorized")]
    Unauthorized,
}

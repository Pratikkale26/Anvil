use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Mint, Transfer, MintTo};
use anchor_lang::solana_program::clock::Clock;

declare_id!("Stak1ngPr0gram111111111111111111111111111111");

#[program]
pub mod staking {
    use super::*;

    pub fn initialize_pool(
        ctx: Context<InitializePool>,
        reward_rate: u64,
        lock_duration: i64,
        max_stake: u64,
    ) -> Result<()> {
        require!(reward_rate > 0, StakingError::InvalidRewardRate);
        require!(lock_duration > 0, StakingError::InvalidLockDuration);
        require!(max_stake > 0, StakingError::InvalidMaxStake);

        let pool = &mut ctx.accounts.pool;
        pool.admin = ctx.accounts.admin.key();
        pool.stake_mint = ctx.accounts.stake_mint.key();
        pool.reward_mint = ctx.accounts.reward_mint.key();
        pool.reward_rate = reward_rate;
        pool.lock_duration = lock_duration;
        pool.max_stake = max_stake;
        pool.total_staked = 0;
        pool.bump = ctx.bumps.pool;
        pool.reward_vault_bump = ctx.bumps.reward_vault;
        pool.is_paused = false;

        Ok(())
    }

    pub fn stake(ctx: Context<Stake>, amount: u64) -> Result<()> {
        require!(!ctx.accounts.pool.is_paused, StakingError::PoolPaused);
        require!(amount > 0, StakingError::InvalidAmount);

        let pool = &ctx.accounts.pool;

        require!(
            ctx.accounts.pool.total_staked.checked_add(amount).ok_or(StakingError::Overflow)? <= pool.max_stake,
            StakingError::MaxStakeExceeded
        );

        let clock = Clock::get()?;
        let now = clock.unix_timestamp;

        let user_stake = &mut ctx.accounts.user_stake;
        user_stake.owner = ctx.accounts.user.key();
        user_stake.pool = ctx.accounts.pool.key();
        user_stake.amount = amount;
        user_stake.staked_at = now;
        user_stake.last_claim = now;
        user_stake.bump = ctx.bumps.user_stake;

        let pool = &mut ctx.accounts.pool;
        pool.total_staked = pool.total_staked
            .checked_add(amount)
            .ok_or(StakingError::Overflow)?;

        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.user_stake_ata.to_account_info(),
                    to: ctx.accounts.stake_vault.to_account_info(),
                    authority: ctx.accounts.user.to_account_info(),
                },
            ),
            amount,
        )?;

        emit!(StakeEvent {
            user: ctx.accounts.user.key(),
            amount,
            timestamp: now,
        });

        Ok(())
    }

    pub fn claim_rewards(ctx: Context<ClaimRewards>) -> Result<()> {
        require!(!ctx.accounts.pool.is_paused, StakingError::PoolPaused);

        let clock = Clock::get()?;
        let now = clock.unix_timestamp;

        let user_stake = &ctx.accounts.user_stake;
        let pool = &ctx.accounts.pool;

        let elapsed = now
            .checked_sub(user_stake.last_claim)
            .ok_or(StakingError::Underflow)? as u64;

        let rewards: u64 = (user_stake.amount as u128)
            .checked_mul(elapsed as u128)
            .ok_or(StakingError::Overflow)?
            .checked_mul(pool.reward_rate as u128)
            .ok_or(StakingError::Overflow)?
            .checked_div(1_000_000)
            .ok_or(StakingError::Overflow)?
            .try_into()
            .map_err(|_| error!(StakingError::Overflow))?;

        require!(rewards > 0, StakingError::NoRewards);

        let pool_seeds = &[
            b"pool",
            pool.stake_mint.as_ref(),
            &[pool.bump],
        ];
        let signer_seeds = &[&pool_seeds[..]];

        token::mint_to(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                MintTo {
                    mint: ctx.accounts.reward_mint.to_account_info(),
                    to: ctx.accounts.user_reward_ata.to_account_info(),
                    authority: ctx.accounts.pool.to_account_info(),
                },
                signer_seeds,
            ),
            rewards,
        )?;

        let user_stake = &mut ctx.accounts.user_stake;
        user_stake.last_claim = now;

        emit!(RewardEvent {
            user: ctx.accounts.user.key(),
            rewards,
            timestamp: now,
        });

        Ok(())
    }

    pub fn unstake(ctx: Context<Unstake>) -> Result<()> {
        require!(!ctx.accounts.pool.is_paused, StakingError::PoolPaused);

        let clock = Clock::get()?;
        let now = clock.unix_timestamp;

        let user_stake = &ctx.accounts.user_stake;
        let pool = &ctx.accounts.pool;

        let unlock_time = user_stake.staked_at
            .checked_add(pool.lock_duration)
            .ok_or(StakingError::Overflow)?;

        require!(now >= unlock_time, StakingError::StillLocked);

        let elapsed = now
            .checked_sub(user_stake.last_claim)
            .ok_or(StakingError::Underflow)? as u64;

        let pending_rewards: u64 = (user_stake.amount as u128)
            .checked_mul(elapsed as u128)
            .ok_or(StakingError::Overflow)?
            .checked_mul(pool.reward_rate as u128)
            .ok_or(StakingError::Overflow)?
            .checked_div(1_000_000)
            .ok_or(StakingError::Overflow)?
            .try_into()
            .map_err(|_| error!(StakingError::Overflow))?;

        let stake_seeds = &[
            b"pool",
            pool.stake_mint.as_ref(),
            &[pool.bump],
        ];
        let signer_seeds = &[&stake_seeds[..]];

        // Transfer staked tokens back
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.stake_vault.to_account_info(),
                    to: ctx.accounts.user_stake_ata.to_account_info(),
                    authority: ctx.accounts.pool.to_account_info(),
                },
                signer_seeds,
            ),
            user_stake.amount,
        )?;

        // Mint pending rewards if any
        if pending_rewards > 0 {
            token::mint_to(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info(),
                    MintTo {
                        mint: ctx.accounts.reward_mint.to_account_info(),
                        to: ctx.accounts.user_reward_ata.to_account_info(),
                        authority: ctx.accounts.pool.to_account_info(),
                    },
                    signer_seeds,
                ),
                pending_rewards,
            )?;
        }

        let pool = &mut ctx.accounts.pool;
        pool.total_staked = pool.total_staked
            .checked_sub(user_stake.amount)
            .ok_or(StakingError::Underflow)?;

        emit!(UnstakeEvent {
            user: ctx.accounts.user.key(),
            amount: user_stake.amount,
            rewards: pending_rewards,
            timestamp: now,
        });

        Ok(())
    }

    pub fn pause_pool(ctx: Context<AdminOnly>) -> Result<()> {
        ctx.accounts.pool.is_paused = true;
        Ok(())
    }

    pub fn resume_pool(ctx: Context<AdminOnly>) -> Result<()> {
        ctx.accounts.pool.is_paused = false;
        Ok(())
    }

    pub fn update_reward_rate(ctx: Context<AdminOnly>, new_rate: u64) -> Result<()> {
        require!(new_rate > 0, StakingError::InvalidRewardRate);
        ctx.accounts.pool.reward_rate = new_rate;
        Ok(())
    }
}

// ── Accounts ────────────────────────────────────────────────────────────────

#[derive(Accounts)]
pub struct InitializePool<'info> {
    #[account(
        init,
        payer = admin,
        space = 8 + StakingPool::LEN,
        seeds = [b"pool", stake_mint.key().as_ref()],
        bump
    )]
    pub pool: Account<'info, StakingPool>,

    #[account(
        init,
        payer = admin,
        token::mint = reward_mint,
        token::authority = pool,
        seeds = [b"reward_vault", pool.key().as_ref()],
        bump
    )]
    pub reward_vault: Account<'info, TokenAccount>,

    pub stake_mint: Account<'info, Mint>,
    pub reward_mint: Account<'info, Mint>,

    #[account(mut)]
    pub admin: Signer<'info>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Stake<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    #[account(
        init,
        payer = user,
        space = 8 + UserStake::LEN,
        seeds = [b"user_stake", user.key().as_ref(), pool.key().as_ref()],
        bump
    )]
    pub user_stake: Account<'info, UserStake>,

    #[account(
        mut,
        seeds = [b"pool", pool.stake_mint.as_ref()],
        bump = pool.bump,
    )]
    pub pool: Account<'info, StakingPool>,

    #[account(
        mut,
        associated_token::mint = pool.stake_mint,
        associated_token::authority = user,
    )]
    pub user_stake_ata: Account<'info, TokenAccount>,

    #[account(
        mut,
        token::mint = pool.stake_mint,
        token::authority = pool,
    )]
    pub stake_vault: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ClaimRewards<'info> {
    pub user: Signer<'info>,

    #[account(
        mut,
        seeds = [b"user_stake", user.key().as_ref(), pool.key().as_ref()],
        bump = user_stake.bump,
        constraint = user_stake.owner == user.key() @ StakingError::Unauthorized,
    )]
    pub user_stake: Account<'info, UserStake>,

    #[account(
        mut,
        seeds = [b"pool", pool.stake_mint.as_ref()],
        bump = pool.bump,
    )]
    pub pool: Account<'info, StakingPool>,

    #[account(mut)]
    pub reward_mint: Account<'info, Mint>,

    #[account(
        mut,
        associated_token::mint = reward_mint,
        associated_token::authority = user,
    )]
    pub user_reward_ata: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct Unstake<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    #[account(
        mut,
        seeds = [b"user_stake", user.key().as_ref(), pool.key().as_ref()],
        bump = user_stake.bump,
        constraint = user_stake.owner == user.key() @ StakingError::Unauthorized,
        close = user,
    )]
    pub user_stake: Account<'info, UserStake>,

    #[account(
        mut,
        seeds = [b"pool", pool.stake_mint.as_ref()],
        bump = pool.bump,
    )]
    pub pool: Account<'info, StakingPool>,

    #[account(mut)]
    pub reward_mint: Account<'info, Mint>,

    #[account(
        mut,
        associated_token::mint = pool.stake_mint,
        associated_token::authority = user,
    )]
    pub user_stake_ata: Account<'info, TokenAccount>,

    #[account(
        mut,
        token::mint = pool.stake_mint,
        token::authority = pool,
    )]
    pub stake_vault: Account<'info, TokenAccount>,

    #[account(
        mut,
        associated_token::mint = reward_mint,
        associated_token::authority = user,
    )]
    pub user_reward_ata: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct AdminOnly<'info> {
    #[account(
        mut,
        has_one = admin,
        seeds = [b"pool", pool.stake_mint.as_ref()],
        bump = pool.bump,
    )]
    pub pool: Account<'info, StakingPool>,

    pub admin: Signer<'info>,
}

// ── State ────────────────────────────────────────────────────────────────────

#[account]
pub struct StakingPool {
    pub admin: Pubkey,
    pub stake_mint: Pubkey,
    pub reward_mint: Pubkey,
    pub reward_rate: u64,
    pub lock_duration: i64,
    pub max_stake: u64,
    pub total_staked: u64,
    pub bump: u8,
    pub reward_vault_bump: u8,
    pub is_paused: bool,
}

impl StakingPool {
    pub const LEN: usize = 32 + 32 + 32 + 8 + 8 + 8 + 8 + 1 + 1 + 1; // = 131
}

#[account]
pub struct UserStake {
    pub owner: Pubkey,
    pub pool: Pubkey,
    pub amount: u64,
    pub staked_at: i64,
    pub last_claim: i64,
    pub bump: u8,
}

impl UserStake {
    pub const LEN: usize = 32 + 32 + 8 + 8 + 8 + 1; // = 89
}

// ── Events ───────────────────────────────────────────────────────────────────

#[event]
pub struct StakeEvent {
    pub user: Pubkey,
    pub amount: u64,
    pub timestamp: i64,
}

#[event]
pub struct RewardEvent {
    pub user: Pubkey,
    pub rewards: u64,
    pub timestamp: i64,
}

#[event]
pub struct UnstakeEvent {
    pub user: Pubkey,
    pub amount: u64,
    pub rewards: u64,
    pub timestamp: i64,
}

// ── Errors ───────────────────────────────────────────────────────────────────

#[error_code]
pub enum StakingError {
    #[msg("Reward rate must be greater than zero")]
    InvalidRewardRate,
    #[msg("Lock duration must be greater than zero")]
    InvalidLockDuration,
    #[msg("Max stake must be greater than zero")]
    InvalidMaxStake,
    #[msg("Amount must be greater than zero")]
    InvalidAmount,
    #[msg("Pool is paused")]
    PoolPaused,
    #[msg("Max stake exceeded")]
    MaxStakeExceeded,
    #[msg("No rewards to claim")]
    NoRewards,
    #[msg("Tokens are still locked")]
    StillLocked,
    #[msg("Unauthorized")]
    Unauthorized,
    #[msg("Arithmetic overflow")]
    Overflow,
    #[msg("Arithmetic underflow")]
    Underflow,
}
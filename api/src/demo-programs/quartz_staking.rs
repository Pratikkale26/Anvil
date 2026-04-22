use anchor_lang::prelude::*;
use anchor_spl::token::{self, Burn, CloseAccount, Mint, MintTo, Token, TokenAccount, Transfer};

declare_id!("QZStk1111111111111111111111111111111111111111");

// ─────────────────────────────────────────────────────────────
//  CONSTANTS
// ─────────────────────────────────────────────────────────────
/// Reward math precision scalar (1e12)
pub const REWARD_PRECISION: u128 = 1_000_000_000_000;
/// Minimum stake amount (1 token lamport)
pub const MIN_STAKE: u64 = 1;
/// Maximum reward rate: 1 full token per staked token per second
pub const MAX_REWARD_RATE: u64 = 1_000_000_000;

// ─────────────────────────────────────────────────────────────
//  PROGRAM
// ─────────────────────────────────────────────────────────────
#[program]
pub mod quartz_staking {
    use super::*;

    // ── 1. INITIALIZE POOL ───────────────────────────────────
    /// Creates the StakePool, the staked-token vault, and the
    /// reward vault. Emits PoolInitializedEvent.
    pub fn initialize_pool(
        ctx: Context<InitializePool>,
        reward_rate: u64,
        lockup_duration: i64,
    ) -> Result<()> {
        require!(reward_rate > 0, StakingError::ZeroAmount);
        require!(reward_rate <= MAX_REWARD_RATE, StakingError::InvalidRewardRate);
        require!(lockup_duration >= 0, StakingError::InvalidLockup);

        let pool = &mut ctx.accounts.stake_pool;
        pool.admin = ctx.accounts.admin.key();
        pool.stake_mint = ctx.accounts.stake_mint.key();
        pool.reward_mint = ctx.accounts.reward_mint.key();
        pool.vault = ctx.accounts.vault.key();
        pool.reward_vault = ctx.accounts.reward_vault.key();
        pool.reward_rate = reward_rate;
        pool.total_staked = 0;
        pool.paused = false;
        pool.lockup_duration = lockup_duration;
        pool.bump = ctx.bumps.stake_pool;
        pool.vault_bump = ctx.bumps.vault;
        pool.reward_vault_bump = ctx.bumps.reward_vault;

        let acc = &mut ctx.accounts.reward_accumulator;
        acc.acc_reward_per_token = 0;
        acc.last_update_ts = Clock::get()?.unix_timestamp;
        acc.bump = ctx.bumps.reward_accumulator;

        emit!(PoolInitializedEvent {
            pool: pool.key(),
            admin: pool.admin,
            stake_mint: pool.stake_mint,
            reward_mint: pool.reward_mint,
            reward_rate,
            lockup_duration,
        });

        Ok(())
    }

    // ── 2. FUND REWARDS ──────────────────────────────────────
    /// Admin deposits reward tokens into the reward vault so
    /// stakers can claim them. Exercises a straightforward
    /// token::transfer CPI with a signer that is a regular
    /// keypair (no PDA signing needed here).
    pub fn fund_rewards(ctx: Context<FundRewards>, amount: u64) -> Result<()> {
        require!(amount > 0, StakingError::ZeroAmount);

        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.admin_reward_account.to_account_info(),
                    to: ctx.accounts.reward_vault.to_account_info(),
                    authority: ctx.accounts.admin.to_account_info(),
                },
            ),
            amount,
        )?;

        emit!(RewardsFundedEvent {
            pool: ctx.accounts.stake_pool.key(),
            funder: ctx.accounts.admin.key(),
            amount,
            timestamp: Clock::get()?.unix_timestamp,
        });

        Ok(())
    }

    // ── 3. STAKE ─────────────────────────────────────────────
    /// User transfers `amount` stake tokens into the vault.
    /// Initialises a StakeEntry PDA on first call.
    /// Updates the global reward accumulator before touching
    /// any balances (standard DeFi checkpoint pattern).
    pub fn stake(ctx: Context<Stake>, amount: u64) -> Result<()> {
        require!(amount >= MIN_STAKE, StakingError::ZeroAmount);
        require!(!ctx.accounts.stake_pool.paused, StakingError::PoolPaused);

        let now = Clock::get()?.unix_timestamp;
        let pool = &mut ctx.accounts.stake_pool;
        let acc = &mut ctx.accounts.reward_accumulator;
        let entry = &mut ctx.accounts.stake_entry;

        // ── checkpoint global accumulator ──
        update_accumulator(acc, pool, now)?;

        // ── settle pending rewards for this user ──
        if entry.amount_staked > 0 {
            let pending = compute_pending(entry, acc)?;
            entry.pending_rewards = entry
                .pending_rewards
                .checked_add(pending)
                .ok_or(StakingError::ArithmeticOverflow)?;
        } else {
            // first stake: initialize entry fields
            entry.owner = ctx.accounts.user.key();
            entry.pool = pool.key();
            entry.bump = ctx.bumps.stake_entry;
        }

        // ── update debt to current accumulator ──
        entry.reward_debt = acc_debt_for(entry.amount_staked.checked_add(amount)
            .ok_or(StakingError::ArithmeticOverflow)?, acc);

        // ── transfer tokens to vault ──
        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.user_stake_account.to_account_info(),
                    to: ctx.accounts.vault.to_account_info(),
                    authority: ctx.accounts.user.to_account_info(),
                },
            ),
            amount,
        )?;

        entry.amount_staked = entry
            .amount_staked
            .checked_add(amount)
            .ok_or(StakingError::ArithmeticOverflow)?;
        entry.last_stake_ts = now;

        pool.total_staked = pool
            .total_staked
            .checked_add(amount)
            .ok_or(StakingError::ArithmeticOverflow)?;

        emit!(StakeEvent {
            pool: pool.key(),
            user: ctx.accounts.user.key(),
            amount,
            total_staked: pool.total_staked,
            timestamp: now,
        });

        Ok(())
    }

    // ── 4. UNSTAKE ───────────────────────────────────────────
    /// Withdraws `amount` from the vault back to the user.
    /// Respects lockup_duration; settles pending rewards first.
    /// Uses PDA-signed token::transfer (vault is a PDA ATA).
    pub fn unstake(ctx: Context<Unstake>, amount: u64) -> Result<()> {
        require!(amount >= MIN_STAKE, StakingError::ZeroAmount);

        let now = Clock::get()?.unix_timestamp;

        {
            let pool = &ctx.accounts.stake_pool;
            let entry = &ctx.accounts.stake_entry;
            require!(!pool.paused, StakingError::PoolPaused);
            require!(entry.amount_staked >= amount, StakingError::InsufficientStake);

            let lockup_end = entry
                .last_stake_ts
                .checked_add(pool.lockup_duration)
                .ok_or(StakingError::ArithmeticOverflow)?;
            require!(now >= lockup_end, StakingError::LockupNotExpired);
        }

        let pool_key = ctx.accounts.stake_pool.key();
        let pool = &mut ctx.accounts.stake_pool;
        let acc = &mut ctx.accounts.reward_accumulator;
        let entry = &mut ctx.accounts.stake_entry;

        update_accumulator(acc, pool, now)?;

        let pending = compute_pending(entry, acc)?;
        entry.pending_rewards = entry
            .pending_rewards
            .checked_add(pending)
            .ok_or(StakingError::ArithmeticOverflow)?;

        entry.amount_staked = entry
            .amount_staked
            .checked_sub(amount)
            .ok_or(StakingError::InsufficientStake)?;

        entry.reward_debt = acc_debt_for(entry.amount_staked, acc);

        pool.total_staked = pool
            .total_staked
            .checked_sub(amount)
            .ok_or(StakingError::ArithmeticOverflow)?;

        // ── PDA-signed transfer out of vault ──
        let pool_admin = pool.admin;
        let stake_mint = pool.stake_mint;
        let seeds: &[&[u8]] = &[
            b"vault",
            pool_key.as_ref(),
            stake_mint.as_ref(),
            pool_admin.as_ref(),
            &[pool.vault_bump],
        ];
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.vault.to_account_info(),
                    to: ctx.accounts.user_stake_account.to_account_info(),
                    authority: ctx.accounts.vault.to_account_info(),
                },
                &[seeds],
            ),
            amount,
        )?;

        emit!(UnstakeEvent {
            pool: pool.key(),
            user: ctx.accounts.user.key(),
            amount,
            total_staked: pool.total_staked,
            timestamp: now,
        });

        Ok(())
    }

    // ── 5. CLAIM REWARDS ─────────────────────────────────────
    /// Calculates accumulated rewards and mints them to the
    /// user's reward token account. The pool PDA is the mint
    /// authority. Exercises token::mint_to CPI with PDA signer.
    pub fn claim_rewards(ctx: Context<ClaimRewards>) -> Result<()> {
        require!(!ctx.accounts.stake_pool.paused, StakingError::PoolPaused);

        let now = Clock::get()?.unix_timestamp;
        let pool_key = ctx.accounts.stake_pool.key();

        let pool = &mut ctx.accounts.stake_pool;
        let acc = &mut ctx.accounts.reward_accumulator;
        let entry = &mut ctx.accounts.stake_entry;

        update_accumulator(acc, pool, now)?;

        let pending = compute_pending(entry, acc)?;
        let total_claimable = entry
            .pending_rewards
            .checked_add(pending)
            .ok_or(StakingError::ArithmeticOverflow)?;

        require!(total_claimable > 0, StakingError::NothingToClaim);

        entry.pending_rewards = 0;
        entry.reward_debt = acc_debt_for(entry.amount_staked, acc);

        // ── PDA-signed mint_to ──
        let admin = pool.admin;
        let seeds: &[&[u8]] = &[
            b"stake_pool",
            pool.stake_mint.as_ref(),
            admin.as_ref(),
            &[pool.bump],
        ];

        token::mint_to(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                MintTo {
                    mint: ctx.accounts.reward_mint.to_account_info(),
                    to: ctx.accounts.user_reward_account.to_account_info(),
                    authority: ctx.accounts.stake_pool.to_account_info(),
                },
                &[seeds],
            ),
            total_claimable,
        )?;

        emit!(RewardClaimedEvent {
            pool: pool_key,
            user: ctx.accounts.user.key(),
            amount: total_claimable,
            timestamp: now,
        });

        Ok(())
    }

    // ── 6. COMPOUND ──────────────────────────────────────────
    /// Claims pending rewards and immediately re-stakes them.
    /// Only valid when stake_mint == reward_mint.
    /// Burns the minted reward and re-credits the vault balance
    /// to avoid double-minting, then increments stake entry.
    pub fn compound(ctx: Context<Compound>) -> Result<()> {
        require!(!ctx.accounts.stake_pool.paused, StakingError::PoolPaused);
        require!(
            ctx.accounts.stake_pool.stake_mint == ctx.accounts.stake_pool.reward_mint,
            StakingError::MintMismatch
        );

        let now = Clock::get()?.unix_timestamp;
        let pool_key = ctx.accounts.stake_pool.key();

        let pool = &mut ctx.accounts.stake_pool;
        let acc = &mut ctx.accounts.reward_accumulator;
        let entry = &mut ctx.accounts.stake_entry;

        update_accumulator(acc, pool, now)?;

        let pending = compute_pending(entry, acc)?;
        let total_claimable = entry
            .pending_rewards
            .checked_add(pending)
            .ok_or(StakingError::ArithmeticOverflow)?;

        require!(total_claimable > 0, StakingError::NothingToClaim);

        // ── mint rewards to a temp holding account ──
        let admin = pool.admin;
        let pool_seeds: &[&[u8]] = &[
            b"stake_pool",
            pool.stake_mint.as_ref(),
            admin.as_ref(),
            &[pool.bump],
        ];

        token::mint_to(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                MintTo {
                    mint: ctx.accounts.reward_mint.to_account_info(),
                    to: ctx.accounts.temp_reward_account.to_account_info(),
                    authority: ctx.accounts.stake_pool.to_account_info(),
                },
                &[pool_seeds],
            ),
            total_claimable,
        )?;

        // ── transfer from temp account into vault ──
        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.temp_reward_account.to_account_info(),
                    to: ctx.accounts.vault.to_account_info(),
                    authority: ctx.accounts.user.to_account_info(),
                },
            ),
            total_claimable,
        )?;

        // ── update bookkeeping ──
        entry.pending_rewards = 0;
        entry.amount_staked = entry
            .amount_staked
            .checked_add(total_claimable)
            .ok_or(StakingError::ArithmeticOverflow)?;

        update_accumulator(acc, pool, now)?; // re-checkpoint after balance change
        entry.reward_debt = acc_debt_for(entry.amount_staked, acc);
        entry.last_stake_ts = now;

        pool.total_staked = pool
            .total_staked
            .checked_add(total_claimable)
            .ok_or(StakingError::ArithmeticOverflow)?;

        emit!(CompoundEvent {
            pool: pool_key,
            user: ctx.accounts.user.key(),
            compounded_amount: total_claimable,
            new_stake: entry.amount_staked,
            timestamp: now,
        });

        Ok(())
    }

    // ── 7. EMERGENCY WITHDRAW ────────────────────────────────
    /// Force-withdraws all staked tokens regardless of lockup.
    /// Forfeits ALL pending and accrued rewards.
    /// Exercises PDA-signed transfer + closes stake_entry (reclaims rent).
    pub fn emergency_withdraw(ctx: Context<EmergencyWithdraw>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let pool_key = ctx.accounts.stake_pool.key();

        let amount = ctx.accounts.stake_entry.amount_staked;
        require!(amount > 0, StakingError::InsufficientStake);

        let acc = &mut ctx.accounts.reward_accumulator;
        let pool = &mut ctx.accounts.stake_pool;
        let entry = &mut ctx.accounts.stake_entry;

        // compute forfeited rewards for the event (no payout)
        update_accumulator(acc, pool, now)?;
        let pending = compute_pending(entry, acc)?;
        let forfeited = entry
            .pending_rewards
            .checked_add(pending)
            .ok_or(StakingError::ArithmeticOverflow)?;

        // zero-out entry
        entry.amount_staked = 0;
        entry.pending_rewards = 0;
        entry.reward_debt = 0;

        pool.total_staked = pool
            .total_staked
            .checked_sub(amount)
            .ok_or(StakingError::ArithmeticOverflow)?;

        // ── PDA-signed transfer ──
        let admin = pool.admin;
        let stake_mint = pool.stake_mint;
        let vault_seeds: &[&[u8]] = &[
            b"vault",
            pool_key.as_ref(),
            stake_mint.as_ref(),
            admin.as_ref(),
            &[pool.vault_bump],
        ];

        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.vault.to_account_info(),
                    to: ctx.accounts.user_stake_account.to_account_info(),
                    authority: ctx.accounts.vault.to_account_info(),
                },
                &[vault_seeds],
            ),
            amount,
        )?;

        emit!(EmergencyWithdrawEvent {
            pool: pool_key,
            user: ctx.accounts.user.key(),
            amount,
            forfeited_rewards: forfeited,
            timestamp: now,
        });

        Ok(())
    }

    // ── 8. PAUSE / RESUME POOL ───────────────────────────────
    pub fn pause_pool(ctx: Context<AdminAction>) -> Result<()> {
        require!(!ctx.accounts.stake_pool.paused, StakingError::AlreadyPaused);
        ctx.accounts.stake_pool.paused = true;

        emit!(PoolPausedEvent {
            pool: ctx.accounts.stake_pool.key(),
            paused: true,
            timestamp: Clock::get()?.unix_timestamp,
        });
        Ok(())
    }

    pub fn resume_pool(ctx: Context<AdminAction>) -> Result<()> {
        require!(ctx.accounts.stake_pool.paused, StakingError::NotPaused);
        ctx.accounts.stake_pool.paused = false;

        emit!(PoolPausedEvent {
            pool: ctx.accounts.stake_pool.key(),
            paused: false,
            timestamp: Clock::get()?.unix_timestamp,
        });
        Ok(())
    }

    // ── 9. UPDATE REWARD RATE ────────────────────────────────
    /// Admin updates the per-second reward rate.
    /// Checkpoints the accumulator first so existing stakers
    /// are settled at the old rate before the new one takes effect.
    pub fn update_reward_rate(ctx: Context<AdminAction>, new_rate: u64) -> Result<()> {
        require!(new_rate > 0, StakingError::ZeroAmount);
        require!(new_rate <= MAX_REWARD_RATE, StakingError::InvalidRewardRate);

        let now = Clock::get()?.unix_timestamp;
        let pool = &mut ctx.accounts.stake_pool;
        let acc = &mut ctx.accounts.reward_accumulator;

        update_accumulator(acc, pool, now)?;

        let old_rate = pool.reward_rate;
        pool.reward_rate = new_rate;

        emit!(RewardRateUpdatedEvent {
            pool: pool.key(),
            old_rate,
            new_rate,
            timestamp: now,
        });

        Ok(())
    }

    // ── 10. CLOSE STAKE ENTRY ────────────────────────────────
    /// Closes a fully-emptied StakeEntry, returning rent lamports
    /// to the user. Exercises `close = user` constraint path.
    pub fn close_stake_entry(ctx: Context<CloseStakeEntry>) -> Result<()> {
        require!(
            ctx.accounts.stake_entry.amount_staked == 0,
            StakingError::StakeEntryNotEmpty
        );
        require!(
            ctx.accounts.stake_entry.pending_rewards == 0,
            StakingError::PendingRewardsRemaining
        );
        // account is closed by the `close = user` constraint — nothing else needed
        Ok(())
    }

    // ── 11. CLOSE REWARD VAULT ───────────────────────────────
    /// Admin shuts down the pool and reclaims the reward vault.
    /// Uses token::close_account CPI with PDA signer.
    pub fn close_reward_vault(ctx: Context<CloseRewardVault>) -> Result<()> {
        require!(ctx.accounts.stake_pool.total_staked == 0, StakingError::StakersStillActive);

        let admin = ctx.accounts.stake_pool.admin;
        let stake_mint = ctx.accounts.stake_pool.stake_mint;
        let reward_vault_bump = ctx.accounts.stake_pool.reward_vault_bump;

        let seeds: &[&[u8]] = &[
            b"reward_vault",
            ctx.accounts.stake_pool.key().as_ref(),
            stake_mint.as_ref(),
            admin.as_ref(),
            &[reward_vault_bump],
        ];

        token::close_account(CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            CloseAccount {
                account: ctx.accounts.reward_vault.to_account_info(),
                destination: ctx.accounts.admin.to_account_info(),
                authority: ctx.accounts.reward_vault.to_account_info(),
            },
            &[seeds],
        ))?;

        Ok(())
    }
}

// ─────────────────────────────────────────────────────────────
//  HELPER FUNCTIONS
// ─────────────────────────────────────────────────────────────

/// Advance the global acc_reward_per_token.
fn update_accumulator(
    acc: &mut Account<RewardAccumulator>,
    pool: &Account<StakePool>,
    now: i64,
) -> Result<()> {
    if pool.total_staked == 0 {
        acc.last_update_ts = now;
        return Ok(());
    }

    let elapsed = (now - acc.last_update_ts).max(0) as u128;
    let reward = elapsed
        .checked_mul(pool.reward_rate as u128)
        .ok_or(StakingError::ArithmeticOverflow)?
        .checked_mul(REWARD_PRECISION)
        .ok_or(StakingError::ArithmeticOverflow)?
        .checked_div(pool.total_staked as u128)
        .ok_or(StakingError::ArithmeticOverflow)?;

    acc.acc_reward_per_token = acc
        .acc_reward_per_token
        .checked_add(reward)
        .ok_or(StakingError::ArithmeticOverflow)?;
    acc.last_update_ts = now;

    Ok(())
}

/// Pending rewards = staked * (acc_reward_per_token - reward_debt) / PRECISION
fn compute_pending(entry: &StakeEntry, acc: &RewardAccumulator) -> Result<u64> {
    let delta = acc
        .acc_reward_per_token
        .checked_sub(entry.reward_debt)
        .unwrap_or(0);

    let pending = (entry.amount_staked as u128)
        .checked_mul(delta)
        .ok_or(StakingError::ArithmeticOverflow)?
        .checked_div(REWARD_PRECISION)
        .ok_or(StakingError::ArithmeticOverflow)? as u64;

    Ok(pending)
}

fn acc_debt_for(amount: u64, acc: &RewardAccumulator) -> u128 {
    (amount as u128)
        .saturating_mul(acc.acc_reward_per_token)
        .saturating_div(REWARD_PRECISION)
}

// ─────────────────────────────────────────────────────────────
//  ACCOUNT STRUCTS
// ─────────────────────────────────────────────────────────────

#[account]
#[derive(Default)]
pub struct StakePool {
    pub admin: Pubkey,           // 32
    pub stake_mint: Pubkey,      // 32
    pub reward_mint: Pubkey,     // 32
    pub vault: Pubkey,           // 32
    pub reward_vault: Pubkey,    // 32
    pub reward_rate: u64,        // 8  — tokens per second per total staked, scaled
    pub total_staked: u64,       // 8
    pub paused: bool,            // 1
    pub lockup_duration: i64,    // 8
    pub bump: u8,                // 1
    pub vault_bump: u8,          // 1
    pub reward_vault_bump: u8,   // 1
}

impl StakePool {
    pub const LEN: usize = 8 + 32 + 32 + 32 + 32 + 32 + 8 + 8 + 1 + 8 + 1 + 1 + 1;
}

#[account]
#[derive(Default)]
pub struct StakeEntry {
    pub owner: Pubkey,          // 32
    pub pool: Pubkey,           // 32
    pub amount_staked: u64,     // 8
    pub reward_debt: u128,      // 16
    pub last_stake_ts: i64,     // 8
    pub pending_rewards: u64,   // 8
    pub bump: u8,               // 1
}

impl StakeEntry {
    pub const LEN: usize = 8 + 32 + 32 + 8 + 16 + 8 + 8 + 1;
}

#[account]
#[derive(Default)]
pub struct RewardAccumulator {
    pub acc_reward_per_token: u128, // 16
    pub last_update_ts: i64,        // 8
    pub bump: u8,                   // 1
}

impl RewardAccumulator {
    pub const LEN: usize = 8 + 16 + 8 + 1;
}

// ─────────────────────────────────────────────────────────────
//  INSTRUCTION CONTEXTS
// ─────────────────────────────────────────────────────────────

#[derive(Accounts)]
pub struct InitializePool<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,

    pub stake_mint: Account<'info, Mint>,
    pub reward_mint: Account<'info, Mint>,

    #[account(
        init,
        payer = admin,
        space = StakePool::LEN,
        seeds = [b"stake_pool", stake_mint.key().as_ref(), admin.key().as_ref()],
        bump,
    )]
    pub stake_pool: Account<'info, StakePool>,

    /// Vault that holds staked tokens — PDA-owned token account
    #[account(
        init,
        payer = admin,
        token::mint = stake_mint,
        token::authority = vault,
        seeds = [b"vault", stake_pool.key().as_ref(), stake_mint.key().as_ref(), admin.key().as_ref()],
        bump,
    )]
    pub vault: Account<'info, TokenAccount>,

    /// Vault holding reward tokens to be distributed
    #[account(
        init,
        payer = admin,
        token::mint = reward_mint,
        token::authority = reward_vault,
        seeds = [b"reward_vault", stake_pool.key().as_ref(), stake_mint.key().as_ref(), admin.key().as_ref()],
        bump,
    )]
    pub reward_vault: Account<'info, TokenAccount>,

    #[account(
        init,
        payer = admin,
        space = RewardAccumulator::LEN,
        seeds = [b"reward_acc", stake_pool.key().as_ref()],
        bump,
    )]
    pub reward_accumulator: Account<'info, RewardAccumulator>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct FundRewards<'info> {
    #[account(
        mut,
        has_one = admin,
        has_one = reward_vault,
    )]
    pub stake_pool: Account<'info, StakePool>,

    #[account(mut)]
    pub admin: Signer<'info>,

    #[account(
        mut,
        constraint = admin_reward_account.mint == stake_pool.reward_mint @ StakingError::InvalidMint,
        constraint = admin_reward_account.owner == admin.key() @ StakingError::Unauthorized,
    )]
    pub admin_reward_account: Account<'info, TokenAccount>,

    #[account(
        mut,
        seeds = [b"reward_vault", stake_pool.key().as_ref(), stake_pool.stake_mint.as_ref(), admin.key().as_ref()],
        bump = stake_pool.reward_vault_bump,
    )]
    pub reward_vault: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct Stake<'info> {
    #[account(
        mut,
        has_one = vault,
        constraint = !stake_pool.paused @ StakingError::PoolPaused,
    )]
    pub stake_pool: Account<'info, StakePool>,

    #[account(mut)]
    pub user: Signer<'info>,

    #[account(
        init_if_needed,
        payer = user,
        space = StakeEntry::LEN,
        seeds = [b"stake_entry", stake_pool.key().as_ref(), user.key().as_ref()],
        bump,
    )]
    pub stake_entry: Account<'info, StakeEntry>,

    #[account(
        mut,
        seeds = [b"reward_acc", stake_pool.key().as_ref()],
        bump = reward_accumulator.bump,
    )]
    pub reward_accumulator: Account<'info, RewardAccumulator>,

    /// User's source token account (must hold stake_mint tokens)
    #[account(
        mut,
        constraint = user_stake_account.mint == stake_pool.stake_mint @ StakingError::InvalidMint,
        constraint = user_stake_account.owner == user.key() @ StakingError::Unauthorized,
    )]
    pub user_stake_account: Account<'info, TokenAccount>,

    #[account(
        mut,
        seeds = [b"vault", stake_pool.key().as_ref(), stake_pool.stake_mint.as_ref(), stake_pool.admin.as_ref()],
        bump = stake_pool.vault_bump,
    )]
    pub vault: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Unstake<'info> {
    #[account(
        mut,
        has_one = vault,
    )]
    pub stake_pool: Account<'info, StakePool>,

    pub user: Signer<'info>,

    #[account(
        mut,
        seeds = [b"stake_entry", stake_pool.key().as_ref(), user.key().as_ref()],
        bump = stake_entry.bump,
        constraint = stake_entry.owner == user.key() @ StakingError::Unauthorized,
        constraint = stake_entry.pool == stake_pool.key() @ StakingError::Unauthorized,
    )]
    pub stake_entry: Account<'info, StakeEntry>,

    #[account(
        mut,
        seeds = [b"reward_acc", stake_pool.key().as_ref()],
        bump = reward_accumulator.bump,
    )]
    pub reward_accumulator: Account<'info, RewardAccumulator>,

    #[account(
        mut,
        constraint = user_stake_account.mint == stake_pool.stake_mint @ StakingError::InvalidMint,
        constraint = user_stake_account.owner == user.key() @ StakingError::Unauthorized,
    )]
    pub user_stake_account: Account<'info, TokenAccount>,

    #[account(
        mut,
        seeds = [b"vault", stake_pool.key().as_ref(), stake_pool.stake_mint.as_ref(), stake_pool.admin.as_ref()],
        bump = stake_pool.vault_bump,
    )]
    pub vault: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct ClaimRewards<'info> {
    #[account(mut)]
    pub stake_pool: Account<'info, StakePool>,

    pub user: Signer<'info>,

    #[account(
        mut,
        seeds = [b"stake_entry", stake_pool.key().as_ref(), user.key().as_ref()],
        bump = stake_entry.bump,
        constraint = stake_entry.owner == user.key() @ StakingError::Unauthorized,
    )]
    pub stake_entry: Account<'info, StakeEntry>,

    #[account(
        mut,
        seeds = [b"reward_acc", stake_pool.key().as_ref()],
        bump = reward_accumulator.bump,
    )]
    pub reward_accumulator: Account<'info, RewardAccumulator>,

    /// The reward mint — pool PDA must be its mint authority
    #[account(
        mut,
        constraint = reward_mint.key() == stake_pool.reward_mint @ StakingError::InvalidMint,
    )]
    pub reward_mint: Account<'info, Mint>,

    #[account(
        mut,
        constraint = user_reward_account.mint == stake_pool.reward_mint @ StakingError::InvalidMint,
        constraint = user_reward_account.owner == user.key() @ StakingError::Unauthorized,
    )]
    pub user_reward_account: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct Compound<'info> {
    #[account(
        mut,
        has_one = vault,
        constraint = stake_pool.stake_mint == stake_pool.reward_mint @ StakingError::MintMismatch,
    )]
    pub stake_pool: Account<'info, StakePool>,

    pub user: Signer<'info>,

    #[account(
        mut,
        seeds = [b"stake_entry", stake_pool.key().as_ref(), user.key().as_ref()],
        bump = stake_entry.bump,
        constraint = stake_entry.owner == user.key() @ StakingError::Unauthorized,
    )]
    pub stake_entry: Account<'info, StakeEntry>,

    #[account(
        mut,
        seeds = [b"reward_acc", stake_pool.key().as_ref()],
        bump = reward_accumulator.bump,
    )]
    pub reward_accumulator: Account<'info, RewardAccumulator>,

    #[account(
        mut,
        constraint = reward_mint.key() == stake_pool.reward_mint @ StakingError::InvalidMint,
    )]
    pub reward_mint: Account<'info, Mint>,

    /// Temporary token account owned by user to receive minted rewards before re-staking
    #[account(
        mut,
        constraint = temp_reward_account.mint == stake_pool.reward_mint @ StakingError::InvalidMint,
        constraint = temp_reward_account.owner == user.key() @ StakingError::Unauthorized,
    )]
    pub temp_reward_account: Account<'info, TokenAccount>,

    #[account(
        mut,
        seeds = [b"vault", stake_pool.key().as_ref(), stake_pool.stake_mint.as_ref(), stake_pool.admin.as_ref()],
        bump = stake_pool.vault_bump,
    )]
    pub vault: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct EmergencyWithdraw<'info> {
    #[account(mut)]
    pub stake_pool: Account<'info, StakePool>,

    pub user: Signer<'info>,

    #[account(
        mut,
        seeds = [b"stake_entry", stake_pool.key().as_ref(), user.key().as_ref()],
        bump = stake_entry.bump,
        constraint = stake_entry.owner == user.key() @ StakingError::Unauthorized,
        close = user,
    )]
    pub stake_entry: Account<'info, StakeEntry>,

    #[account(
        mut,
        seeds = [b"reward_acc", stake_pool.key().as_ref()],
        bump = reward_accumulator.bump,
    )]
    pub reward_accumulator: Account<'info, RewardAccumulator>,

    #[account(
        mut,
        constraint = user_stake_account.mint == stake_pool.stake_mint @ StakingError::InvalidMint,
        constraint = user_stake_account.owner == user.key() @ StakingError::Unauthorized,
    )]
    pub user_stake_account: Account<'info, TokenAccount>,

    #[account(
        mut,
        seeds = [b"vault", stake_pool.key().as_ref(), stake_pool.stake_mint.as_ref(), stake_pool.admin.as_ref()],
        bump = stake_pool.vault_bump,
    )]
    pub vault: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}

/// Admin-only gated context — used by pause, resume, update_reward_rate
#[derive(Accounts)]
pub struct AdminAction<'info> {
    #[account(
        mut,
        has_one = admin @ StakingError::Unauthorized,
    )]
    pub stake_pool: Account<'info, StakePool>,

    #[account(
        mut,
        seeds = [b"reward_acc", stake_pool.key().as_ref()],
        bump = reward_accumulator.bump,
    )]
    pub reward_accumulator: Account<'info, RewardAccumulator>,

    pub admin: Signer<'info>,
}

#[derive(Accounts)]
pub struct CloseStakeEntry<'info> {
    pub stake_pool: Account<'info, StakePool>,

    #[account(mut)]
    pub user: Signer<'info>,

    #[account(
        mut,
        seeds = [b"stake_entry", stake_pool.key().as_ref(), user.key().as_ref()],
        bump = stake_entry.bump,
        constraint = stake_entry.owner == user.key() @ StakingError::Unauthorized,
        close = user,
    )]
    pub stake_entry: Account<'info, StakeEntry>,
}

#[derive(Accounts)]
pub struct CloseRewardVault<'info> {
    #[account(
        mut,
        has_one = admin @ StakingError::Unauthorized,
        has_one = reward_vault,
        constraint = stake_pool.total_staked == 0 @ StakingError::StakersStillActive,
    )]
    pub stake_pool: Account<'info, StakePool>,

    #[account(mut)]
    pub admin: Signer<'info>,

    #[account(
        mut,
        seeds = [b"reward_vault", stake_pool.key().as_ref(), stake_pool.stake_mint.as_ref(), admin.key().as_ref()],
        bump = stake_pool.reward_vault_bump,
    )]
    pub reward_vault: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}

// ─────────────────────────────────────────────────────────────
//  EVENTS
// ─────────────────────────────────────────────────────────────

#[event]
pub struct PoolInitializedEvent {
    pub pool: Pubkey,
    pub admin: Pubkey,
    pub stake_mint: Pubkey,
    pub reward_mint: Pubkey,
    pub reward_rate: u64,
    pub lockup_duration: i64,
}

#[event]
pub struct RewardsFundedEvent {
    pub pool: Pubkey,
    pub funder: Pubkey,
    pub amount: u64,
    pub timestamp: i64,
}

#[event]
pub struct StakeEvent {
    pub pool: Pubkey,
    pub user: Pubkey,
    pub amount: u64,
    pub total_staked: u64,
    pub timestamp: i64,
}

#[event]
pub struct UnstakeEvent {
    pub pool: Pubkey,
    pub user: Pubkey,
    pub amount: u64,
    pub total_staked: u64,
    pub timestamp: i64,
}

#[event]
pub struct RewardClaimedEvent {
    pub pool: Pubkey,
    pub user: Pubkey,
    pub amount: u64,
    pub timestamp: i64,
}

#[event]
pub struct CompoundEvent {
    pub pool: Pubkey,
    pub user: Pubkey,
    pub compounded_amount: u64,
    pub new_stake: u64,
    pub timestamp: i64,
}

#[event]
pub struct EmergencyWithdrawEvent {
    pub pool: Pubkey,
    pub user: Pubkey,
    pub amount: u64,
    pub forfeited_rewards: u64,
    pub timestamp: i64,
}

#[event]
pub struct PoolPausedEvent {
    pub pool: Pubkey,
    pub paused: bool,
    pub timestamp: i64,
}

#[event]
pub struct RewardRateUpdatedEvent {
    pub pool: Pubkey,
    pub old_rate: u64,
    pub new_rate: u64,
    pub timestamp: i64,
}

// ─────────────────────────────────────────────────────────────
//  ERRORS
// ─────────────────────────────────────────────────────────────

#[error_code]
pub enum StakingError {
    #[msg("The staking pool is currently paused.")]
    PoolPaused,

    #[msg("The pool is already paused.")]
    AlreadyPaused,

    #[msg("The pool is not paused.")]
    NotPaused,

    #[msg("Insufficient staked balance for this operation.")]
    InsufficientStake,

    #[msg("Lockup period has not expired yet.")]
    LockupNotExpired,

    #[msg("Provided mint does not match the pool's mint.")]
    InvalidMint,

    #[msg("Caller is not authorised to perform this action.")]
    Unauthorized,

    #[msg("Arithmetic overflow detected.")]
    ArithmeticOverflow,

    #[msg("Amount must be greater than zero.")]
    ZeroAmount,

    #[msg("Reward rate exceeds maximum allowed value.")]
    InvalidRewardRate,

    #[msg("Lockup duration cannot be negative.")]
    InvalidLockup,

    #[msg("No rewards available to claim.")]
    NothingToClaim,

    #[msg("Stake entry still has a non-zero balance.")]
    StakeEntryNotEmpty,

    #[msg("Stake entry still has pending rewards; claim them first.")]
    PendingRewardsRemaining,

    #[msg("Active stakers remain; cannot close the pool.")]
    StakersStillActive,

    #[msg("Compound requires stake_mint == reward_mint.")]
    MintMismatch,
}
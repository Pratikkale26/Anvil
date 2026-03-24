use anchor_lang::prelude::*;

declare_id!("Staking11111111111111111111111111111111111111");

#[program]
pub mod staking {
    use super::*;

    pub fn initialize_pool(
        ctx: Context<InitializePool>,
        reward_rate: u64,
    ) -> Result<()> {
        let pool = &mut ctx.accounts.pool;
        pool.authority = ctx.accounts.authority.key();
        pool.stake_mint = ctx.accounts.stake_mint.key();
        pool.reward_mint = ctx.accounts.reward_mint.key();
        pool.reward_rate = reward_rate;
        pool.total_staked = 0;
        pool.bump = ctx.bumps.pool;
        Ok(())
    }

    pub fn stake(ctx: Context<Stake>, amount: u64) -> Result<()> {
        require!(amount > 0, StakingError::InvalidAmount);

        let clock = Clock::get()?;
        let user_stake = &mut ctx.accounts.user_stake;
        let pool = &mut ctx.accounts.pool;

        // Transfer tokens in
        anchor_spl::token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                anchor_spl::token::Transfer {
                    from: ctx.accounts.user_stake_ata.to_account_info(),
                    to: ctx.accounts.vault.to_account_info(),
                    authority: ctx.accounts.user.to_account_info(),
                },
            ),
            amount,
        )?;

        user_stake.owner = ctx.accounts.user.key();
        user_stake.pool = pool.key();
        user_stake.amount = user_stake.amount.checked_add(amount)
            .ok_or(StakingError::Overflow)?;
        user_stake.stake_ts = clock.unix_timestamp;
        pool.total_staked = pool.total_staked.checked_add(amount)
            .ok_or(StakingError::Overflow)?;
        Ok(())
    }

    pub fn unstake(ctx: Context<Unstake>, amount: u64) -> Result<()> {
        require!(amount > 0, StakingError::InvalidAmount);
        let user_stake = &mut ctx.accounts.user_stake;
        require!(user_stake.amount >= amount, StakingError::InsufficientStake);

        let pool = &ctx.accounts.pool;
        let seeds = &[
            b"pool",
            pool.authority.as_ref(),
            pool.stake_mint.as_ref(),
            &[pool.bump],
        ];
        let signer_seeds = &[&seeds[..]];

        anchor_spl::token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                anchor_spl::token::Transfer {
                    from: ctx.accounts.vault.to_account_info(),
                    to: ctx.accounts.user_stake_ata.to_account_info(),
                    authority: ctx.accounts.pool.to_account_info(),
                },
                signer_seeds,
            ),
            amount,
        )?;

        user_stake.amount = user_stake.amount.checked_sub(amount)
            .ok_or(StakingError::Underflow)?;
        let pool = &mut ctx.accounts.pool;
        pool.total_staked = pool.total_staked.checked_sub(amount)
            .ok_or(StakingError::Underflow)?;
        Ok(())
    }

    pub fn claim_rewards(ctx: Context<ClaimRewards>) -> Result<()> {
        let clock = Clock::get()?;
        let user_stake = &mut ctx.accounts.user_stake;
        let pool = &ctx.accounts.pool;

        let time_elapsed = (clock.unix_timestamp - user_stake.stake_ts) as u64;
        let rewards = user_stake.amount
            .checked_mul(pool.reward_rate)
            .ok_or(StakingError::Overflow)?
            .checked_mul(time_elapsed)
            .ok_or(StakingError::Overflow)?
            .checked_div(86400)  // per day
            .ok_or(StakingError::Overflow)?;

        require!(rewards > 0, StakingError::NoRewards);

        let seeds = &[
            b"pool",
            pool.authority.as_ref(),
            pool.stake_mint.as_ref(),
            &[pool.bump],
        ];
        let signer_seeds = &[&seeds[..]];

        anchor_spl::token::mint_to(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                anchor_spl::token::MintTo {
                    mint: ctx.accounts.reward_mint.to_account_info(),
                    to: ctx.accounts.user_reward_ata.to_account_info(),
                    authority: ctx.accounts.pool.to_account_info(),
                },
                signer_seeds,
            ),
            rewards,
        )?;

        user_stake.stake_ts = clock.unix_timestamp;
        Ok(())
    }
}

#[derive(Accounts)]
pub struct InitializePool<'info> {
    #[account(
        init,
        payer = authority,
        space = 8 + StakePool::INIT_SPACE,
        seeds = [b"pool", authority.key().as_ref(), stake_mint.key().as_ref()],
        bump
    )]
    pub pool: Account<'info, StakePool>,
    pub stake_mint: Account<'info, anchor_spl::token::Mint>,
    pub reward_mint: Account<'info, anchor_spl::token::Mint>,
    #[account(mut)]
    pub authority: Signer<'info>,
    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, anchor_spl::token::Token>,
}

#[derive(Accounts)]
pub struct Stake<'info> {
    #[account(
        init_if_needed,
        payer = user,
        space = 8 + UserStake::INIT_SPACE,
        seeds = [b"user_stake", user.key().as_ref(), pool.key().as_ref()],
        bump
    )]
    pub user_stake: Account<'info, UserStake>,
    #[account(
        mut,
        seeds = [b"pool", pool.authority.as_ref(), pool.stake_mint.as_ref()],
        bump = pool.bump
    )]
    pub pool: Account<'info, StakePool>,
    #[account(
        mut,
        associated_token::mint = pool.stake_mint,
        associated_token::authority = user
    )]
    pub user_stake_ata: Account<'info, anchor_spl::token::TokenAccount>,
    #[account(
        mut,
        token::mint = pool.stake_mint,
        token::authority = pool
    )]
    pub vault: Account<'info, anchor_spl::token::TokenAccount>,
    #[account(mut)]
    pub user: Signer<'info>,
    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, anchor_spl::token::Token>,
}

#[derive(Accounts)]
pub struct Unstake<'info> {
    #[account(
        mut,
        has_one = owner,
        has_one = pool,
        seeds = [b"user_stake", owner.key().as_ref(), pool.key().as_ref()],
        bump
    )]
    pub user_stake: Account<'info, UserStake>,
    #[account(mut)]
    pub pool: Account<'info, StakePool>,
    #[account(
        mut,
        associated_token::mint = pool.stake_mint,
        associated_token::authority = owner
    )]
    pub user_stake_ata: Account<'info, anchor_spl::token::TokenAccount>,
    #[account(
        mut,
        token::mint = pool.stake_mint,
        token::authority = pool
    )]
    pub vault: Account<'info, anchor_spl::token::TokenAccount>,
    pub owner: Signer<'info>,
    pub token_program: Program<'info, anchor_spl::token::Token>,
}

#[derive(Accounts)]
pub struct ClaimRewards<'info> {
    #[account(
        mut,
        has_one = owner,
        has_one = pool
    )]
    pub user_stake: Account<'info, UserStake>,
    #[account(mut)]
    pub pool: Account<'info, StakePool>,
    #[account(mut)]
    pub reward_mint: Account<'info, anchor_spl::token::Mint>,
    #[account(
        init_if_needed,
        payer = owner,
        associated_token::mint = reward_mint,
        associated_token::authority = owner
    )]
    pub user_reward_ata: Account<'info, anchor_spl::token::TokenAccount>,
    #[account(mut)]
    pub owner: Signer<'info>,
    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, anchor_spl::token::Token>,
    pub associated_token_program: Program<'info, anchor_spl::associated_token::AssociatedToken>,
}

#[account]
#[derive(InitSpace)]
pub struct StakePool {
    pub authority: Pubkey,
    pub stake_mint: Pubkey,
    pub reward_mint: Pubkey,
    pub reward_rate: u64,
    pub total_staked: u64,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct UserStake {
    pub owner: Pubkey,
    pub pool: Pubkey,
    pub amount: u64,
    pub stake_ts: i64,
}

#[error_code]
pub enum StakingError {
    #[msg("Amount must be greater than zero")]
    InvalidAmount,
    #[msg("Insufficient staked amount")]
    InsufficientStake,
    #[msg("No rewards to claim")]
    NoRewards,
    #[msg("Arithmetic overflow")]
    Overflow,
    #[msg("Arithmetic underflow")]
    Underflow,
}

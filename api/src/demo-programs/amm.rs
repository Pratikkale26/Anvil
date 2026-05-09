use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Mint, Transfer, MintTo, Burn};

declare_id!("AMM11111111111111111111111111111111111111111");

#[program]
pub mod amm {
    use super::*;

    pub fn initialize_pool(
        ctx: Context<InitializePool>,
        fee_rate: u64,
        initial_price: u64,
    ) -> Result<()> {
        require!(fee_rate <= 10000, AmmError::InvalidFeeRate);
        require!(initial_price > 0, AmmError::InvalidPrice);

        let pool = &mut ctx.accounts.pool;
        pool.admin = ctx.accounts.admin.key();
        pool.token_mint_a = ctx.accounts.token_mint_a.key();
        pool.token_mint_b = ctx.accounts.token_mint_b.key();
        pool.lp_mint = ctx.accounts.lp_mint.key();
        pool.fee_rate = fee_rate;
        pool.initial_price = initial_price;
        pool.reserve_a = 0;
        pool.reserve_b = 0;
        pool.lp_supply = 0;
        pool.total_fees_a = 0;
        pool.total_fees_b = 0;
        pool.protocol_fees_a = 0;
        pool.protocol_fees_b = 0;
        pool.protocol_fee_rate = 2000;
        pool.bump = ctx.bumps.pool;
        pool.vault_a_bump = ctx.bumps.vault_a;
        pool.vault_b_bump = ctx.bumps.vault_b;
        pool.is_frozen = false;

        Ok(())
    }

    pub fn add_liquidity(
        ctx: Context<AddLiquidity>,
        amount_a_desired: u64,
        amount_b_desired: u64,
        amount_a_min: u64,
        amount_b_min: u64,
    ) -> Result<()> {
        require!(!ctx.accounts.pool.is_frozen, AmmError::PoolFrozen);
        require!(amount_a_desired > 0 && amount_b_desired > 0, AmmError::InvalidAmount);

        let pool = &ctx.accounts.pool;

        let (amount_a, amount_b, lp_tokens) = if pool.lp_supply == 0 {
            // First liquidity provision
            let lp = (amount_a_desired as u128)
                .checked_mul(amount_b_desired as u128)
                .ok_or(AmmError::Overflow)?;
            let lp = integer_sqrt(lp);
            (amount_a_desired, amount_b_desired, lp as u64)
        } else {
            // Subsequent liquidity provisions — maintain ratio
            let amount_b_optimal = (amount_a_desired as u128)
                .checked_mul(pool.reserve_b as u128)
                .ok_or(AmmError::Overflow)?
                .checked_div(pool.reserve_a as u128)
                .ok_or(AmmError::Overflow)? as u64;

            let (a, b) = if amount_b_optimal <= amount_b_desired {
                require!(amount_b_optimal >= amount_b_min, AmmError::SlippageExceeded);
                (amount_a_desired, amount_b_optimal)
            } else {
                let amount_a_optimal = (amount_b_desired as u128)
                    .checked_mul(pool.reserve_a as u128)
                    .ok_or(AmmError::Overflow)?
                    .checked_div(pool.reserve_b as u128)
                    .ok_or(AmmError::Overflow)? as u64;
                require!(amount_a_optimal >= amount_a_min, AmmError::SlippageExceeded);
                (amount_a_optimal, amount_b_desired)
            };

            let lp = std::cmp::min(
                (a as u128)
                    .checked_mul(pool.lp_supply as u128)
                    .ok_or(AmmError::Overflow)?
                    .checked_div(pool.reserve_a as u128)
                    .ok_or(AmmError::Overflow)?,
                (b as u128)
                    .checked_mul(pool.lp_supply as u128)
                    .ok_or(AmmError::Overflow)?
                    .checked_div(pool.reserve_b as u128)
                    .ok_or(AmmError::Overflow)?,
            ) as u64;

            (a, b, lp)
        };

        require!(lp_tokens > 0, AmmError::InsufficientLiquidity);

        // CPIs go through &AccountInfo helpers so each lands in its own
        // BPF stack frame. Three back-to-back CpiContext::new_with_signer
        // literals + cloned AccountInfos overflow Anchor 0.31's 4KB
        // per-frame limit. Anvil's IR classifier recognizes these helpers
        // (helper-cpi-catalog) and inlines call sites as typed
        // cpi_spl_transfer / cpi_spl_mint_to IR statements; the helper
        // bodies themselves get commented out as unsalvageable but the
        // call sites resolve to Anvil's spl_token_* helpers.
        let token_program_info = ctx.accounts.token_program.to_account_info();
        transfer_to_vault(
            &token_program_info,
            &ctx.accounts.user_token_a.to_account_info(),
            &ctx.accounts.vault_a.to_account_info(),
            &ctx.accounts.user.to_account_info(),
            amount_a,
        )?;
        transfer_to_vault(
            &token_program_info,
            &ctx.accounts.user_token_b.to_account_info(),
            &ctx.accounts.vault_b.to_account_info(),
            &ctx.accounts.user.to_account_info(),
            amount_b,
        )?;

        // Mint LP tokens
        let token_mint_a = pool.token_mint_a;
        let token_mint_b = pool.token_mint_b;
        let pool_bump = pool.bump;
        let pool_seeds: &[&[u8]] = &[
            b"pool",
            token_mint_a.as_ref(),
            token_mint_b.as_ref(),
            &[pool_bump],
        ];
        let signer_seeds: &[&[&[u8]]] = &[pool_seeds];

        mint_lp_to_user(
            &token_program_info,
            &ctx.accounts.lp_mint.to_account_info(),
            &ctx.accounts.user_lp_token.to_account_info(),
            &ctx.accounts.pool.to_account_info(),
            signer_seeds,
            lp_tokens,
        )?;

        let pool = &mut ctx.accounts.pool;
        pool.reserve_a = pool.reserve_a
            .checked_add(amount_a)
            .ok_or(AmmError::Overflow)?;
        pool.reserve_b = pool.reserve_b
            .checked_add(amount_b)
            .ok_or(AmmError::Overflow)?;
        pool.lp_supply = pool.lp_supply
            .checked_add(lp_tokens)
            .ok_or(AmmError::Overflow)?;

        emit!(LiquidityAdded {
            user: ctx.accounts.user.key(),
            amount_a,
            amount_b,
            lp_tokens,
        });

        Ok(())
    }

    pub fn remove_liquidity(
        ctx: Context<RemoveLiquidity>,
        lp_amount: u64,
        min_amount_a: u64,
        min_amount_b: u64,
    ) -> Result<()> {
        require!(!ctx.accounts.pool.is_frozen, AmmError::PoolFrozen);
        require!(lp_amount > 0, AmmError::InvalidAmount);

        let pool = &ctx.accounts.pool;

        let amount_a = (lp_amount as u128)
            .checked_mul(pool.reserve_a as u128)
            .ok_or(AmmError::Overflow)?
            .checked_div(pool.lp_supply as u128)
            .ok_or(AmmError::Overflow)? as u64;

        let amount_b = (lp_amount as u128)
            .checked_mul(pool.reserve_b as u128)
            .ok_or(AmmError::Overflow)?
            .checked_div(pool.lp_supply as u128)
            .ok_or(AmmError::Overflow)? as u64;

        require!(amount_a >= min_amount_a, AmmError::SlippageExceeded);
        require!(amount_b >= min_amount_b, AmmError::SlippageExceeded);

        // Stack-frame split via helpers (same rationale as add_liquidity).
        let token_program_info = ctx.accounts.token_program.to_account_info();
        let token_mint_a = pool.token_mint_a;
        let token_mint_b = pool.token_mint_b;
        let pool_bump = pool.bump;
        let pool_seeds: &[&[u8]] = &[
            b"pool",
            token_mint_a.as_ref(),
            token_mint_b.as_ref(),
            &[pool_bump],
        ];
        let signer_seeds: &[&[&[u8]]] = &[pool_seeds];

        burn_lp_from_user(
            &token_program_info,
            &ctx.accounts.lp_mint.to_account_info(),
            &ctx.accounts.user_lp_token.to_account_info(),
            &ctx.accounts.user.to_account_info(),
            lp_amount,
        )?;
        transfer_from_vault(
            &token_program_info,
            &ctx.accounts.vault_a.to_account_info(),
            &ctx.accounts.user_token_a.to_account_info(),
            &ctx.accounts.pool.to_account_info(),
            signer_seeds,
            amount_a,
        )?;
        transfer_from_vault(
            &token_program_info,
            &ctx.accounts.vault_b.to_account_info(),
            &ctx.accounts.user_token_b.to_account_info(),
            &ctx.accounts.pool.to_account_info(),
            signer_seeds,
            amount_b,
        )?;

        let pool = &mut ctx.accounts.pool;
        pool.reserve_a = pool.reserve_a
            .checked_sub(amount_a)
            .ok_or(AmmError::Underflow)?;
        pool.reserve_b = pool.reserve_b
            .checked_sub(amount_b)
            .ok_or(AmmError::Underflow)?;
        pool.lp_supply = pool.lp_supply
            .checked_sub(lp_amount)
            .ok_or(AmmError::Underflow)?;

        emit!(LiquidityRemoved {
            user: ctx.accounts.user.key(),
            amount_a,
            amount_b,
            lp_tokens: lp_amount,
        });

        Ok(())
    }

    pub fn swap(
        ctx: Context<Swap>,
        amount_in: u64,
        minimum_amount_out: u64,
        a_to_b: bool,
    ) -> Result<()> {
        require!(!ctx.accounts.pool.is_frozen, AmmError::PoolFrozen);
        require!(amount_in > 0, AmmError::InvalidAmount);

        let pool = &ctx.accounts.pool;

        let (reserve_in, reserve_out) = if a_to_b {
            (pool.reserve_a, pool.reserve_b)
        } else {
            (pool.reserve_b, pool.reserve_a)
        };

        require!(reserve_in > 0 && reserve_out > 0, AmmError::InsufficientLiquidity);

        // Apply fee
        let fee_amount = amount_in
            .checked_mul(pool.fee_rate)
            .ok_or(AmmError::Overflow)?
            .checked_div(10000)
            .ok_or(AmmError::Overflow)?;

        let protocol_fee = fee_amount
            .checked_mul(pool.protocol_fee_rate)
            .ok_or(AmmError::Overflow)?
            .checked_div(10000)
            .ok_or(AmmError::Overflow)?;

        let lp_fee = fee_amount
            .checked_sub(protocol_fee)
            .ok_or(AmmError::Underflow)?;

        let amount_in_after_fee = amount_in
            .checked_sub(fee_amount)
            .ok_or(AmmError::Underflow)?;

        // Constant product formula: x * y = k
        let amount_out = (amount_in_after_fee as u128)
            .checked_mul(reserve_out as u128)
            .ok_or(AmmError::Overflow)?
            .checked_div(
                (reserve_in as u128)
                    .checked_add(amount_in_after_fee as u128)
                    .ok_or(AmmError::Overflow)?
            )
            .ok_or(AmmError::Overflow)? as u64;

        require!(amount_out >= minimum_amount_out, AmmError::SlippageExceeded);
        require!(amount_out < reserve_out, AmmError::InsufficientLiquidity);

        // Stack-frame split via helpers.
        let token_program_info = ctx.accounts.token_program.to_account_info();
        let token_mint_a = pool.token_mint_a;
        let token_mint_b = pool.token_mint_b;
        let pool_bump = pool.bump;
        let pool_seeds: &[&[u8]] = &[
            b"pool",
            token_mint_a.as_ref(),
            token_mint_b.as_ref(),
            &[pool_bump],
        ];
        let signer_seeds: &[&[&[u8]]] = &[pool_seeds];

        let (vault_in, vault_out) = if a_to_b {
            (ctx.accounts.vault_a.to_account_info(), ctx.accounts.vault_b.to_account_info())
        } else {
            (ctx.accounts.vault_b.to_account_info(), ctx.accounts.vault_a.to_account_info())
        };

        transfer_to_vault(
            &token_program_info,
            &ctx.accounts.user_token_in.to_account_info(),
            &vault_in,
            &ctx.accounts.user.to_account_info(),
            amount_in,
        )?;
        transfer_from_vault(
            &token_program_info,
            &vault_out,
            &ctx.accounts.user_token_out.to_account_info(),
            &ctx.accounts.pool.to_account_info(),
            signer_seeds,
            amount_out,
        )?;

        let pool = &mut ctx.accounts.pool;
        if a_to_b {
            pool.reserve_a = pool.reserve_a
                .checked_add(amount_in_after_fee)
                .ok_or(AmmError::Overflow)?
                .checked_add(lp_fee)
                .ok_or(AmmError::Overflow)?;
            pool.reserve_b = pool.reserve_b
                .checked_sub(amount_out)
                .ok_or(AmmError::Underflow)?;
            pool.total_fees_a = pool.total_fees_a
                .checked_add(lp_fee)
                .ok_or(AmmError::Overflow)?;
            // Track protocol fees explicitly. The vault holds the full
            // amount_in including this protocol_fee; without an accumulator,
            // protocol fees become unwithdrawable dust silently diluting LPs.
            pool.protocol_fees_a = pool.protocol_fees_a
                .checked_add(protocol_fee)
                .ok_or(AmmError::Overflow)?;
        } else {
            pool.reserve_b = pool.reserve_b
                .checked_add(amount_in_after_fee)
                .ok_or(AmmError::Overflow)?
                .checked_add(lp_fee)
                .ok_or(AmmError::Overflow)?;
            pool.reserve_a = pool.reserve_a
                .checked_sub(amount_out)
                .ok_or(AmmError::Underflow)?;
            pool.total_fees_b = pool.total_fees_b
                .checked_add(lp_fee)
                .ok_or(AmmError::Overflow)?;
            pool.protocol_fees_b = pool.protocol_fees_b
                .checked_add(protocol_fee)
                .ok_or(AmmError::Overflow)?;
        }

        emit!(Swapped {
            user: ctx.accounts.user.key(),
            amount_in,
            amount_out,
            fee_amount,
            a_to_b,
        });

        Ok(())
    }

    pub fn freeze_pool(ctx: Context<AdminOnly>) -> Result<()> {
        ctx.accounts.pool.is_frozen = true;
        Ok(())
    }

    pub fn unfreeze_pool(ctx: Context<AdminOnly>) -> Result<()> {
        ctx.accounts.pool.is_frozen = false;
        Ok(())
    }

    pub fn update_fee_rate(ctx: Context<AdminOnly>, new_fee_rate: u64) -> Result<()> {
        require!(new_fee_rate <= 10000, AmmError::InvalidFeeRate);
        ctx.accounts.pool.fee_rate = new_fee_rate;
        Ok(())
    }

    /// Withdraw accumulated protocol fees to a token account chosen by admin.
    /// Drains `pool.protocol_fees_a` and `pool.protocol_fees_b` to the
    /// supplied admin destination accounts. Without this, protocol-fee
    /// share of every swap remained as untracked dust in the vaults.
    pub fn withdraw_protocol_fees(ctx: Context<WithdrawProtocolFees>) -> Result<()> {
        let pool = &ctx.accounts.pool;
        let amount_a = pool.protocol_fees_a;
        let amount_b = pool.protocol_fees_b;
        require!(amount_a > 0 || amount_b > 0, AmmError::NoProtocolFees);

        let token_program_info = ctx.accounts.token_program.to_account_info();
        let token_mint_a = pool.token_mint_a;
        let token_mint_b = pool.token_mint_b;
        let pool_bump = pool.bump;
        let pool_seeds: &[&[u8]] = &[
            b"pool",
            token_mint_a.as_ref(),
            token_mint_b.as_ref(),
            &[pool_bump],
        ];
        let signer_seeds: &[&[&[u8]]] = &[pool_seeds];

        // Always issue both transfers (token::transfer with amount=0 is a
        // no-op). Wrapping in `if amount > 0 {}` would put the call sites
        // inside an if-expression body, which Anvil's body classifier
        // treats as opaque pass_through — the helper-cpi-catalog would
        // then never see the call and wouldn't inline. Cheaper than
        // lifting if-block recursion into the classifier.
        transfer_from_vault(
            &token_program_info,
            &ctx.accounts.vault_a.to_account_info(),
            &ctx.accounts.admin_token_a.to_account_info(),
            &ctx.accounts.pool.to_account_info(),
            signer_seeds,
            amount_a,
        )?;
        transfer_from_vault(
            &token_program_info,
            &ctx.accounts.vault_b.to_account_info(),
            &ctx.accounts.admin_token_b.to_account_info(),
            &ctx.accounts.pool.to_account_info(),
            signer_seeds,
            amount_b,
        )?;

        let pool = &mut ctx.accounts.pool;
        pool.protocol_fees_a = 0;
        pool.protocol_fees_b = 0;
        Ok(())
    }
}

// ── Accounts ────────────────────────────────────────────────────────────────

#[derive(Accounts)]
pub struct InitializePool<'info> {
    #[account(
        init,
        payer = admin,
        space = 8 + AmmPool::INIT_SPACE,
        seeds = [b"pool", token_mint_a.key().as_ref(), token_mint_b.key().as_ref()],
        bump
    )]
    pub pool: Account<'info, AmmPool>,

    #[account(
        init,
        payer = admin,
        token::mint = token_mint_a,
        token::authority = pool,
        seeds = [b"vault_a", pool.key().as_ref()],
        bump
    )]
    pub vault_a: Account<'info, TokenAccount>,

    #[account(
        init,
        payer = admin,
        token::mint = token_mint_b,
        token::authority = pool,
        seeds = [b"vault_b", pool.key().as_ref()],
        bump
    )]
    pub vault_b: Account<'info, TokenAccount>,

    #[account(
        init,
        payer = admin,
        mint::decimals = 6,
        mint::authority = pool,
    )]
    pub lp_mint: Account<'info, Mint>,

    pub token_mint_a: Account<'info, Mint>,
    pub token_mint_b: Account<'info, Mint>,

    #[account(mut)]
    pub admin: Signer<'info>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct AddLiquidity<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    #[account(
        mut,
        seeds = [b"pool", pool.token_mint_a.as_ref(), pool.token_mint_b.as_ref()],
        bump = pool.bump,
    )]
    pub pool: Account<'info, AmmPool>,

    #[account(mut, token::mint = pool.token_mint_a, token::authority = user)]
    pub user_token_a: Account<'info, TokenAccount>,

    #[account(mut, token::mint = pool.token_mint_b, token::authority = user)]
    pub user_token_b: Account<'info, TokenAccount>,

    #[account(
        mut,
        seeds = [b"vault_a", pool.key().as_ref()],
        bump = pool.vault_a_bump,
    )]
    pub vault_a: Account<'info, TokenAccount>,

    #[account(
        mut,
        seeds = [b"vault_b", pool.key().as_ref()],
        bump = pool.vault_b_bump,
    )]
    pub vault_b: Account<'info, TokenAccount>,

    #[account(mut, address = pool.lp_mint)]
    pub lp_mint: Account<'info, Mint>,

    #[account(mut, token::mint = lp_mint, token::authority = user)]
    pub user_lp_token: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct RemoveLiquidity<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    #[account(
        mut,
        seeds = [b"pool", pool.token_mint_a.as_ref(), pool.token_mint_b.as_ref()],
        bump = pool.bump,
    )]
    pub pool: Account<'info, AmmPool>,

    #[account(mut, token::mint = pool.token_mint_a, token::authority = user)]
    pub user_token_a: Account<'info, TokenAccount>,

    #[account(mut, token::mint = pool.token_mint_b, token::authority = user)]
    pub user_token_b: Account<'info, TokenAccount>,

    #[account(mut, seeds = [b"vault_a", pool.key().as_ref()], bump = pool.vault_a_bump)]
    pub vault_a: Account<'info, TokenAccount>,

    #[account(mut, seeds = [b"vault_b", pool.key().as_ref()], bump = pool.vault_b_bump)]
    pub vault_b: Account<'info, TokenAccount>,

    #[account(mut, address = pool.lp_mint)]
    pub lp_mint: Account<'info, Mint>,

    #[account(mut, token::mint = lp_mint, token::authority = user)]
    pub user_lp_token: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct Swap<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    #[account(
        mut,
        seeds = [b"pool", pool.token_mint_a.as_ref(), pool.token_mint_b.as_ref()],
        bump = pool.bump,
    )]
    pub pool: Account<'info, AmmPool>,

    #[account(mut, token::authority = user)]
    pub user_token_in: Account<'info, TokenAccount>,

    #[account(mut, token::authority = user)]
    pub user_token_out: Account<'info, TokenAccount>,

    #[account(mut, seeds = [b"vault_a", pool.key().as_ref()], bump = pool.vault_a_bump)]
    pub vault_a: Account<'info, TokenAccount>,

    #[account(mut, seeds = [b"vault_b", pool.key().as_ref()], bump = pool.vault_b_bump)]
    pub vault_b: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct AdminOnly<'info> {
    #[account(
        mut,
        has_one = admin @ AmmError::Unauthorized,
        seeds = [b"pool", pool.token_mint_a.as_ref(), pool.token_mint_b.as_ref()],
        bump = pool.bump,
    )]
    pub pool: Account<'info, AmmPool>,

    #[account(mut)]
    pub admin: Signer<'info>,
}

#[derive(Accounts)]
pub struct WithdrawProtocolFees<'info> {
    #[account(
        mut,
        has_one = admin @ AmmError::Unauthorized,
        seeds = [b"pool", pool.token_mint_a.as_ref(), pool.token_mint_b.as_ref()],
        bump = pool.bump,
    )]
    pub pool: Account<'info, AmmPool>,

    #[account(mut, seeds = [b"vault_a", pool.key().as_ref()], bump = pool.vault_a_bump)]
    pub vault_a: Account<'info, TokenAccount>,

    #[account(mut, seeds = [b"vault_b", pool.key().as_ref()], bump = pool.vault_b_bump)]
    pub vault_b: Account<'info, TokenAccount>,

    #[account(mut, token::mint = pool.token_mint_a, token::authority = admin)]
    pub admin_token_a: Account<'info, TokenAccount>,

    #[account(mut, token::mint = pool.token_mint_b, token::authority = admin)]
    pub admin_token_b: Account<'info, TokenAccount>,

    #[account(mut)]
    pub admin: Signer<'info>,

    pub token_program: Program<'info, Token>,
}

// ── State ────────────────────────────────────────────────────────────────────

#[account]
#[derive(InitSpace)]
pub struct AmmPool {
    pub admin: Pubkey,
    pub token_mint_a: Pubkey,
    pub token_mint_b: Pubkey,
    pub lp_mint: Pubkey,
    pub fee_rate: u64,
    pub initial_price: u64,
    pub reserve_a: u64,
    pub reserve_b: u64,
    pub lp_supply: u64,
    pub total_fees_a: u64,
    pub total_fees_b: u64,
    pub protocol_fees_a: u64,
    pub protocol_fees_b: u64,
    pub protocol_fee_rate: u64,
    pub bump: u8,
    pub vault_a_bump: u8,
    pub vault_b_bump: u8,
    pub is_frozen: bool,
}

// ── Events ───────────────────────────────────────────────────────────────────

#[event]
pub struct LiquidityAdded {
    pub user: Pubkey,
    pub amount_a: u64,
    pub amount_b: u64,
    pub lp_tokens: u64,
}

#[event]
pub struct LiquidityRemoved {
    pub user: Pubkey,
    pub amount_a: u64,
    pub amount_b: u64,
    pub lp_tokens: u64,
}

#[event]
pub struct Swapped {
    pub user: Pubkey,
    pub amount_in: u64,
    pub amount_out: u64,
    pub fee_amount: u64,
    pub a_to_b: bool,
}

// ── Errors ───────────────────────────────────────────────────────────────────

#[error_code]
pub enum AmmError {
    #[msg("Invalid fee rate")]
    InvalidFeeRate,
    #[msg("Invalid price")]
    InvalidPrice,
    #[msg("Invalid amount")]
    InvalidAmount,
    #[msg("Pool is frozen")]
    PoolFrozen,
    #[msg("Slippage exceeded")]
    SlippageExceeded,
    #[msg("Insufficient liquidity")]
    InsufficientLiquidity,
    #[msg("Unauthorized")]
    Unauthorized,
    #[msg("No protocol fees accrued")]
    NoProtocolFees,
    #[msg("Arithmetic overflow")]
    Overflow,
    #[msg("Arithmetic underflow")]
    Underflow,
}

// ── Helpers ──────────────────────────────────────────────────────────────────

fn integer_sqrt(n: u128) -> u128 {
    if n == 0 {
        return 0;
    }
    let mut x = n;
    let mut y = (x + 1) / 2;
    while y < x {
        x = y;
        y = (x + n / x) / 2;
    }
    x
}

// CPI helpers — each gets its own BPF stack frame so the Anchor 0.31
// macro wrapper + cloned AccountInfos in CpiContext::new_with_signer
// don't blow the 4KB-per-frame limit on add_liquidity / remove_liquidity
// / swap. Signatures use &AccountInfo<'info> so Anvil's emit:
//   - matches them in helper-cpi-catalog (recognizeTransferHelper /
//     recognizeMintToHelper / recognizeBurnHelper);
//   - inlines call sites as typed cpi_spl_* IR statements that resolve
//     to Anvil's auto-injected spl_token_transfer / mint_to / burn helpers;
//   - comments out the helper bodies as unsalvageable (they reference
//     anchor_spl::token::), but the call sites work via the inlined IR.

#[inline(never)]
fn transfer_to_vault<'info>(
    token_program: &AccountInfo<'info>,
    from: &AccountInfo<'info>,
    to: &AccountInfo<'info>,
    authority: &AccountInfo<'info>,
    amount: u64,
) -> Result<()> {
    token::transfer(
        CpiContext::new(
            token_program.clone(),
            Transfer { from: from.clone(), to: to.clone(), authority: authority.clone() },
        ),
        amount,
    )
}

#[inline(never)]
fn transfer_from_vault<'info>(
    token_program: &AccountInfo<'info>,
    from: &AccountInfo<'info>,
    to: &AccountInfo<'info>,
    authority: &AccountInfo<'info>,
    signer_seeds: &[&[&[u8]]],
    amount: u64,
) -> Result<()> {
    token::transfer(
        CpiContext::new_with_signer(
            token_program.clone(),
            Transfer { from: from.clone(), to: to.clone(), authority: authority.clone() },
            signer_seeds,
        ),
        amount,
    )
}

#[inline(never)]
fn mint_lp_to_user<'info>(
    token_program: &AccountInfo<'info>,
    mint: &AccountInfo<'info>,
    to: &AccountInfo<'info>,
    authority: &AccountInfo<'info>,
    signer_seeds: &[&[&[u8]]],
    amount: u64,
) -> Result<()> {
    token::mint_to(
        CpiContext::new_with_signer(
            token_program.clone(),
            MintTo { mint: mint.clone(), to: to.clone(), authority: authority.clone() },
            signer_seeds,
        ),
        amount,
    )
}

#[inline(never)]
fn burn_lp_from_user<'info>(
    token_program: &AccountInfo<'info>,
    mint: &AccountInfo<'info>,
    from: &AccountInfo<'info>,
    authority: &AccountInfo<'info>,
    amount: u64,
) -> Result<()> {
    token::burn(
        CpiContext::new(
            token_program.clone(),
            Burn { mint: mint.clone(), from: from.clone(), authority: authority.clone() },
        ),
        amount,
    )
}
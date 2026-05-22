use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};

declare_id!("FundXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX");

// ─── Constants ───────────────────────────────────────────────────────────────

pub const MARKET_SEED: &[u8] = b"market";
pub const POSITION_SEED: &[u8] = b"position";
pub const VAULT_SEED: &[u8] = b"vault";
pub const FEE_VAULT_SEED: &[u8] = b"fee_vault";
pub const INSURANCE_SEED: &[u8] = b"insurance";
pub const LP_MINT_SEED: &[u8] = b"lp_mint";
pub const LP_POSITION_SEED: &[u8] = b"lp_position";

/// Funding rate precision: 1e9
pub const RATE_PRECISION: u128 = 1_000_000_000;
/// Price precision: 1e6
pub const PRICE_PRECISION: u128 = 1_000_000;
/// Max leverage: 20x (stored as 20_000 with 1e3 precision)
pub const MAX_LEVERAGE: u64 = 20_000;
/// Maintenance margin: 5% (50 with 1e3 precision)
pub const MAINT_MARGIN_BPS: u64 = 500; // 5%
/// Initial margin: 10%
pub const INIT_MARGIN_BPS: u64 = 1_000; // 10%
/// Liquidation fee: 1.5% of position size goes to liquidator
pub const LIQ_FEE_BPS: u64 = 150;
/// Insurance fund takes 0.5%
pub const INSURANCE_FEE_BPS: u64 = 50;
/// Max funding rate per hour: 0.1% (1e6 precision)
pub const MAX_FUNDING_RATE: i64 = 1_000; // 0.1% per hour
/// Funding interval: 1 hour
pub const FUNDING_INTERVAL: i64 = 3600;
/// Min position size: 1 USDC (1e6)
pub const MIN_POSITION_SIZE: u64 = 1_000_000;
/// Tier thresholds (open interest in USDC, 1e6)
pub const TIER1_OI_THRESHOLD: u64 = 100_000 * 1_000_000; // 100k USDC
pub const TIER2_OI_THRESHOLD: u64 = 500_000 * 1_000_000; // 500k USDC
/// Fee tiers in BPS
pub const TIER0_TAKER_FEE: u64 = 10; // 0.10%
pub const TIER1_TAKER_FEE: u64 = 8;  // 0.08%
pub const TIER2_TAKER_FEE: u64 = 6;  // 0.06%
pub const TIER0_MAKER_FEE: u64 = 2;  // 0.02%
pub const TIER1_MAKER_FEE: u64 = 1;  // 0.01%
pub const TIER2_MAKER_FEE: u64 = 0;  // 0.00%

// ─── Program ─────────────────────────────────────────────────────────────────

#[program]
pub mod perp_funding {
    use super::*;

    /// Initialize a new perpetuals market for a given base asset.
    pub fn initialize_market(
        ctx: Context<InitializeMarket>,
        market_index: u16,
        oracle_price_feed: Pubkey,
        max_open_interest: u64,
        base_decimals: u8,
    ) -> Result<()> {
        require!(max_open_interest > 0, FundingError::InvalidParam);
        require!(base_decimals <= 9, FundingError::InvalidParam);

        let market = &mut ctx.accounts.market;
        market.authority = ctx.accounts.authority.key();
        market.market_index = market_index;
        market.oracle_price_feed = oracle_price_feed;
        market.collateral_mint = ctx.accounts.collateral_mint.key();
        market.vault = ctx.accounts.vault.key();
        market.fee_vault = ctx.accounts.fee_vault.key();
        market.insurance_fund = ctx.accounts.insurance_fund.key();
        market.lp_mint = ctx.accounts.lp_mint.key();
        market.max_open_interest = max_open_interest;
        market.base_decimals = base_decimals;
        market.total_long_oi = 0;
        market.total_short_oi = 0;
        market.cumulative_funding_rate_long = 0;
        market.cumulative_funding_rate_short = 0;
        market.last_funding_ts = Clock::get()?.unix_timestamp;
        market.funding_rate = 0;
        market.total_lp_shares = 0;
        market.total_liquidity = 0;
        market.paused = false;
        market.bump = ctx.bumps.market;

        emit!(MarketInitialized {
            market_index,
            authority: market.authority,
            oracle: oracle_price_feed,
        });

        Ok(())
    }

    /// Deposit liquidity into the market, receive LP shares.
    pub fn deposit_liquidity(
        ctx: Context<DepositLiquidity>,
        amount: u64,
    ) -> Result<()> {
        require!(amount >= MIN_POSITION_SIZE, FundingError::BelowMinSize);
        require!(!ctx.accounts.market.paused, FundingError::MarketPaused);

        let market = &mut ctx.accounts.market;
        let lp_position = &mut ctx.accounts.lp_position;

        // Shares to mint = (amount / total_liquidity) * total_shares
        // If first deposit, shares = amount
        let shares_to_mint = if market.total_lp_shares == 0 || market.total_liquidity == 0 {
            amount as u128
        } else {
            (amount as u128)
                .checked_mul(market.total_lp_shares as u128)
                .ok_or(FundingError::MathOverflow)?
                .checked_div(market.total_liquidity as u128)
                .ok_or(FundingError::MathOverflow)?
        };

        require!(shares_to_mint > 0, FundingError::ZeroShares);

        // Transfer collateral from provider to vault
        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.provider_collateral.to_account_info(),
                    to: ctx.accounts.vault.to_account_info(),
                    authority: ctx.accounts.provider.to_account_info(),
                },
            ),
            amount,
        )?;

        market.total_liquidity = market
            .total_liquidity
            .checked_add(amount)
            .ok_or(FundingError::MathOverflow)?;
        market.total_lp_shares = market
            .total_lp_shares
            .checked_add(shares_to_mint as u64)
            .ok_or(FundingError::MathOverflow)?;

        lp_position.owner = ctx.accounts.provider.key();
        lp_position.market = market.key();
        lp_position.shares = lp_position
            .shares
            .checked_add(shares_to_mint as u64)
            .ok_or(FundingError::MathOverflow)?;
        lp_position.deposited_amount = lp_position
            .deposited_amount
            .checked_add(amount)
            .ok_or(FundingError::MathOverflow)?;
        lp_position.bump = ctx.bumps.lp_position;

        emit!(LiquidityDeposited {
            provider: ctx.accounts.provider.key(),
            amount,
            shares_minted: shares_to_mint as u64,
        });

        Ok(())
    }

    /// Withdraw liquidity by burning LP shares.
    pub fn withdraw_liquidity(
        ctx: Context<WithdrawLiquidity>,
        shares: u64,
    ) -> Result<()> {
        let lp_position = &mut ctx.accounts.lp_position;
        require!(lp_position.shares >= shares, FundingError::InsufficientShares);

        let market = &mut ctx.accounts.market;

        // Amount = (shares / total_shares) * total_liquidity
        let amount_out = (shares as u128)
            .checked_mul(market.total_liquidity as u128)
            .ok_or(FundingError::MathOverflow)?
            .checked_div(market.total_lp_shares as u128)
            .ok_or(FundingError::MathOverflow)? as u64;

        require!(amount_out > 0, FundingError::ZeroWithdraw);
        require!(
            market.total_liquidity >= amount_out,
            FundingError::InsufficientLiquidity
        );

        // Ensure liquidity withdrawal doesn't break OI limits
        let remaining_liquidity = market.total_liquidity.saturating_sub(amount_out);
        let max_oi = market.max_open_interest.min(remaining_liquidity);
        require!(
            market.total_long_oi <= max_oi && market.total_short_oi <= max_oi,
            FundingError::WithdrawExceedsOILimit
        );

        // Transfer back using vault PDA signer
        let market_key = market.key();
        let vault_seeds = &[
            VAULT_SEED,
            market_key.as_ref(),
            b"auth",
            &[ctx.bumps.vault_bump_cpi],
        ];
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.vault.to_account_info(),
                    to: ctx.accounts.provider_collateral.to_account_info(),
                    authority: ctx.accounts.vault_authority.to_account_info(),
                },
                &[vault_seeds],
            ),
            amount_out,
        )?;

        market.total_liquidity = market
            .total_liquidity
            .checked_sub(amount_out)
            .ok_or(FundingError::MathOverflow)?;
        market.total_lp_shares = market
            .total_lp_shares
            .checked_sub(shares)
            .ok_or(FundingError::MathOverflow)?;

        lp_position.shares = lp_position
            .shares
            .checked_sub(shares)
            .ok_or(FundingError::MathOverflow)?;
        lp_position.deposited_amount = lp_position.deposited_amount.saturating_sub(amount_out);

        emit!(LiquidityWithdrawn {
            provider: ctx.accounts.provider.key(),
            amount: amount_out,
            shares_burned: shares,
        });

        Ok(())
    }

    /// Open or increase a leveraged position (long or short).
    pub fn open_position(
        ctx: Context<OpenPosition>,
        size_usd: u64,       // position size in USDC (1e6)
        collateral: u64,     // collateral to deposit (1e6 USDC)
        is_long: bool,
        oracle_price: u64,   // provided by client, verified on-chain via oracle field
    ) -> Result<()> {
        require!(!ctx.accounts.market.paused, FundingError::MarketPaused);
        require!(size_usd >= MIN_POSITION_SIZE, FundingError::BelowMinSize);
        require!(collateral > 0, FundingError::InvalidParam);

        let market = &mut ctx.accounts.market;
        let position = &mut ctx.accounts.position;
        let clock = Clock::get()?;

        // ── Settle funding before opening ─────────────────────────────────────
        settle_funding_rate(market, clock.unix_timestamp)?;

        // ── Leverage check ────────────────────────────────────────────────────
        // leverage = size_usd / collateral (both in 1e6), stored as 1e3
        let leverage = (size_usd as u128)
            .checked_mul(1_000)
            .ok_or(FundingError::MathOverflow)?
            .checked_div(collateral as u128)
            .ok_or(FundingError::MathOverflow)? as u64;

        require!(leverage <= MAX_LEVERAGE, FundingError::LeverageTooHigh);
        require!(
            leverage * collateral / 1_000 >= size_usd.saturating_sub(1),
            FundingError::InvalidParam
        );

        // ── Open interest check ───────────────────────────────────────────────
        let new_oi = if is_long {
            market.total_long_oi.checked_add(size_usd).ok_or(FundingError::MathOverflow)?
        } else {
            market.total_short_oi.checked_add(size_usd).ok_or(FundingError::MathOverflow)?
        };
        require!(new_oi <= market.max_open_interest, FundingError::OILimitExceeded);
        require!(new_oi <= market.total_liquidity, FundingError::InsufficientLiquidity);

        // ── Fee calculation ───────────────────────────────────────────────────
        let current_oi = market.total_long_oi.max(market.total_short_oi);
        let (taker_fee_bps, _maker_fee_bps) = get_fee_tier(current_oi);
        let open_fee = size_usd
            .checked_mul(taker_fee_bps)
            .ok_or(FundingError::MathOverflow)?
            / 10_000;

        let required_collateral = collateral.checked_add(open_fee).ok_or(FundingError::MathOverflow)?;

        // ── Transfer collateral + fee ─────────────────────────────────────────
        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.trader_collateral.to_account_info(),
                    to: ctx.accounts.vault.to_account_info(),
                    authority: ctx.accounts.trader.to_account_info(),
                },
            ),
            required_collateral,
        )?;

        // Move fee portion to fee vault
        let market_key = market.key();
        let vault_seeds = &[VAULT_SEED, market_key.as_ref(), b"auth", &[ctx.bumps.vault_bump_cpi]];
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.vault.to_account_info(),
                    to: ctx.accounts.fee_vault.to_account_info(),
                    authority: ctx.accounts.vault_authority.to_account_info(),
                },
                &[vault_seeds],
            ),
            open_fee,
        )?;

        // ── Update market OI ──────────────────────────────────────────────────
        if is_long {
            market.total_long_oi = new_oi;
        } else {
            market.total_short_oi = new_oi;
        }
        market.total_liquidity = market
            .total_liquidity
            .checked_add(collateral)
            .ok_or(FundingError::MathOverflow)?;

        // ── Write position ────────────────────────────────────────────────────
        let cumulative_rate = if is_long {
            market.cumulative_funding_rate_long
        } else {
            market.cumulative_funding_rate_short
        };

        if position.size_usd == 0 {
            // Fresh position
            position.owner = ctx.accounts.trader.key();
            position.market = market.key();
            position.is_long = is_long;
            position.entry_price = oracle_price;
            position.bump = ctx.bumps.position;
        } else {
            // Increase existing — blend entry price
            require!(position.is_long == is_long, FundingError::SideConflict);
            let total_size = position.size_usd.checked_add(size_usd).ok_or(FundingError::MathOverflow)?;
            position.entry_price = ((position.entry_price as u128 * position.size_usd as u128
                + oracle_price as u128 * size_usd as u128)
                / total_size as u128) as u64;
        }

        position.size_usd = position.size_usd.checked_add(size_usd).ok_or(FundingError::MathOverflow)?;
        position.collateral = position.collateral.checked_add(collateral).ok_or(FundingError::MathOverflow)?;
        position.last_cumulative_funding_rate = cumulative_rate;
        position.opened_at = clock.unix_timestamp;
        position.last_updated_at = clock.unix_timestamp;
        position.fees_paid = position.fees_paid.checked_add(open_fee).ok_or(FundingError::MathOverflow)?;

        emit!(PositionOpened {
            trader: ctx.accounts.trader.key(),
            size_usd,
            collateral,
            is_long,
            entry_price: oracle_price,
            fee: open_fee,
        });

        Ok(())
    }

    /// Close or reduce a position, settle PnL + funding.
    pub fn close_position(
        ctx: Context<ClosePosition>,
        size_usd: u64,       // how much of the position to close
        oracle_price: u64,
    ) -> Result<()> {
        let position = &mut ctx.accounts.position;
        let market = &mut ctx.accounts.market;
        let clock = Clock::get()?;

        require!(position.owner == ctx.accounts.trader.key(), FundingError::Unauthorized);
        require!(size_usd > 0 && size_usd <= position.size_usd, FundingError::InvalidCloseSize);

        // ── Settle funding ─────────────────────────────────────────────────────
        settle_funding_rate(market, clock.unix_timestamp)?;

        // ── Funding PnL for this position ──────────────────────────────────────
        let current_cumulative = if position.is_long {
            market.cumulative_funding_rate_long
        } else {
            market.cumulative_funding_rate_short
        };
        let funding_pnl = compute_funding_pnl(
            position.size_usd,
            position.last_cumulative_funding_rate,
            current_cumulative,
            position.is_long,
        )?;

        // ── Price PnL ──────────────────────────────────────────────────────────
        let close_ratio_num = size_usd as u128;
        let close_ratio_den = position.size_usd as u128;

        let price_pnl = compute_price_pnl(
            size_usd,
            position.entry_price,
            oracle_price,
            position.is_long,
        )?;

        // Prorated collateral for this partial close
        let collateral_released = (position.collateral as u128 * close_ratio_num / close_ratio_den) as u64;

        // ── Close fee ─────────────────────────────────────────────────────────
        let current_oi = market.total_long_oi.max(market.total_short_oi);
        let (taker_fee_bps, _) = get_fee_tier(current_oi);
        let close_fee = size_usd
            .checked_mul(taker_fee_bps)
            .ok_or(FundingError::MathOverflow)?
            / 10_000;

        // ── Net payout ─────────────────────────────────────────────────────────
        // net = collateral_released + price_pnl + funding_pnl - close_fee
        let gross_payout = apply_pnl(collateral_released, price_pnl, funding_pnl)?;
        let net_payout = gross_payout.saturating_sub(close_fee);

        // Cap payout at vault balance (insurance absorbs overflow losses — not implemented here
        // for simplicity, but in production you'd draw from insurance fund)
        let vault_balance = ctx.accounts.vault.amount;
        let actual_payout = net_payout.min(vault_balance);

        // ── Transfer payout ────────────────────────────────────────────────────
        let market_key = market.key();
        let vault_seeds = &[VAULT_SEED, market_key.as_ref(), b"auth", &[ctx.bumps.vault_bump_cpi]];

        if actual_payout > 0 {
            token::transfer(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info(),
                    Transfer {
                        from: ctx.accounts.vault.to_account_info(),
                        to: ctx.accounts.trader_collateral.to_account_info(),
                        authority: ctx.accounts.vault_authority.to_account_info(),
                    },
                    &[vault_seeds],
                ),
                actual_payout,
            )?;
        }

        // Move close fee to fee vault
        if close_fee > 0 {
            token::transfer(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info(),
                    Transfer {
                        from: ctx.accounts.vault.to_account_info(),
                        to: ctx.accounts.fee_vault.to_account_info(),
                        authority: ctx.accounts.vault_authority.to_account_info(),
                    },
                    &[vault_seeds],
                ),
                close_fee,
            )?;
        }

        // ── Update market state ───────────────────────────────────────────────
        if position.is_long {
            market.total_long_oi = market.total_long_oi.saturating_sub(size_usd);
        } else {
            market.total_short_oi = market.total_short_oi.saturating_sub(size_usd);
        }
        market.total_liquidity = market.total_liquidity.saturating_sub(collateral_released);

        // ── Update position ───────────────────────────────────────────────────
        position.size_usd = position.size_usd.saturating_sub(size_usd);
        position.collateral = position.collateral.saturating_sub(collateral_released);
        position.last_cumulative_funding_rate = current_cumulative;
        position.last_updated_at = clock.unix_timestamp;
        position.fees_paid = position.fees_paid.saturating_add(close_fee);

        emit!(PositionClosed {
            trader: ctx.accounts.trader.key(),
            size_usd,
            oracle_price,
            price_pnl,
            funding_pnl,
            fee: close_fee,
            payout: actual_payout,
        });

        Ok(())
    }

    /// Add collateral to an existing position (reduce leverage / avoid liquidation).
    pub fn add_collateral(
        ctx: Context<ModifyCollateral>,
        amount: u64,
    ) -> Result<()> {
        require!(amount > 0, FundingError::InvalidParam);
        let position = &mut ctx.accounts.position;
        require!(position.owner == ctx.accounts.trader.key(), FundingError::Unauthorized);
        require!(position.size_usd > 0, FundingError::PositionEmpty);

        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.trader_collateral.to_account_info(),
                    to: ctx.accounts.vault.to_account_info(),
                    authority: ctx.accounts.trader.to_account_info(),
                },
            ),
            amount,
        )?;

        position.collateral = position.collateral.checked_add(amount).ok_or(FundingError::MathOverflow)?;
        ctx.accounts.market.total_liquidity = ctx.accounts.market.total_liquidity.checked_add(amount).ok_or(FundingError::MathOverflow)?;
        position.last_updated_at = Clock::get()?.unix_timestamp;

        emit!(CollateralAdded {
            trader: ctx.accounts.trader.key(),
            amount,
            new_collateral: position.collateral,
        });

        Ok(())
    }

    /// Remove collateral from a position (increase leverage), subject to margin check.
    pub fn remove_collateral(
        ctx: Context<ModifyCollateral>,
        amount: u64,
        oracle_price: u64,
    ) -> Result<()> {
        require!(amount > 0, FundingError::InvalidParam);
        let position = &mut ctx.accounts.position;
        require!(position.owner == ctx.accounts.trader.key(), FundingError::Unauthorized);
        require!(position.size_usd > 0, FundingError::PositionEmpty);
        require!(position.collateral > amount, FundingError::InsufficientCollateral);

        let new_collateral = position.collateral.checked_sub(amount).ok_or(FundingError::MathOverflow)?;

        // Check initial margin requirement holds after removal
        let required_margin = position
            .size_usd
            .checked_mul(INIT_MARGIN_BPS)
            .ok_or(FundingError::MathOverflow)?
            / 10_000;
        require!(new_collateral >= required_margin, FundingError::MarginTooLow);

        // Check not immediately liquidatable
        let margin_ratio = compute_margin_ratio(new_collateral, position.size_usd, position.entry_price, oracle_price, position.is_long)?;
        require!(margin_ratio > MAINT_MARGIN_BPS, FundingError::WouldBeLiquidatable);

        let market_key = ctx.accounts.market.key();
        let vault_seeds = &[VAULT_SEED, market_key.as_ref(), b"auth", &[ctx.bumps.vault_bump_cpi]];

        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.vault.to_account_info(),
                    to: ctx.accounts.trader_collateral.to_account_info(),
                    authority: ctx.accounts.vault_authority.to_account_info(),
                },
                &[vault_seeds],
            ),
            amount,
        )?;

        position.collateral = new_collateral;
        ctx.accounts.market.total_liquidity = ctx.accounts.market.total_liquidity.saturating_sub(amount);
        position.last_updated_at = Clock::get()?.unix_timestamp;

        emit!(CollateralRemoved {
            trader: ctx.accounts.trader.key(),
            amount,
            new_collateral,
        });

        Ok(())
    }

    /// Liquidate an undercollateralized position. Anyone can call this.
    pub fn liquidate(
        ctx: Context<Liquidate>,
        oracle_price: u64,
    ) -> Result<()> {
        let position = &mut ctx.accounts.position;
        let market = &mut ctx.accounts.market;
        let clock = Clock::get()?;

        require!(position.size_usd > 0, FundingError::PositionEmpty);

        // ── Settle funding ─────────────────────────────────────────────────────
        settle_funding_rate(market, clock.unix_timestamp)?;

        let current_cumulative = if position.is_long {
            market.cumulative_funding_rate_long
        } else {
            market.cumulative_funding_rate_short
        };

        let funding_pnl = compute_funding_pnl(
            position.size_usd,
            position.last_cumulative_funding_rate,
            current_cumulative,
            position.is_long,
        )?;

        // Effective collateral after funding
        let effective_collateral = apply_pnl(position.collateral, SignedAmount::Zero, funding_pnl)?;

        let margin_ratio = compute_margin_ratio(
            effective_collateral,
            position.size_usd,
            position.entry_price,
            oracle_price,
            position.is_long,
        )?;

        require!(margin_ratio <= MAINT_MARGIN_BPS, FundingError::NotLiquidatable);

        // ── Liquidation fees ──────────────────────────────────────────────────
        let liq_fee_total = position
            .size_usd
            .checked_mul(LIQ_FEE_BPS + INSURANCE_FEE_BPS)
            .ok_or(FundingError::MathOverflow)?
            / 10_000;
        let liquidator_fee = position
            .size_usd
            .checked_mul(LIQ_FEE_BPS)
            .ok_or(FundingError::MathOverflow)?
            / 10_000;
        let insurance_fee = liq_fee_total.saturating_sub(liquidator_fee);

        let vault_balance = ctx.accounts.vault.amount;
        let liquidator_payout = liquidator_fee.min(vault_balance);
        let insurance_payout = insurance_fee.min(vault_balance.saturating_sub(liquidator_payout));

        let market_key = market.key();
        let vault_seeds = &[VAULT_SEED, market_key.as_ref(), b"auth", &[ctx.bumps.vault_bump_cpi]];

        // Pay liquidator
        if liquidator_payout > 0 {
            token::transfer(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info(),
                    Transfer {
                        from: ctx.accounts.vault.to_account_info(),
                        to: ctx.accounts.liquidator_collateral.to_account_info(),
                        authority: ctx.accounts.vault_authority.to_account_info(),
                    },
                    &[vault_seeds],
                ),
                liquidator_payout,
            )?;
        }

        // Pay insurance fund
        if insurance_payout > 0 {
            token::transfer(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info(),
                    Transfer {
                        from: ctx.accounts.vault.to_account_info(),
                        to: ctx.accounts.insurance_fund.to_account_info(),
                        authority: ctx.accounts.vault_authority.to_account_info(),
                    },
                    &[vault_seeds],
                ),
                insurance_payout,
            )?;
        }

        // ── Update OI ─────────────────────────────────────────────────────────
        if position.is_long {
            market.total_long_oi = market.total_long_oi.saturating_sub(position.size_usd);
        } else {
            market.total_short_oi = market.total_short_oi.saturating_sub(position.size_usd);
        }
        market.total_liquidity = market.total_liquidity.saturating_sub(position.collateral);

        emit!(PositionLiquidated {
            trader: position.owner,
            liquidator: ctx.accounts.liquidator.key(),
            size_usd: position.size_usd,
            oracle_price,
            liquidator_fee: liquidator_payout,
            insurance_fee: insurance_payout,
            margin_ratio,
        });

        // ── Zero out position ─────────────────────────────────────────────────
        position.size_usd = 0;
        position.collateral = 0;
        position.last_cumulative_funding_rate = current_cumulative;
        position.last_updated_at = clock.unix_timestamp;

        Ok(())
    }

    /// Update the funding rate. Can be called permissionlessly once per interval.
    pub fn update_funding_rate(
        ctx: Context<UpdateFundingRate>,
        oracle_price: u64,
        index_price: u64, // e.g. spot price feed
    ) -> Result<()> {
        let market = &mut ctx.accounts.market;
        let clock = Clock::get()?;

        require!(
            clock.unix_timestamp >= market.last_funding_ts + FUNDING_INTERVAL,
            FundingError::FundingTooEarly
        );

        settle_funding_rate(market, clock.unix_timestamp)?;

        // Funding rate = clamp((mark - index) / index, -max, +max)
        // Positive rate = longs pay shorts, negative = shorts pay longs
        let new_rate = compute_new_funding_rate(oracle_price, index_price)?;
        market.funding_rate = new_rate;

        emit!(FundingRateUpdated {
            market: market.key(),
            funding_rate: new_rate,
            oracle_price,
            index_price,
            timestamp: clock.unix_timestamp,
        });

        Ok(())
    }

    /// Pause or unpause a market (authority only).
    pub fn set_market_paused(ctx: Context<AuthorityOnly>, paused: bool) -> Result<()> {
        ctx.accounts.market.paused = paused;
        Ok(())
    }

    /// Claim accumulated protocol fees from the fee vault.
    pub fn claim_fees(ctx: Context<ClaimFees>, amount: u64) -> Result<()> {
        require!(
            ctx.accounts.authority.key() == ctx.accounts.market.authority,
            FundingError::Unauthorized
        );
        let fee_balance = ctx.accounts.fee_vault.amount;
        require!(amount <= fee_balance, FundingError::InsufficientFees);

        let market_key = ctx.accounts.market.key();
        let fee_vault_seeds = &[FEE_VAULT_SEED, market_key.as_ref(), b"auth", &[ctx.bumps.fee_vault_bump]];

        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.fee_vault.to_account_info(),
                    to: ctx.accounts.recipient.to_account_info(),
                    authority: ctx.accounts.fee_vault_authority.to_account_info(),
                },
                &[fee_vault_seeds],
            ),
            amount,
        )?;

        emit!(FeesClaimed {
            authority: ctx.accounts.authority.key(),
            amount,
        });

        Ok(())
    }
}

// ─── Helper Math ─────────────────────────────────────────────────────────────

/// Accumulates funding rate into cumulative trackers.
fn settle_funding_rate(market: &mut Account<Market>, now: i64) -> Result<()> {
    let elapsed = now.saturating_sub(market.last_funding_ts);
    if elapsed <= 0 || market.funding_rate == 0 {
        market.last_funding_ts = now;
        return Ok(());
    }

    // funding accrued = rate * elapsed / FUNDING_INTERVAL
    // Positive rate: longs pay, shorts receive
    let rate_magnitude = (market.funding_rate.unsigned_abs() as u128)
        .checked_mul(elapsed as u128)
        .ok_or(FundingError::MathOverflow)?
        .checked_div(FUNDING_INTERVAL as u128)
        .ok_or(FundingError::MathOverflow)? as i64;

    if market.funding_rate > 0 {
        // longs pay shorts
        market.cumulative_funding_rate_long = market
            .cumulative_funding_rate_long
            .checked_add(rate_magnitude)
            .ok_or(FundingError::MathOverflow)?;
        market.cumulative_funding_rate_short = market
            .cumulative_funding_rate_short
            .checked_sub(rate_magnitude)
            .ok_or(FundingError::MathOverflow)?;
    } else {
        // shorts pay longs
        market.cumulative_funding_rate_long = market
            .cumulative_funding_rate_long
            .checked_sub(rate_magnitude)
            .ok_or(FundingError::MathOverflow)?;
        market.cumulative_funding_rate_short = market
            .cumulative_funding_rate_short
            .checked_add(rate_magnitude)
            .ok_or(FundingError::MathOverflow)?;
    }

    market.last_funding_ts = now;
    Ok(())
}

/// Compute funding PnL for a position.
/// Returns a signed amount (positive = gain, negative = loss).
fn compute_funding_pnl(
    size_usd: u64,
    entry_cumulative: i64,
    current_cumulative: i64,
    is_long: bool,
) -> Result<SignedAmount> {
    let delta = current_cumulative.checked_sub(entry_cumulative).ok_or(FundingError::MathOverflow)?;
    if delta == 0 {
        return Ok(SignedAmount::Zero);
    }

    // funding_pnl = size * delta / RATE_PRECISION
    // For longs: positive delta means you paid funding (loss)
    // For shorts: positive delta in short cumulative means you received (gain)
    let pnl_magnitude = (size_usd as u128)
        .checked_mul(delta.unsigned_abs() as u128)
        .ok_or(FundingError::MathOverflow)?
        .checked_div(RATE_PRECISION)
        .ok_or(FundingError::MathOverflow)? as u64;

    let is_gain = if is_long { delta < 0 } else { delta > 0 };
    if is_gain {
        Ok(SignedAmount::Positive(pnl_magnitude))
    } else {
        Ok(SignedAmount::Negative(pnl_magnitude))
    }
}

/// Compute price PnL for a partial close.
fn compute_price_pnl(
    size_usd: u64,
    entry_price: u64,
    exit_price: u64,
    is_long: bool,
) -> Result<SignedAmount> {
    if entry_price == 0 {
        return Ok(SignedAmount::Zero);
    }
    // pnl = size * (exit - entry) / entry  [for long]
    // pnl = size * (entry - exit) / entry  [for short]
    let (numerator, is_gain) = if is_long {
        if exit_price >= entry_price {
            (exit_price - entry_price, true)
        } else {
            (entry_price - exit_price, false)
        }
    } else {
        if entry_price >= exit_price {
            (entry_price - exit_price, true)
        } else {
            (exit_price - entry_price, false)
        }
    };

    let pnl = (size_usd as u128)
        .checked_mul(numerator as u128)
        .ok_or(FundingError::MathOverflow)?
        .checked_div(entry_price as u128)
        .ok_or(FundingError::MathOverflow)? as u64;

    if is_gain {
        Ok(SignedAmount::Positive(pnl))
    } else {
        Ok(SignedAmount::Negative(pnl))
    }
}

/// Apply two signed PnL amounts to a base collateral value, returning u64.
fn apply_pnl(base: u64, price_pnl: SignedAmount, funding_pnl: SignedAmount) -> Result<u64> {
    let mut result = base as i128;

    match price_pnl {
        SignedAmount::Positive(v) => result = result.checked_add(v as i128).ok_or(FundingError::MathOverflow)?,
        SignedAmount::Negative(v) => result = result.checked_sub(v as i128).ok_or(FundingError::MathOverflow)?,
        SignedAmount::Zero => {}
    }

    match funding_pnl {
        SignedAmount::Positive(v) => result = result.checked_add(v as i128).ok_or(FundingError::MathOverflow)?,
        SignedAmount::Negative(v) => result = result.checked_sub(v as i128).ok_or(FundingError::MathOverflow)?,
        SignedAmount::Zero => {}
    }

    Ok(result.max(0) as u64)
}

/// Compute the current margin ratio in BPS given price and collateral.
fn compute_margin_ratio(
    collateral: u64,
    size_usd: u64,
    entry_price: u64,
    current_price: u64,
    is_long: bool,
) -> Result<u64> {
    if size_usd == 0 {
        return Ok(u64::MAX);
    }

    let price_pnl = compute_price_pnl(size_usd, entry_price, current_price, is_long)?;
    let effective_collateral = apply_pnl(collateral, price_pnl, SignedAmount::Zero)?;

    let ratio = (effective_collateral as u128)
        .checked_mul(10_000)
        .ok_or(FundingError::MathOverflow)?
        .checked_div(size_usd as u128)
        .ok_or(FundingError::MathOverflow)? as u64;

    Ok(ratio)
}

/// Compute new hourly funding rate from mark vs index price.
fn compute_new_funding_rate(oracle_price: u64, index_price: u64) -> Result<i64> {
    if index_price == 0 {
        return Ok(0);
    }

    let oracle = oracle_price as i128;
    let index = index_price as i128;

    // rate = (mark - index) / index * RATE_PRECISION
    let rate = (oracle - index)
        .checked_mul(RATE_PRECISION as i128)
        .ok_or(FundingError::MathOverflow)?
        .checked_div(index)
        .ok_or(FundingError::MathOverflow)?;

    // Clamp to [-MAX_FUNDING_RATE, MAX_FUNDING_RATE]
    let clamped = rate
        .max(-(MAX_FUNDING_RATE as i128))
        .min(MAX_FUNDING_RATE as i128) as i64;

    Ok(clamped)
}

/// Return (taker_fee_bps, maker_fee_bps) based on current open interest.
fn get_fee_tier(current_oi: u64) -> (u64, u64) {
    if current_oi >= TIER2_OI_THRESHOLD {
        (TIER2_TAKER_FEE, TIER2_MAKER_FEE)
    } else if current_oi >= TIER1_OI_THRESHOLD {
        (TIER1_TAKER_FEE, TIER1_MAKER_FEE)
    } else {
        (TIER0_TAKER_FEE, TIER0_MAKER_FEE)
    }
}

// ─── Signed Amount Helper ────────────────────────────────────────────────────

#[derive(Clone, Copy, AnchorSerialize, AnchorDeserialize, Debug)]
pub enum SignedAmount {
    Positive(u64),
    Negative(u64),
    Zero,
}

// ─── Account Structs ─────────────────────────────────────────────────────────

#[account]
#[derive(Default)]
pub struct Market {
    pub authority: Pubkey,           // 32
    pub market_index: u16,           // 2
    pub oracle_price_feed: Pubkey,   // 32
    pub collateral_mint: Pubkey,     // 32
    pub vault: Pubkey,               // 32
    pub fee_vault: Pubkey,           // 32
    pub insurance_fund: Pubkey,      // 32
    pub lp_mint: Pubkey,             // 32
    pub max_open_interest: u64,      // 8
    pub base_decimals: u8,           // 1
    pub total_long_oi: u64,          // 8
    pub total_short_oi: u64,         // 8
    pub cumulative_funding_rate_long: i64,   // 8
    pub cumulative_funding_rate_short: i64,  // 8
    pub last_funding_ts: i64,        // 8
    pub funding_rate: i64,           // 8
    pub total_lp_shares: u64,        // 8
    pub total_liquidity: u64,        // 8
    pub paused: bool,                // 1
    pub bump: u8,                    // 1
    // padding to 8-byte alignment
    pub _padding: [u8; 5],           // 5
}

impl Market {
    pub const LEN: usize = 8 + 32 + 2 + 32 + 32 + 32 + 32 + 32 + 32 + 8 + 1 + 8 + 8 + 8 + 8 + 8 + 8 + 8 + 8 + 1 + 1 + 5;
}

#[account]
#[derive(Default)]
pub struct Position {
    pub owner: Pubkey,                       // 32
    pub market: Pubkey,                      // 32
    pub size_usd: u64,                       // 8
    pub collateral: u64,                     // 8
    pub entry_price: u64,                    // 8
    pub is_long: bool,                       // 1
    pub last_cumulative_funding_rate: i64,   // 8
    pub opened_at: i64,                      // 8
    pub last_updated_at: i64,                // 8
    pub fees_paid: u64,                      // 8
    pub bump: u8,                            // 1
    pub _padding: [u8; 6],                   // 6
}

impl Position {
    pub const LEN: usize = 8 + 32 + 32 + 8 + 8 + 8 + 1 + 8 + 8 + 8 + 8 + 1 + 6;
}

#[account]
#[derive(Default)]
pub struct LpPosition {
    pub owner: Pubkey,           // 32
    pub market: Pubkey,          // 32
    pub shares: u64,             // 8
    pub deposited_amount: u64,   // 8
    pub bump: u8,                // 1
    pub _padding: [u8; 7],       // 7
}

impl LpPosition {
    pub const LEN: usize = 8 + 32 + 32 + 8 + 8 + 1 + 7;
}

/// Tiny helper account that stores a bump for a PDA used as vault authority.
/// In production you'd derive this more elegantly, but kept explicit for transpiler testing.
#[account]
pub struct VaultBumpHolder {
    pub bump: u8,
}

// ─── Contexts ────────────────────────────────────────────────────────────────

#[derive(Accounts)]
#[instruction(market_index: u16)]
pub struct InitializeMarket<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(
        init,
        payer = authority,
        space = Market::LEN,
        seeds = [MARKET_SEED, authority.key().as_ref(), &market_index.to_le_bytes()],
        bump,
    )]
    pub market: Account<'info, Market>,

    pub collateral_mint: Account<'info, Mint>,

    #[account(
        init,
        payer = authority,
        token::mint = collateral_mint,
        token::authority = vault_authority,
        seeds = [VAULT_SEED, market.key().as_ref()],
        bump,
    )]
    pub vault: Account<'info, TokenAccount>,

    /// CHECK: PDA used as token authority for vault
    #[account(seeds = [VAULT_SEED, market.key().as_ref(), b"auth"], bump)]
    pub vault_authority: UncheckedAccount<'info>,

    #[account(
        init,
        payer = authority,
        token::mint = collateral_mint,
        token::authority = fee_vault_authority,
        seeds = [FEE_VAULT_SEED, market.key().as_ref()],
        bump,
    )]
    pub fee_vault: Account<'info, TokenAccount>,

    /// CHECK: PDA authority for fee vault
    #[account(seeds = [FEE_VAULT_SEED, market.key().as_ref(), b"auth"], bump)]
    pub fee_vault_authority: UncheckedAccount<'info>,

    #[account(
        init,
        payer = authority,
        token::mint = collateral_mint,
        token::authority = insurance_authority,
        seeds = [INSURANCE_SEED, market.key().as_ref()],
        bump,
    )]
    pub insurance_fund: Account<'info, TokenAccount>,

    /// CHECK: PDA authority for insurance fund
    #[account(seeds = [INSURANCE_SEED, market.key().as_ref(), b"auth"], bump)]
    pub insurance_authority: UncheckedAccount<'info>,

    #[account(
        init,
        payer = authority,
        mint::decimals = 6,
        mint::authority = lp_mint_authority,
        seeds = [LP_MINT_SEED, market.key().as_ref()],
        bump,
    )]
    pub lp_mint: Account<'info, Mint>,

    /// CHECK: PDA authority for lp mint
    #[account(seeds = [LP_MINT_SEED, market.key().as_ref(), b"auth"], bump)]
    pub lp_mint_authority: UncheckedAccount<'info>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct DepositLiquidity<'info> {
    #[account(mut)]
    pub provider: Signer<'info>,

    #[account(mut)]
    pub market: Account<'info, Market>,

    #[account(mut, address = market.vault)]
    pub vault: Account<'info, TokenAccount>,

    #[account(
        mut,
        associated_token::mint = market.collateral_mint,
        associated_token::authority = provider,
    )]
    pub provider_collateral: Account<'info, TokenAccount>,

    #[account(
        init_if_needed,
        payer = provider,
        space = LpPosition::LEN,
        seeds = [LP_POSITION_SEED, market.key().as_ref(), provider.key().as_ref()],
        bump,
    )]
    pub lp_position: Account<'info, LpPosition>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct WithdrawLiquidity<'info> {
    #[account(mut)]
    pub provider: Signer<'info>,

    #[account(mut)]
    pub market: Account<'info, Market>,

    #[account(mut, address = market.vault)]
    pub vault: Account<'info, TokenAccount>,

    /// CHECK: vault PDA authority
    pub vault_authority: UncheckedAccount<'info>,

    #[account(seeds = [VAULT_SEED, market.key().as_ref(), b"auth"], bump)]
    /// CHECK: vault auth pda — bump captured via ctx.bumps
    pub vault_bump_cpi: UncheckedAccount<'info>,

    #[account(
        mut,
        associated_token::mint = market.collateral_mint,
        associated_token::authority = provider,
    )]
    pub provider_collateral: Account<'info, TokenAccount>,

    #[account(
        mut,
        seeds = [LP_POSITION_SEED, market.key().as_ref(), provider.key().as_ref()],
        bump = lp_position.bump,
        constraint = lp_position.owner == provider.key() @ FundingError::Unauthorized,
    )]
    pub lp_position: Account<'info, LpPosition>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct OpenPosition<'info> {
    #[account(mut)]
    pub trader: Signer<'info>,

    #[account(mut)]
    pub market: Account<'info, Market>,

    #[account(mut, address = market.vault)]
    pub vault: Account<'info, TokenAccount>,

    #[account(mut, address = market.fee_vault)]
    pub fee_vault: Account<'info, TokenAccount>,

    /// CHECK: vault PDA authority
    pub vault_authority: UncheckedAccount<'info>,

    // bump for the vault CPI signer — stored in bumps
    #[account(seeds = [VAULT_SEED, market.key().as_ref(), b"auth"], bump)]
    /// CHECK: vault auth pda — bump captured via ctx.bumps
    pub vault_bump_cpi: UncheckedAccount<'info>,

    #[account(
        mut,
        associated_token::mint = market.collateral_mint,
        associated_token::authority = trader,
    )]
    pub trader_collateral: Account<'info, TokenAccount>,

    #[account(
        init_if_needed,
        payer = trader,
        space = Position::LEN,
        seeds = [POSITION_SEED, market.key().as_ref(), trader.key().as_ref()],
        bump,
    )]
    pub position: Account<'info, Position>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ClosePosition<'info> {
    #[account(mut)]
    pub trader: Signer<'info>,

    #[account(mut)]
    pub market: Account<'info, Market>,

    #[account(mut, address = market.vault)]
    pub vault: Account<'info, TokenAccount>,

    #[account(mut, address = market.fee_vault)]
    pub fee_vault: Account<'info, TokenAccount>,

    /// CHECK: vault authority PDA
    pub vault_authority: UncheckedAccount<'info>,

    #[account(seeds = [VAULT_SEED, market.key().as_ref(), b"auth"], bump)]
    /// CHECK: vault auth bump capture
    pub vault_bump_cpi: UncheckedAccount<'info>,

    #[account(
        mut,
        associated_token::mint = market.collateral_mint,
        associated_token::authority = trader,
    )]
    pub trader_collateral: Account<'info, TokenAccount>,

    #[account(
        mut,
        seeds = [POSITION_SEED, market.key().as_ref(), trader.key().as_ref()],
        bump = position.bump,
    )]
    pub position: Account<'info, Position>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ModifyCollateral<'info> {
    #[account(mut)]
    pub trader: Signer<'info>,

    #[account(mut)]
    pub market: Account<'info, Market>,

    #[account(mut, address = market.vault)]
    pub vault: Account<'info, TokenAccount>,

    /// CHECK: vault authority PDA
    pub vault_authority: UncheckedAccount<'info>,

    #[account(seeds = [VAULT_SEED, market.key().as_ref(), b"auth"], bump)]
    /// CHECK: vault auth bump
    pub vault_bump_cpi: UncheckedAccount<'info>,

    #[account(
        mut,
        associated_token::mint = market.collateral_mint,
        associated_token::authority = trader,
    )]
    pub trader_collateral: Account<'info, TokenAccount>,

    #[account(
        mut,
        seeds = [POSITION_SEED, market.key().as_ref(), trader.key().as_ref()],
        bump = position.bump,
    )]
    pub position: Account<'info, Position>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Liquidate<'info> {
    #[account(mut)]
    pub liquidator: Signer<'info>,

    #[account(mut)]
    pub market: Account<'info, Market>,

    #[account(mut, address = market.vault)]
    pub vault: Account<'info, TokenAccount>,

    #[account(mut, address = market.insurance_fund)]
    pub insurance_fund: Account<'info, TokenAccount>,

    /// CHECK: vault PDA authority
    pub vault_authority: UncheckedAccount<'info>,

    #[account(seeds = [VAULT_SEED, market.key().as_ref(), b"auth"], bump)]
    /// CHECK: vault auth bump
    pub vault_bump_cpi: UncheckedAccount<'info>,

    #[account(
        mut,
        associated_token::mint = market.collateral_mint,
        associated_token::authority = liquidator,
    )]
    pub liquidator_collateral: Account<'info, TokenAccount>,

    /// The position being liquidated — any owner
    #[account(mut)]
    pub position: Account<'info, Position>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct UpdateFundingRate<'info> {
    pub caller: Signer<'info>,

    #[account(mut)]
    pub market: Account<'info, Market>,
}

#[derive(Accounts)]
pub struct AuthorityOnly<'info> {
    #[account(address = market.authority)]
    pub authority: Signer<'info>,

    #[account(mut)]
    pub market: Account<'info, Market>,
}

#[derive(Accounts)]
pub struct ClaimFees<'info> {
    pub authority: Signer<'info>,

    #[account(mut)]
    pub market: Account<'info, Market>,

    #[account(mut, address = market.fee_vault)]
    pub fee_vault: Account<'info, TokenAccount>,

    /// CHECK: fee vault authority PDA
    pub fee_vault_authority: UncheckedAccount<'info>,

    #[account(seeds = [FEE_VAULT_SEED, market.key().as_ref(), b"auth"], bump)]
    /// CHECK: fee vault auth bump
    pub fee_vault_bump: UncheckedAccount<'info>,

    #[account(mut)]
    pub recipient: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}

// ─── Events ──────────────────────────────────────────────────────────────────

#[event]
pub struct MarketInitialized {
    pub market_index: u16,
    pub authority: Pubkey,
    pub oracle: Pubkey,
}

#[event]
pub struct LiquidityDeposited {
    pub provider: Pubkey,
    pub amount: u64,
    pub shares_minted: u64,
}

#[event]
pub struct LiquidityWithdrawn {
    pub provider: Pubkey,
    pub amount: u64,
    pub shares_burned: u64,
}

#[event]
pub struct PositionOpened {
    pub trader: Pubkey,
    pub size_usd: u64,
    pub collateral: u64,
    pub is_long: bool,
    pub entry_price: u64,
    pub fee: u64,
}

#[event]
pub struct PositionClosed {
    pub trader: Pubkey,
    pub size_usd: u64,
    pub oracle_price: u64,
    pub price_pnl: SignedAmount,
    pub funding_pnl: SignedAmount,
    pub fee: u64,
    pub payout: u64,
}

#[event]
pub struct CollateralAdded {
    pub trader: Pubkey,
    pub amount: u64,
    pub new_collateral: u64,
}

#[event]
pub struct CollateralRemoved {
    pub trader: Pubkey,
    pub amount: u64,
    pub new_collateral: u64,
}

#[event]
pub struct PositionLiquidated {
    pub trader: Pubkey,
    pub liquidator: Pubkey,
    pub size_usd: u64,
    pub oracle_price: u64,
    pub liquidator_fee: u64,
    pub insurance_fee: u64,
    pub margin_ratio: u64,
}

#[event]
pub struct FundingRateUpdated {
    pub market: Pubkey,
    pub funding_rate: i64,
    pub oracle_price: u64,
    pub index_price: u64,
    pub timestamp: i64,
}

#[event]
pub struct FeesClaimed {
    pub authority: Pubkey,
    pub amount: u64,
}

// ─── Errors ──────────────────────────────────────────────────────────────────

#[error_code]
pub enum FundingError {
    #[msg("Math overflow")]
    MathOverflow,
    #[msg("Invalid parameter")]
    InvalidParam,
    #[msg("Below minimum position size")]
    BelowMinSize,
    #[msg("Leverage exceeds maximum")]
    LeverageTooHigh,
    #[msg("Open interest limit exceeded")]
    OILimitExceeded,
    #[msg("Insufficient liquidity in vault")]
    InsufficientLiquidity,
    #[msg("Market is paused")]
    MarketPaused,
    #[msg("Insufficient LP shares")]
    InsufficientShares,
    #[msg("Zero LP shares would be minted")]
    ZeroShares,
    #[msg("Zero withdraw amount")]
    ZeroWithdraw,
    #[msg("Withdrawal would break OI limit")]
    WithdrawExceedsOILimit,
    #[msg("Unauthorized")]
    Unauthorized,
    #[msg("Position is empty")]
    PositionEmpty,
    #[msg("Invalid close size")]
    InvalidCloseSize,
    #[msg("Cannot change position side")]
    SideConflict,
    #[msg("Position is not liquidatable")]
    NotLiquidatable,
    #[msg("Margin ratio too low after removal")]
    MarginTooLow,
    #[msg("Position would be immediately liquidatable")]
    WouldBeLiquidatable,
    #[msg("Insufficient collateral")]
    InsufficientCollateral,
    #[msg("Funding updated too recently")]
    FundingTooEarly,
    #[msg("Insufficient fees to claim")]
    InsufficientFees,
}
fn add_liquidity(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    data: &[u8],
) -> ProgramResult {
    if accounts.len() < 8 {
        return Err(ProgramError::NotEnoughAccountKeys);
    }

    let user = &accounts[0];
    let pool = &accounts[1];
    let user_token_a = &accounts[2];
    let user_token_b = &accounts[3];
    let vault_a = &accounts[4];
    let vault_b = &accounts[5];
    let lp_mint = &accounts[6];
    let user_lp_token = &accounts[7];

    if !user.is_signer() {
        return Err(ProgramError::MissingRequiredSignature);
    }

    // Args
    if data.len() < 8 {
        return Err(ProgramError::InvalidInstructionData);
    }
    let amount_a_desired: u64 = u64::from_le_bytes(data[0..8].try_into().unwrap());
    if data.len() < 16 {
        return Err(ProgramError::InvalidInstructionData);
    }
    let amount_b_desired: u64 = u64::from_le_bytes(data[8..16].try_into().unwrap());
    if data.len() < 24 {
        return Err(ProgramError::InvalidInstructionData);
    }
    let amount_a_min: u64 = u64::from_le_bytes(data[16..24].try_into().unwrap());
    if data.len() < 32 {
        return Err(ProgramError::InvalidInstructionData);
    }
    let amount_b_min: u64 = u64::from_le_bytes(data[24..32].try_into().unwrap());

    let pool_account = pool;
    let mut pool = AmmPool::from_account_info(pool_account)?;
    if !(!pool.is_frozen) {
        return Err(AmmError::PoolFrozen.into());
    }
    if !(amount_a_desired > 0 && amount_b_desired > 0) {
        return Err(AmmError::InvalidAmount.into());
    }
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
                if !(amount_b_optimal >= amount_b_min) {
            return Err(AmmError::SlippageExceeded.into());
        }
                (amount_a_desired, amount_b_optimal)
            } else {
                let amount_a_optimal = (amount_b_desired as u128)
                    .checked_mul(pool.reserve_a as u128)
                    .ok_or(AmmError::Overflow)?
                    .checked_div(pool.reserve_b as u128)
                    .ok_or(AmmError::Overflow)? as u64;
                if !(amount_a_optimal >= amount_a_min) {
            return Err(AmmError::SlippageExceeded.into());
        }
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
    if !(lp_tokens > 0) {
        return Err(AmmError::InsufficientLiquidity.into());
    }
    // SPL Token transfer — user_token_a → vault_a
    spl_token_transfer(user_token_a, vault_a, user, amount_a)?;
    // SPL Token transfer — user_token_b → vault_b
    spl_token_transfer(user_token_b, vault_b, user, amount_b)?;
    let pool_seeds = &[
            b"pool",
            pool.token_mint_a.as_ref(),
            pool.token_mint_b.as_ref(),
            &[pool.bump],
        ];
    let signer_seeds = &[&pool_seeds[..]];
    // SPL Token mint_to — lp_mint → user_lp_token
    spl_token_mint_to_signed(lp_mint, user_lp_token, pool_account, lp_tokens, signer_seeds)?;
    pool.reserve_a = pool.reserve_a
            .checked_add(amount_a)
            .ok_or(AmmError::Overflow)?;
    pool.reserve_b = pool.reserve_b
            .checked_add(amount_b)
            .ok_or(AmmError::Overflow)?;
    pool.lp_supply = pool.lp_supply
            .checked_add(lp_tokens)
            .ok_or(AmmError::Overflow)?;
    // Event: LiquidityAdded
    // ⚠️ Anvil: Pinocchio doesn't have Anchor's emit!() — log via msg! or instruction data
    pinocchio::msg!("event:LiquidityAdded");
    AmmPool::save(pool_account, &pool)?;
    Ok(())

}
fn remove_liquidity(
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
    let lp_amount: u64 = u64::from_le_bytes(data[0..8].try_into().unwrap());
    if data.len() < 16 {
        return Err(ProgramError::InvalidInstructionData);
    }
    let min_amount_a: u64 = u64::from_le_bytes(data[8..16].try_into().unwrap());
    if data.len() < 24 {
        return Err(ProgramError::InvalidInstructionData);
    }
    let min_amount_b: u64 = u64::from_le_bytes(data[16..24].try_into().unwrap());

    let pool_account = pool;
    let mut pool = AmmPool::from_account_info(pool_account)?;
    if !(!pool.is_frozen) {
        return Err(AmmError::PoolFrozen.into());
    }
    if !(lp_amount > 0) {
        return Err(AmmError::InvalidAmount.into());
    }
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
    if !(amount_a >= min_amount_a) {
        return Err(AmmError::SlippageExceeded.into());
    }
    if !(amount_b >= min_amount_b) {
        return Err(AmmError::SlippageExceeded.into());
    }
    let pool_seeds = &[
            b"pool",
            pool.token_mint_a.as_ref(),
            pool.token_mint_b.as_ref(),
            &[pool.bump],
        ];
    let signer_seeds = &[&pool_seeds[..]];
    // SPL Token burn — user_lp_token
    spl_token_burn(user_lp_token, lp_mint, user, lp_amount)?;
    // SPL Token transfer (PDA signed) — vault_a → user_token_a
    spl_token_transfer_signed(vault_a, user_token_a, pool_account, amount_a, signer_seeds)?;
    // SPL Token transfer (PDA signed) — vault_b → user_token_b
    spl_token_transfer_signed(vault_b, user_token_b, pool_account, amount_b, signer_seeds)?;
    pool.reserve_a = pool.reserve_a
            .checked_sub(amount_a)
            .ok_or(AmmError::Underflow)?;
    pool.reserve_b = pool.reserve_b
            .checked_sub(amount_b)
            .ok_or(AmmError::Underflow)?;
    pool.lp_supply = pool.lp_supply
            .checked_sub(lp_amount)
            .ok_or(AmmError::Underflow)?;
    // Event: LiquidityRemoved
    // ⚠️ Anvil: Pinocchio doesn't have Anchor's emit!() — log via msg! or instruction data
    pinocchio::msg!("event:LiquidityRemoved");
    AmmPool::save(pool_account, &pool)?;
    Ok(())

}
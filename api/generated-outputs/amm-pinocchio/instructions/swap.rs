fn swap(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    data: &[u8],
) -> ProgramResult {
    if accounts.len() < 6 {
        return Err(ProgramError::NotEnoughAccountKeys);
    }

    let user = &accounts[0];
    let pool = &accounts[1];
    let user_token_in = &accounts[2];
    let user_token_out = &accounts[3];
    let vault_in = &accounts[4];
    let vault_out = &accounts[5];

    if !user.is_signer() {
        return Err(ProgramError::MissingRequiredSignature);
    }

    // Args
    if data.len() < 8 {
        return Err(ProgramError::InvalidInstructionData);
    }
    let amount_in: u64 = u64::from_le_bytes(data[0..8].try_into().unwrap());
    if data.len() < 16 {
        return Err(ProgramError::InvalidInstructionData);
    }
    let minimum_amount_out: u64 = u64::from_le_bytes(data[8..16].try_into().unwrap());
    if data.len() < 17 {
        return Err(ProgramError::InvalidInstructionData);
    }
    let a_to_b: bool = match data[16] {
        0 => false,
        1 => true,
        _ => return Err(ProgramError::InvalidInstructionData),
    };

    let pool_account = pool;
    let mut pool = AmmPool::from_account_info(pool_account)?;
    if !(!pool.is_frozen) {
        return Err(AmmError::PoolFrozen.into());
    }
    if !(amount_in > 0) {
        return Err(AmmError::InvalidAmount.into());
    }
    let (reserve_in, reserve_out) = if a_to_b {
            (pool.reserve_a, pool.reserve_b)
        } else {
            (pool.reserve_b, pool.reserve_a)
        };
    if !(reserve_in > 0 && reserve_out > 0) {
        return Err(AmmError::InsufficientLiquidity.into());
    }
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
    let amount_out = (amount_in_after_fee as u128)
            .checked_mul(reserve_out as u128)
            .ok_or(AmmError::Overflow)?
            .checked_div(
                (reserve_in as u128)
                    .checked_add(amount_in_after_fee as u128)
                    .ok_or(AmmError::Overflow)?
            )
            .ok_or(AmmError::Overflow)? as u64;
    if !(amount_out >= minimum_amount_out) {
        return Err(AmmError::SlippageExceeded.into());
    }
    if !(amount_out < reserve_out) {
        return Err(AmmError::InsufficientLiquidity.into());
    }
    let pool_seeds = &[
            b"pool",
            pool.token_mint_a.as_ref(),
            pool.token_mint_b.as_ref(),
            &[pool.bump],
        ];
    let signer_seeds = &[&pool_seeds[..]];
    if a_to_b {
            spl_token_transfer(user_token_in, vault_in, user, amount_in)?;

            spl_token_transfer_signed(vault_out, user_token_out, pool_account, amount_out, signer_seeds)?;
        } else {
            spl_token_transfer(user_token_in, vault_in, user, amount_in)?;

            spl_token_transfer_signed(vault_out, user_token_out, pool_account, amount_out, signer_seeds)?;
        }
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
        }
    // Event: Swapped
    // ⚠️ Anvil: Pinocchio doesn't have Anchor's emit!() — log via msg! or instruction data
    pinocchio::msg!("event:Swapped");
    AmmPool::save(pool_account, &pool)?;
    Ok(())

}
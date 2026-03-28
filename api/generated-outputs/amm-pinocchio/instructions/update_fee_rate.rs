fn update_fee_rate(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    data: &[u8],
) -> ProgramResult {
    if accounts.len() < 2 {
        return Err(ProgramError::NotEnoughAccountKeys);
    }

    let pool = &accounts[0];
    let admin = &accounts[1];

    if !admin.is_signer() {
        return Err(ProgramError::MissingRequiredSignature);
    }

    // Args
    if data.len() < 8 {
        return Err(ProgramError::InvalidInstructionData);
    }
    let new_fee_rate: u64 = u64::from_le_bytes(data[0..8].try_into().unwrap());

    let pool_account = pool;
    let mut pool = AmmPool::from_account_info(pool_account)?;
    if !(pool.admin == *admin.key()) {
        return Err(AmmError::Unauthorized.into());
    }
    if !(new_fee_rate <= 10000) {
        return Err(AmmError::InvalidFeeRate.into());
    }
    pool.fee_rate = new_fee_rate;
    AmmPool::save(pool_account, &pool)?;
    Ok(())

}
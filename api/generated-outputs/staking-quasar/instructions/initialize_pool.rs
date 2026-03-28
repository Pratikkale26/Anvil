fn initialize_pool(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    data: &[u8],
) -> ProgramResult {
    if accounts.len() < 5 {
        return Err(ProgramError::NotEnoughAccountKeys);
    }

    let pool = &accounts[0];
    let reward_vault = &accounts[1];
    let stake_mint = &accounts[2];
    let reward_mint = &accounts[3];
    let admin = &accounts[4];

    if !admin.is_signer {
        return Err(ProgramError::MissingRequiredSignature);
    }

    // Args
    if data.len() < 8 {
        return Err(ProgramError::InvalidInstructionData);
    }
    let reward_rate: u64 = u64::from_le_bytes(data[0..8].try_into().unwrap());
    if data.len() < 16 {
        return Err(ProgramError::InvalidInstructionData);
    }
    let lock_duration: i64 = i64::from_le_bytes(data[8..16].try_into().unwrap());
    if data.len() < 24 {
        return Err(ProgramError::InvalidInstructionData);
    }
    let max_stake: u64 = u64::from_le_bytes(data[16..24].try_into().unwrap());

    if !(reward_rate > 0) {
        return Err(StakingError::InvalidRewardRate.into());
    }
    if !(lock_duration > 0) {
        return Err(StakingError::InvalidLockDuration.into());
    }
    if !(max_stake > 0) {
        return Err(StakingError::InvalidMaxStake.into());
    }
    let pool_account = pool;
    let mut pool = StakingPool::from_account_info(pool_account)?;
    pool.admin = admin.key;
    pool.stake_mint = stake_mint.key;
    pool.reward_mint = reward_mint.key;
    pool.reward_rate = reward_rate;
    pool.lock_duration = lock_duration;
    pool.max_stake = max_stake;
    pool.total_staked = 0;
    let bump = bump_seed(program_id, &[b"pool", stake_mint.key().as_ref()], pool_account.key)?;
    pool.bump = bump;
    let bump = bump_seed(program_id, &[b"reward_vault", pool.key().as_ref()], reward_vault.key)?;
    pool.reward_vault_bump = bump;
    pool.is_paused = false;
    StakingPool::save(pool_account, &pool)?;
    Ok(())

}
fn stake(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    data: &[u8],
) -> ProgramResult {
    if accounts.len() < 5 {
        return Err(ProgramError::NotEnoughAccountKeys);
    }

    let user = &accounts[0];
    let user_stake = &accounts[1];
    let pool = &accounts[2];
    let user_stake_ata = &accounts[3];
    let stake_vault = &accounts[4];

    if !user.is_signer {
        return Err(ProgramError::MissingRequiredSignature);
    }

    // Args
    if data.len() < 8 {
        return Err(ProgramError::InvalidInstructionData);
    }
    let amount: u64 = u64::from_le_bytes(data[0..8].try_into().unwrap());

    let pool_account = pool;
    let mut pool = StakingPool::from_account_info(pool_account)?;
    if !(!pool.is_paused) {
        return Err(StakingError::PoolPaused.into());
    }
    if !(amount > 0) {
        return Err(StakingError::InvalidAmount.into());
    }
    if !(pool.total_staked.checked_add(amount).ok_or(StakingError::Overflow)? <= pool.max_stake) {
        return Err(StakingError::MaxStakeExceeded.into());
    }
    let clock = quasar::sysvar::clock::Clock::get()?;
    let now = clock.unix_timestamp;
    let user_stake_account = user_stake;
    let mut user_stake = UserStake::from_account_info(user_stake_account)?;
    user_stake.owner = user.key;
    user_stake.pool = pool_account.key;
    user_stake.amount = amount;
    user_stake.staked_at = now;
    user_stake.last_claim = now;
    let bump = bump_seed(program_id, &[b"user_stake", user.key().as_ref(), pool.key().as_ref()], user_stake_account.key)?;
    user_stake.bump = bump;
    pool.total_staked = pool.total_staked
            .checked_add(amount)
            .ok_or(StakingError::Overflow)?;
    // SPL Token transfer — user_stake_ata → stake_vault
    spl_token_transfer(user_stake_ata, stake_vault, user, amount)?;
    // Event: StakeEvent
// ⚠️ Anvil: Quasar doesn't have Anchor's emit!() — log via msg! or instruction data
quasar::msg!("event:StakeEvent");
    UserStake::save(user_stake_account, &user_stake)?;
    StakingPool::save(pool_account, &pool)?;
    Ok(())

}
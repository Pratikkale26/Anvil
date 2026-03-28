fn unstake(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    data: &[u8],
) -> ProgramResult {
    if accounts.len() < 7 {
        return Err(ProgramError::NotEnoughAccountKeys);
    }

    let user = &accounts[0];
    let user_stake = &accounts[1];
    let pool = &accounts[2];
    let reward_mint = &accounts[3];
    let user_stake_ata = &accounts[4];
    let stake_vault = &accounts[5];
    let user_reward_ata = &accounts[6];

    if !user.is_signer() {
        return Err(ProgramError::MissingRequiredSignature);
    }

    if !data.is_empty() {
        return Err(ProgramError::InvalidInstructionData);
    }

    let user_stake_account = user_stake;
    let user_stake = UserStake::from_account_info(user_stake_account)?;
    if !(user_stake.owner == *user.key() @ StakingError::Unauthorized) {
        return Err(ProgramError::InvalidAccountData.into());
    }
    let pool_account = pool;
    let mut pool = StakingPool::from_account_info(pool_account)?;
    if !(!pool.is_paused) {
        return Err(StakingError::PoolPaused.into());
    }
    let clock = pinocchio::sysvar::clock::Clock::get()?;
    let now = clock.unix_timestamp;
    let unlock_time = user_stake.staked_at
            .checked_add(pool.lock_duration)
            .ok_or(StakingError::Overflow)?;
    if !(now >= unlock_time) {
        return Err(StakingError::StillLocked.into());
    }
    let elapsed = now
            .checked_sub(user_stake.last_claim)
            .ok_or(StakingError::Underflow)?;
    let pending_rewards = (user_stake.amount as i64)
            .checked_mul(elapsed)
            .ok_or(StakingError::Overflow)?
            .checked_mul(pool.reward_rate as i64)
            .ok_or(StakingError::Overflow)?
            .checked_div(1_000_000)
            .ok_or(StakingError::Overflow)? as u64;
    let stake_seeds = &[
            b"pool",
            pool.stake_mint.as_ref(),
            &[pool.bump],
        ];
    let signer_seeds = &[&stake_seeds[..]];
    // SPL Token transfer (PDA signed) — stake_vault → user_stake_ata
    spl_token_transfer_signed(stake_vault, user_stake_ata, pool_account, token_account_amount(user_stake)?, signer_seeds)?;
    if pending_rewards > 0 {
            spl_token_mint_to_signed(reward_mint, user_reward_ata, pool, pending_rewards, signer_seeds)?;
        }
    pool.total_staked = pool.total_staked
            .checked_sub(user_stake.amount)
            .ok_or(StakingError::Underflow)?;
    // Event: UnstakeEvent
// ⚠️ Anvil: Pinocchio doesn't have Anchor's emit!() — log via msg! or instruction data
pinocchio::msg!("event:UnstakeEvent");
    close_program_account(user_stake_account, user)?;
    StakingPool::save(pool_account, &pool)?;
    Ok(())

}
fn claim_rewards(
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
    let reward_mint = &accounts[3];
    let user_reward_ata = &accounts[4];

    if !user.is_signer {
        return Err(ProgramError::MissingRequiredSignature);
    }

    if !data.is_empty() {
        return Err(ProgramError::InvalidInstructionData);
    }

    let user_stake_account = user_stake;
    let mut user_stake = UserStake::from_account_info(user_stake_account)?;
    if !(user_stake.owner == user.key @ StakingError::Unauthorized) {
        return Err(ProgramError::InvalidAccountData.into());
    }
    let pool_account = pool;
    let pool = StakingPool::from_account_info(pool_account)?;
    if !(!pool.is_paused) {
        return Err(StakingError::PoolPaused.into());
    }
    let clock = quasar::sysvar::clock::Clock::get()?;
    let now = clock.unix_timestamp;
    let elapsed = now
            .checked_sub(user_stake.last_claim)
            .ok_or(StakingError::Underflow)?;
    let rewards = (user_stake.amount as i64)
            .checked_mul(elapsed)
            .ok_or(StakingError::Overflow)?
            .checked_mul(pool.reward_rate as i64)
            .ok_or(StakingError::Overflow)?
            .checked_div(1_000_000)
            .ok_or(StakingError::Overflow)? as u64;
    if !(rewards > 0) {
        return Err(StakingError::NoRewards.into());
    }
    let pool_seeds = &[
            b"pool",
            pool.stake_mint.as_ref(),
            &[pool.bump],
        ];
    let signer_seeds = &[&pool_seeds[..]];
    // SPL Token mint_to — reward_mint → user_reward_ata
    spl_token_mint_to_signed(reward_mint, user_reward_ata, pool_account, rewards, signer_seeds)?;
    user_stake.last_claim = now;
    // Event: RewardEvent
// ⚠️ Anvil: Quasar doesn't have Anchor's emit!() — log via msg! or instruction data
quasar::msg!("event:RewardEvent");
    UserStake::save(user_stake_account, &user_stake)?;
    Ok(())

}
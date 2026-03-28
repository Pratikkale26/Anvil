fn unfreeze_pool(
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

    if !data.is_empty() {
        return Err(ProgramError::InvalidInstructionData);
    }

    let pool_account = pool;
    let mut pool = AmmPool::from_account_info(pool_account)?;
    if !(pool.admin == *admin.key()) {
        return Err(AmmError::Unauthorized.into());
    }
    pool.is_frozen = false;
    AmmPool::save(pool_account, &pool)?;
    Ok(())

}
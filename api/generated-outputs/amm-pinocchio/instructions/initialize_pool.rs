fn initialize_pool(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    data: &[u8],
) -> ProgramResult {
    if accounts.len() < 7 {
        return Err(ProgramError::NotEnoughAccountKeys);
    }

    let pool = &accounts[0];
    let vault_a = &accounts[1];
    let vault_b = &accounts[2];
    let lp_mint = &accounts[3];
    let token_mint_a = &accounts[4];
    let token_mint_b = &accounts[5];
    let admin = &accounts[6];

    if !admin.is_signer() {
        return Err(ProgramError::MissingRequiredSignature);
    }

    // Args
    if data.len() < 8 {
        return Err(ProgramError::InvalidInstructionData);
    }
    let fee_rate: u64 = u64::from_le_bytes(data[0..8].try_into().unwrap());
    if data.len() < 16 {
        return Err(ProgramError::InvalidInstructionData);
    }
    let initial_price: u64 = u64::from_le_bytes(data[8..16].try_into().unwrap());

    if !(fee_rate <= 10000) {
        return Err(AmmError::InvalidFeeRate.into());
    }
    if !(initial_price > 0) {
        return Err(AmmError::InvalidPrice.into());
    }
    let pool_account = pool;
    let mut pool = AmmPool::from_account_info(pool_account)?;
    pool.admin = *admin.key();
    pool.token_mint_a = *token_mint_a.key();
    pool.token_mint_b = *token_mint_b.key();
    pool.lp_mint = *lp_mint.key();
    pool.fee_rate = fee_rate;
    pool.initial_price = initial_price;
    pool.reserve_a = 0;
    pool.reserve_b = 0;
    pool.lp_supply = 0;
    pool.total_fees_a = 0;
    pool.total_fees_b = 0;
    let bump = bump_seed(program_id, &[b"pool", token_mint_a.key().as_ref(), token_mint_b.key().as_ref()], pool_account.key())?;
    pool.bump = bump;
    let bump = bump_seed(program_id, &[b"vault_a", pool_account.key().as_ref()], vault_a.key())?;
    pool.vault_a_bump = bump;
    let bump = bump_seed(program_id, &[b"vault_b", pool_account.key().as_ref()], vault_b.key())?;
    pool.vault_b_bump = bump;
    pool.is_frozen = false;
    pool.protocol_fee_rate = 2000;
    AmmPool::save(pool_account, &pool)?;
    Ok(())

}
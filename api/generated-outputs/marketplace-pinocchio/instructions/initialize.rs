fn initialize(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    data: &[u8],
) -> ProgramResult {
    if accounts.len() < 3 {
        return Err(ProgramError::NotEnoughAccountKeys);
    }

    let marketplace = &accounts[0];
    let admin = &accounts[1];
    let treasury = &accounts[2];

    if !admin.is_signer() {
        return Err(ProgramError::MissingRequiredSignature);
    }

    // Args
    if data.len() < 2 {
        return Err(ProgramError::InvalidInstructionData);
    }
    let fee_bps: u16 = u16::from_le_bytes(data[0..2].try_into().unwrap());

    if !(fee_bps <= 10000) {
        return Err(MarketplaceError::InvalidFeeBps.into());
    }
    let marketplace_account = marketplace;
    let mut marketplace = Marketplace::from_account_info(marketplace_account)?;
    marketplace.admin = *admin.key();
    marketplace.fee_bps = fee_bps;
    marketplace.treasury = *treasury.key();
    let bump = bump_seed(program_id, &[b"marketplace"], marketplace_account.key())?;
    marketplace.bump = bump;
    marketplace.listing_count = 0;
    Marketplace::save(marketplace_account, &marketplace)?;
    Ok(())

}
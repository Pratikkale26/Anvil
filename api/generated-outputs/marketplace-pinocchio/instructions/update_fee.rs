fn update_fee(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    data: &[u8],
) -> ProgramResult {
    if accounts.len() < 2 {
        return Err(ProgramError::NotEnoughAccountKeys);
    }

    let marketplace = &accounts[0];
    let admin = &accounts[1];

    if !admin.is_signer() {
        return Err(ProgramError::MissingRequiredSignature);
    }

    // Args
    if data.len() < 2 {
        return Err(ProgramError::InvalidInstructionData);
    }
    let new_fee_bps: u16 = u16::from_le_bytes(data[0..2].try_into().unwrap());

    if !(new_fee_bps <= 10000) {
        return Err(MarketplaceError::InvalidFeeBps.into());
    }
    let marketplace_account = marketplace;
    let mut marketplace = Marketplace::from_account_info(marketplace_account)?;
    if !(marketplace.admin == **admin.key()) {
        return Err(MarketplaceError::Unauthorized.into());
    }
    marketplace.fee_bps = new_fee_bps;
    Marketplace::save(marketplace_account, &marketplace)?;
    Ok(())

}
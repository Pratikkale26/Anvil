fn list(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    data: &[u8],
) -> ProgramResult {
    if accounts.len() < 6 {
        return Err(ProgramError::NotEnoughAccountKeys);
    }

    let seller = &accounts[0];
    let nft_mint = &accounts[1];
    let seller_ata = &accounts[2];
    let listing = &accounts[3];
    let marketplace = &accounts[4];
    let vault = &accounts[5];

    if !seller.is_signer() {
        return Err(ProgramError::MissingRequiredSignature);
    }

    // Args
    if data.len() < 8 {
        return Err(ProgramError::InvalidInstructionData);
    }
    let price: u64 = u64::from_le_bytes(data[0..8].try_into().unwrap());
    if data.len() < 16 {
        return Err(ProgramError::InvalidInstructionData);
    }
    let seed: u64 = u64::from_le_bytes(data[8..16].try_into().unwrap());

    if !(price > 0) {
        return Err(MarketplaceError::InvalidPrice.into());
    }
    let listing_account = listing;
    let mut listing = Listing::from_account_info(listing_account)?;
    listing.seller = *seller.key();
    listing.mint = *nft_mint.key();
    listing.price = price;
    listing.seed = seed;
    let seed_bytes = seed.to_le_bytes();
    let bump = bump_seed(program_id, &[b"listing", seller.key().as_ref(), &seed_bytes], listing_account.key())?;
    listing.bump = bump;
    listing.marketplace = *marketplace.key();
    listing.is_active = true;
    let marketplace_account = marketplace;
    let mut marketplace = Marketplace::from_account_info(marketplace_account)?;
    marketplace.listing_count = marketplace.listing_count
            .checked_add(1)
            .ok_or(MarketplaceError::Overflow)?;
    // SPL Token transfer — seller_ata → vault
    spl_token_transfer(seller_ata, vault, seller, 1)?;
    Listing::save(listing_account, &listing)?;
    Marketplace::save(marketplace_account, &marketplace)?;
    Ok(())

}
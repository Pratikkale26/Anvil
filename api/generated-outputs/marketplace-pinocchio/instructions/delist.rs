fn delist(
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

    if !data.is_empty() {
        return Err(ProgramError::InvalidInstructionData);
    }

    let listing_account = listing;
    let listing = Listing::from_account_info(listing_account)?;
    if !(listing.is_active) {
        return Err(MarketplaceError::ListingNotActive.into());
    }
    if !(listing.seller == **seller.key()) {
        return Err(MarketplaceError::Unauthorized.into());
    }
    // PDA signer seeds for 'listing'
    let seed_bytes = listing.seed.to_le_bytes();
    let seeds = &[
            b"listing",
            listing.seller.as_ref(),
            &seed_bytes,
            &[listing.bump],
        ];
    let signer_seeds = &[&seeds[..]];
    // SPL Token transfer (PDA signed) — vault → seller_ata
    spl_token_transfer_signed(vault, seller_ata, listing_account, 1, signer_seeds)?;
    // SPL Token close account — vault
    spl_token_close_account_signed(vault, seller, listing_account, signer_seeds)?;
    let marketplace_account = marketplace;
    let mut marketplace = Marketplace::from_account_info(marketplace_account)?;
    marketplace.listing_count = marketplace.listing_count
            .checked_sub(1)
            .ok_or(MarketplaceError::Underflow)?;
    close_program_account(listing_account, seller)?;
    Marketplace::save(marketplace_account, &marketplace)?;
    Ok(())

}
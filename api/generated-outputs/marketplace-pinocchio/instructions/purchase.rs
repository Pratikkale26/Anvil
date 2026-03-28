fn purchase(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    data: &[u8],
) -> ProgramResult {
    if accounts.len() < 8 {
        return Err(ProgramError::NotEnoughAccountKeys);
    }

    let buyer = &accounts[0];
    let seller = &accounts[1];
    let nft_mint = &accounts[2];
    let buyer_ata = &accounts[3];
    let listing = &accounts[4];
    let marketplace = &accounts[5];
    let treasury = &accounts[6];
    let vault = &accounts[7];

    if !buyer.is_signer() {
        return Err(ProgramError::MissingRequiredSignature);
    }

    if !data.is_empty() {
        return Err(ProgramError::InvalidInstructionData);
    }

    let marketplace_account = marketplace;
    let mut marketplace = Marketplace::from_account_info(marketplace_account)?;
    if !(*treasury.key() == marketplace.treasury) {
        return Err(ProgramError::InvalidAccountData.into());
    }
    let listing_account = listing;
    let listing = Listing::from_account_info(listing_account)?;
    if !(listing.is_active) {
        return Err(MarketplaceError::ListingNotActive.into());
    }
    let fee = listing.price
            .checked_mul(marketplace.fee_bps as u64)
            .ok_or(MarketplaceError::Overflow)?
            .checked_div(10000)
            .ok_or(MarketplaceError::Overflow)?;
    let seller_amount = listing.price
            .checked_sub(fee)
            .ok_or(MarketplaceError::Underflow)?;
    transfer_lamports(buyer, seller, seller_amount)?;
    transfer_lamports(buyer, treasury, fee)?;
    // PDA signer seeds for 'listing'
    let seed_bytes = listing.seed.to_le_bytes();
    let seeds = &[
            b"listing",
            listing.seller.as_ref(),
            &seed_bytes,
            &[listing.bump],
        ];
    let signer_seeds = &[&seeds[..]];
    // SPL Token transfer (PDA signed) — vault → buyer_ata
    spl_token_transfer_signed(vault, buyer_ata, listing_account, 1, signer_seeds)?;
    // SPL Token close account — vault
    spl_token_close_account_signed(vault, seller, listing_account, signer_seeds)?;
    marketplace.listing_count = marketplace.listing_count
            .checked_sub(1)
            .ok_or(MarketplaceError::Underflow)?;
    close_program_account(listing_account, seller)?;
    Marketplace::save(marketplace_account, &marketplace)?;
    Ok(())

}
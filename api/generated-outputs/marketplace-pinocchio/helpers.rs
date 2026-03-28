//! Helper functions for Marketplace

fn bump_seed(
    program_id: &Pubkey,
    seeds: &[&[u8]],
    expected: &Pubkey,
) -> Result<u8, ProgramError> {
    let (derived, bump) = Pubkey::find_program_address(seeds, program_id);
    if &derived != expected {
        return Err(ProgramError::InvalidSeeds);
    }
    Ok(bump)
}

fn transfer_lamports(
    from: &AccountInfo,
    to: &AccountInfo,
    amount: u64,
) -> ProgramResult {
    SystemTransfer {
        from,
        to,
        lamports: amount,
    }
    .invoke()
}

fn spl_token_transfer(
    from: &AccountInfo,
    to: &AccountInfo,
    authority: &AccountInfo,
    amount: u64,
) -> ProgramResult {
    TokenTransfer {
        from,
        to,
        authority,
        amount,
    }
    .invoke()
}

fn spl_token_transfer_signed(
    from: &AccountInfo,
    to: &AccountInfo,
    authority: &AccountInfo,
    amount: u64,
    signer_seeds: &[&[&[u8]]],
) -> ProgramResult {
    TokenTransfer {
        from,
        to,
        authority,
        amount,
    }
    .invoke_signed(signer_seeds)
}

fn spl_token_close_account_signed(
    account: &AccountInfo,
    destination: &AccountInfo,
    authority: &AccountInfo,
    signer_seeds: &[&[&[u8]]],
) -> ProgramResult {
    TokenCloseAccount {
        account,
        destination,
        authority,
    }
    .invoke_signed(signer_seeds)
}

fn close_program_account(
    account: &AccountInfo,
    destination: &AccountInfo,
) -> ProgramResult {
    if account.key() == destination.key() {
        return Err(ProgramError::InvalidAccountData);
    }
    let lamports = account.lamports();
    {
        let destination_lamports = unsafe { destination.borrow_mut_lamports_unchecked() };
        *destination_lamports = destination_lamports
            .checked_add(lamports)
            .ok_or(ProgramError::ArithmeticOverflow)?;
    }
    {
        let account_lamports = unsafe { account.borrow_mut_lamports_unchecked() };
        *account_lamports = 0;
    }
    {
        let mut data = unsafe { account.borrow_mut_data_unchecked() };
        for byte in data.iter_mut() {
            *byte = 0;
        }
    }
    Ok(())
}
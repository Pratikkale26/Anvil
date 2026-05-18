pub fn mpl_freeze_delegated<'a>(
    delegate: &AccountInfo<'a>,
    token_account: &AccountInfo<'a>,
    edition: &AccountInfo<'a>,
    mint: &AccountInfo<'a>,
    token_program: &AccountInfo<'a>,
    token_metadata_program: &AccountInfo<'a>,
    signer_seeds: Option<&[&[&[u8]]]>,
) -> ProgramResult {
    let data: Vec<u8> = vec![26];
    let accounts = vec![
        AccountMeta::new_readonly(*delegate.key, true),
        AccountMeta::new(*token_account.key, false),
        AccountMeta::new_readonly(*edition.key, false),
        AccountMeta::new_readonly(*mint.key, false),
        AccountMeta::new_readonly(*token_program.key, false),
    ];
    let ix = Instruction { program_id: *token_metadata_program.key, accounts, data };
    let infos = [
        delegate.clone(), token_account.clone(), edition.clone(),
        mint.clone(), token_program.clone(),
    ];
    match signer_seeds {
        Some(seeds) => invoke_signed(&ix, &infos, seeds),
        None => invoke(&ix, &infos),
    }
}

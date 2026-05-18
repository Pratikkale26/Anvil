pub fn mpl_mint_new_edition_from_master<'a>(
    new_metadata: &AccountInfo<'a>,
    new_edition: &AccountInfo<'a>,
    master_edition: &AccountInfo<'a>,
    new_mint: &AccountInfo<'a>,
    edition_mark_pda: &AccountInfo<'a>,
    new_mint_authority: &AccountInfo<'a>,
    payer: &AccountInfo<'a>,
    token_account_owner: &AccountInfo<'a>,
    token_account: &AccountInfo<'a>,
    new_metadata_update_authority: &AccountInfo<'a>,
    metadata: &AccountInfo<'a>,
    token_program: &AccountInfo<'a>,
    system_program: &AccountInfo<'a>,
    rent: &AccountInfo<'a>,
    token_metadata_program: &AccountInfo<'a>,
    edition: u64,
    signer_seeds: Option<&[&[&[u8]]]>,
) -> ProgramResult {
    let mut data: Vec<u8> = Vec::with_capacity(9);
    data.push(11);
    data.extend_from_slice(&edition.to_le_bytes());
    let accounts = vec![
        AccountMeta::new(*new_metadata.key, false),
        AccountMeta::new(*new_edition.key, false),
        AccountMeta::new(*master_edition.key, false),
        AccountMeta::new(*new_mint.key, false),
        AccountMeta::new(*edition_mark_pda.key, false),
        AccountMeta::new_readonly(*new_mint_authority.key, true),
        AccountMeta::new(*payer.key, true),
        AccountMeta::new_readonly(*token_account_owner.key, true),
        AccountMeta::new_readonly(*token_account.key, false),
        AccountMeta::new_readonly(*new_metadata_update_authority.key, false),
        AccountMeta::new_readonly(*metadata.key, false),
        AccountMeta::new_readonly(*token_program.key, false),
        AccountMeta::new_readonly(*system_program.key, false),
        AccountMeta::new_readonly(*rent.key, false),
    ];
    let ix = Instruction { program_id: *token_metadata_program.key, accounts, data };
    let infos = [
        new_metadata.clone(), new_edition.clone(), master_edition.clone(),
        new_mint.clone(), edition_mark_pda.clone(), new_mint_authority.clone(),
        payer.clone(), token_account_owner.clone(), token_account.clone(),
        new_metadata_update_authority.clone(), metadata.clone(),
        token_program.clone(), system_program.clone(), rent.clone(),
    ];
    match signer_seeds {
        Some(seeds) => invoke_signed(&ix, &infos, seeds),
        None => invoke(&ix, &infos),
    }
}

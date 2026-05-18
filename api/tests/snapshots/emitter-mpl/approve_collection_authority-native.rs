pub fn mpl_approve_collection_authority<'a>(
    collection_authority_record: &AccountInfo<'a>,
    new_collection_authority: &AccountInfo<'a>,
    update_authority: &AccountInfo<'a>,
    payer: &AccountInfo<'a>,
    metadata: &AccountInfo<'a>,
    mint: &AccountInfo<'a>,
    system_program: &AccountInfo<'a>,
    rent: &AccountInfo<'a>,
    token_metadata_program: &AccountInfo<'a>,
    signer_seeds: Option<&[&[&[u8]]]>,
) -> ProgramResult {
    let data: Vec<u8> = vec![23];
    let accounts = vec![
        AccountMeta::new(*collection_authority_record.key, false),
        AccountMeta::new_readonly(*new_collection_authority.key, false),
        AccountMeta::new_readonly(*update_authority.key, true),
        AccountMeta::new(*payer.key, true),
        AccountMeta::new_readonly(*metadata.key, false),
        AccountMeta::new_readonly(*mint.key, false),
        AccountMeta::new_readonly(*system_program.key, false),
        AccountMeta::new_readonly(*rent.key, false),
    ];
    let ix = Instruction { program_id: *token_metadata_program.key, accounts, data };
    let infos = [
        collection_authority_record.clone(), new_collection_authority.clone(),
        update_authority.clone(), payer.clone(), metadata.clone(), mint.clone(),
        system_program.clone(), rent.clone(),
    ];
    match signer_seeds {
        Some(seeds) => invoke_signed(&ix, &infos, seeds),
        None => invoke(&ix, &infos),
    }
}

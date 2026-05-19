pub fn mpl_verify_collection<'a>(
    metadata: &AccountInfo<'a>,
    collection_authority: &AccountInfo<'a>,
    payer: &AccountInfo<'a>,
    collection_mint: &AccountInfo<'a>,
    collection: &AccountInfo<'a>,
    collection_master_edition: &AccountInfo<'a>,
    token_metadata_program: &AccountInfo<'a>,
    collection_authority_record: Option<&AccountInfo<'a>>,
    signer_seeds: Option<&[&[&[u8]]]>,
) -> ProgramResult {
    let data: Vec<u8> = vec![18];
    let mut accounts = vec![
        AccountMeta::new(*metadata.key, false),
        AccountMeta::new_readonly(*collection_authority.key, true),
        AccountMeta::new(*payer.key, true),
        AccountMeta::new_readonly(*collection_mint.key, false),
        AccountMeta::new_readonly(*collection.key, false),
        AccountMeta::new_readonly(*collection_master_edition.key, false),
    ];
    if let Some(record) = collection_authority_record {
        accounts.push(AccountMeta::new_readonly(*record.key, false));
    }
    let ix = Instruction {
        program_id: *token_metadata_program.key,
        accounts,
        data,
    };
    let mut infos = vec![
        metadata.clone(), collection_authority.clone(), payer.clone(),
        collection_mint.clone(), collection.clone(), collection_master_edition.clone(),
    ];
    if let Some(record) = collection_authority_record {
        infos.push(record.clone());
    }
    match signer_seeds {
        Some(seeds) => invoke_signed(&ix, &infos, seeds),
        None => invoke(&ix, &infos),
    }
}

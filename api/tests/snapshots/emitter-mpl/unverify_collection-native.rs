pub fn mpl_unverify_collection<'a>(
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
    let data: Vec<u8> = vec![22];
    // mpl-token-metadata 5.1.1 UnverifyCollection has 5 base accounts
    // (NO payer slot — unlike VerifyCollection). Drop from metas + infos.
    let _ = payer;
    let mut accounts = vec![
        AccountMeta::new(*metadata.key, false),
        AccountMeta::new_readonly(*collection_authority.key, true),
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
        metadata.clone(), collection_authority.clone(),
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

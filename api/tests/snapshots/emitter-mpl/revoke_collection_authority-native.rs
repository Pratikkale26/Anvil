pub fn mpl_revoke_collection_authority<'a>(
    collection_authority_record: &AccountInfo<'a>,
    delegate_authority: &AccountInfo<'a>,
    revoke_authority: &AccountInfo<'a>,
    metadata: &AccountInfo<'a>,
    mint: &AccountInfo<'a>,
    token_metadata_program: &AccountInfo<'a>,
    signer_seeds: Option<&[&[&[u8]]]>,
) -> ProgramResult {
    let data: Vec<u8> = vec![24];
    // MPL RevokeCollectionAuthority spec: delegate_authority is writable
    // (writable=true, signer=false) — used in the record PDA close.
    let accounts = vec![
        AccountMeta::new(*collection_authority_record.key, false),
        AccountMeta::new(*delegate_authority.key, false),
        AccountMeta::new(*revoke_authority.key, true),
        AccountMeta::new_readonly(*metadata.key, false),
        AccountMeta::new_readonly(*mint.key, false),
    ];
    let ix = Instruction { program_id: *token_metadata_program.key, accounts, data };
    let infos = [
        collection_authority_record.clone(), delegate_authority.clone(),
        revoke_authority.clone(), metadata.clone(), mint.clone(),
    ];
    match signer_seeds {
        Some(seeds) => invoke_signed(&ix, &infos, seeds),
        None => invoke(&ix, &infos),
    }
}

pub fn mpl_sign_metadata<'a>(
    metadata: &AccountInfo<'a>,
    creator: &AccountInfo<'a>,
    token_metadata_program: &AccountInfo<'a>,
    signer_seeds: Option<&[&[&[u8]]]>,
) -> ProgramResult {
    let data: Vec<u8> = vec![7];
    let accounts = vec![
        AccountMeta::new(*metadata.key, false),
        AccountMeta::new_readonly(*creator.key, true),
    ];
    let ix = Instruction {
        program_id: *token_metadata_program.key,
        accounts,
        data,
    };
    let infos = [metadata.clone(), creator.clone()];
    match signer_seeds {
        Some(seeds) => invoke_signed(&ix, &infos, seeds),
        None => invoke(&ix, &infos),
    }
}

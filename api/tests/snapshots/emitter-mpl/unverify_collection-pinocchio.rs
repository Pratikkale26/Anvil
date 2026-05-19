pub fn mpl_unverify_collection(
    metadata: &AccountInfo,
    collection_authority: &AccountInfo,
    payer: &AccountInfo,
    collection_mint: &AccountInfo,
    collection: &AccountInfo,
    collection_master_edition: &AccountInfo,
    token_metadata_program: &AccountInfo,
    collection_authority_record: Option<&AccountInfo>,
    signer_seeds: Option<&[&[&[u8]]]>,
) -> ProgramResult {
    let data: [u8; 1] = [22];

    // mpl-token-metadata 5.1.1 UnverifyCollection has 5 base accounts
    // (NO payer slot — unlike VerifyCollection). Anvil keeps the payer
    // fn arg for ABI symmetry with verify_collection callers, but drops
    // it from the metas + infos lists to match the wire format.
    let _ = payer;
    let mut metas: [pinocchio::instruction::AccountMeta; 6] =
        core::array::from_fn(|_| pinocchio::instruction::AccountMeta::new(metadata.key(), false, false));
    let mut meta_count: usize = 5;
    metas[0] = pinocchio::instruction::AccountMeta::new(metadata.key(), true, false);
    metas[1] = pinocchio::instruction::AccountMeta::new(collection_authority.key(), false, true);
    metas[2] = pinocchio::instruction::AccountMeta::new(collection_mint.key(), false, false);
    metas[3] = pinocchio::instruction::AccountMeta::new(collection.key(), false, false);
    metas[4] = pinocchio::instruction::AccountMeta::new(collection_master_edition.key(), false, false);
    if let Some(record) = collection_authority_record {
        metas[5] = pinocchio::instruction::AccountMeta::new(record.key(), false, false);
        meta_count = 6;
    }
    let ix = pinocchio::instruction::Instruction {
        program_id: token_metadata_program.key(),
        accounts: &metas[..meta_count],
        data: &data,
    };

    match collection_authority_record {
        Some(record) => {
            let infos: [&AccountInfo; 6] = [
                metadata, collection_authority, collection_mint,
                collection, collection_master_edition, record,
            ];
            match signer_seeds {
                Some(seeds) => {
                    let seed_group = seeds.first().ok_or(ProgramError::InvalidSeeds)?;
                    let mut sd: [Seed<'_>; 8] = core::array::from_fn(|_| Seed::from(&[][..]));
                    for (i, s) in seed_group.iter().enumerate() {
                        if i >= sd.len() { return Err(ProgramError::InvalidSeeds); }
                        sd[i] = Seed::from(*s);
                    }
                    let signer = Signer::from(&sd[..seed_group.len()]);
                    pinocchio::cpi::invoke_signed(&ix, &infos, &[signer])
                }
                None => pinocchio::cpi::invoke(&ix, &infos),
            }
        }
        None => {
            let infos: [&AccountInfo; 5] = [
                metadata, collection_authority, collection_mint,
                collection, collection_master_edition,
            ];
            match signer_seeds {
                Some(seeds) => {
                    let seed_group = seeds.first().ok_or(ProgramError::InvalidSeeds)?;
                    let mut sd: [Seed<'_>; 8] = core::array::from_fn(|_| Seed::from(&[][..]));
                    for (i, s) in seed_group.iter().enumerate() {
                        if i >= sd.len() { return Err(ProgramError::InvalidSeeds); }
                        sd[i] = Seed::from(*s);
                    }
                    let signer = Signer::from(&sd[..seed_group.len()]);
                    pinocchio::cpi::invoke_signed(&ix, &infos, &[signer])
                }
                None => pinocchio::cpi::invoke(&ix, &infos),
            }
        }
    }
}

pub fn mpl_verify_collection(
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
    // VerifyCollection: single-byte data.
    let data: [u8; 1] = [21];

    // Build metas. With collection_authority_record we get 7 slots; without, 6.
    let mut metas: [pinocchio::instruction::AccountMeta; 7] =
        core::array::from_fn(|_| pinocchio::instruction::AccountMeta::new(metadata.key(), false, false));
    let mut meta_count: usize = 6;
    metas[0] = pinocchio::instruction::AccountMeta::new(metadata.key(), true, false);
    metas[1] = pinocchio::instruction::AccountMeta::new(collection_authority.key(), false, true);
    metas[2] = pinocchio::instruction::AccountMeta::new(payer.key(), true, true);
    metas[3] = pinocchio::instruction::AccountMeta::new(collection_mint.key(), false, false);
    metas[4] = pinocchio::instruction::AccountMeta::new(collection.key(), false, false);
    metas[5] = pinocchio::instruction::AccountMeta::new(collection_master_edition.key(), false, false);
    if let Some(record) = collection_authority_record {
        metas[6] = pinocchio::instruction::AccountMeta::new(record.key(), false, false);
        meta_count = 7;
    }
    let ix = pinocchio::instruction::Instruction {
        program_id: token_metadata_program.key(),
        accounts: &metas[..meta_count],
        data: &data,
    };

    // Same conditional infos slice — collection_authority_record adds slot.
    let infos_base = [
        metadata, collection_authority, payer, collection_mint,
        collection, collection_master_edition,
    ];
    let infos_extra;
    let infos: &[&AccountInfo] = match collection_authority_record {
        Some(record) => {
            infos_extra = [
                metadata, collection_authority, payer, collection_mint,
                collection, collection_master_edition, record,
            ];
            &infos_extra
        }
        None => &infos_base,
    };

    match signer_seeds {
        Some(seeds) => {
            let seed_group = seeds.first().ok_or(ProgramError::InvalidSeeds)?;
            let mut sd: [Seed<'_>; 8] = core::array::from_fn(|_| Seed::from(&[][..]));
            for (i, s) in seed_group.iter().enumerate() {
                if i >= sd.len() { return Err(ProgramError::InvalidSeeds); }
                sd[i] = Seed::from(*s);
            }
            let signer = Signer::from(&sd[..seed_group.len()]);
            pinocchio::cpi::invoke_signed(&ix, infos, &[signer])
        }
        None => pinocchio::cpi::invoke(&ix, infos),
    }
}

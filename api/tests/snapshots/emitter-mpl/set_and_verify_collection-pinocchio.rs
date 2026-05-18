pub fn mpl_set_and_verify_collection(
    metadata: &AccountInfo,
    collection_authority: &AccountInfo,
    payer: &AccountInfo,
    update_authority: &AccountInfo,
    collection_mint: &AccountInfo,
    collection: &AccountInfo,
    collection_master_edition: &AccountInfo,
    token_metadata_program: &AccountInfo,
    collection_authority_record: Option<&AccountInfo>,
    signer_seeds: Option<&[&[&[u8]]]>,
) -> ProgramResult {
    let data: [u8; 1] = [25];

    // 7 base accounts (+1 optional collection_authority_record).
    let mut metas: [pinocchio::instruction::AccountMeta; 8] =
        core::array::from_fn(|_| pinocchio::instruction::AccountMeta::new(metadata.key(), false, false));
    let mut meta_count: usize = 7;
    metas[0] = pinocchio::instruction::AccountMeta::new(metadata.key(), true, false);
    metas[1] = pinocchio::instruction::AccountMeta::new(collection_authority.key(), false, true);
    metas[2] = pinocchio::instruction::AccountMeta::new(payer.key(), true, true);
    metas[3] = pinocchio::instruction::AccountMeta::new(update_authority.key(), false, true);
    metas[4] = pinocchio::instruction::AccountMeta::new(collection_mint.key(), false, false);
    metas[5] = pinocchio::instruction::AccountMeta::new(collection.key(), false, false);
    metas[6] = pinocchio::instruction::AccountMeta::new(collection_master_edition.key(), false, false);
    if let Some(record) = collection_authority_record {
        metas[7] = pinocchio::instruction::AccountMeta::new(record.key(), false, false);
        meta_count = 8;
    }
    let ix = pinocchio::instruction::Instruction {
        program_id: token_metadata_program.key(),
        accounts: &metas[..meta_count],
        data: &data,
    };

    let infos_base = [
        metadata, collection_authority, payer, update_authority,
        collection_mint, collection, collection_master_edition,
    ];
    let infos_extra;
    let infos: &[&AccountInfo] = match collection_authority_record {
        Some(record) => {
            infos_extra = [
                metadata, collection_authority, payer, update_authority,
                collection_mint, collection, collection_master_edition, record,
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

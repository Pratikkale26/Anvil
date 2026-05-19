pub fn mpl_approve_collection_authority(
    collection_authority_record: &AccountInfo,
    new_collection_authority: &AccountInfo,
    update_authority: &AccountInfo,
    payer: &AccountInfo,
    metadata: &AccountInfo,
    mint: &AccountInfo,
    system_program: &AccountInfo,
    rent: &AccountInfo,
    token_metadata_program: &AccountInfo,
    signer_seeds: Option<&[&[&[u8]]]>,
) -> ProgramResult {
    let data: [u8; 1] = [23];
    // anchor-spl 0.31's approve_collection_authority wrapper hard-codes
    // `rent: None` — the rent slot is OMITTED from the account list.
    // Matching that produces byte-equal CPI invocations.
    let _ = rent;
    let metas = [
        pinocchio::instruction::AccountMeta::new(collection_authority_record.key(), true, false),
        pinocchio::instruction::AccountMeta::new(new_collection_authority.key(), false, false),
        pinocchio::instruction::AccountMeta::new(update_authority.key(), false, true),
        pinocchio::instruction::AccountMeta::new(payer.key(), true, true),
        pinocchio::instruction::AccountMeta::new(metadata.key(), false, false),
        pinocchio::instruction::AccountMeta::new(mint.key(), false, false),
        pinocchio::instruction::AccountMeta::new(system_program.key(), false, false),
    ];
    let ix = pinocchio::instruction::Instruction {
        program_id: token_metadata_program.key(),
        accounts: &metas,
        data: &data,
    };
    let infos = [
        collection_authority_record, new_collection_authority,
        update_authority, payer, metadata, mint,
        system_program,
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

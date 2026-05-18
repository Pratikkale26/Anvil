pub fn mpl_sign_metadata(
    metadata: &AccountInfo,
    creator: &AccountInfo,
    token_metadata_program: &AccountInfo,
    signer_seeds: Option<&[&[&[u8]]]>,
) -> ProgramResult {
    let data: [u8; 1] = [7];
    let metas = [
        pinocchio::instruction::AccountMeta::new(metadata.key(), true, false),
        pinocchio::instruction::AccountMeta::new(creator.key(), false, true),
    ];
    let ix = pinocchio::instruction::Instruction {
        program_id: token_metadata_program.key(),
        accounts: &metas,
        data: &data,
    };
    let infos = [metadata, creator];
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

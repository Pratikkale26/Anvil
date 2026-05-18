pub fn mpl_freeze_delegated(
    delegate: &AccountInfo,
    token_account: &AccountInfo,
    edition: &AccountInfo,
    mint: &AccountInfo,
    token_program: &AccountInfo,
    token_metadata_program: &AccountInfo,
    signer_seeds: Option<&[&[&[u8]]]>,
) -> ProgramResult {
    let data: [u8; 1] = [26];
    let metas = [
        pinocchio::instruction::AccountMeta::new(delegate.key(), false, true),
        pinocchio::instruction::AccountMeta::new(token_account.key(), true, false),
        pinocchio::instruction::AccountMeta::new(edition.key(), false, false),
        pinocchio::instruction::AccountMeta::new(mint.key(), false, false),
        pinocchio::instruction::AccountMeta::new(token_program.key(), false, false),
    ];
    let ix = pinocchio::instruction::Instruction {
        program_id: token_metadata_program.key(),
        accounts: &metas,
        data: &data,
    };
    let infos = [delegate, token_account, edition, mint, token_program];
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

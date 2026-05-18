pub fn mpl_mint_new_edition_from_master(
    new_metadata: &AccountInfo,
    new_edition: &AccountInfo,
    master_edition: &AccountInfo,
    new_mint: &AccountInfo,
    edition_mark_pda: &AccountInfo,
    new_mint_authority: &AccountInfo,
    payer: &AccountInfo,
    token_account_owner: &AccountInfo,
    token_account: &AccountInfo,
    new_metadata_update_authority: &AccountInfo,
    metadata: &AccountInfo,
    token_program: &AccountInfo,
    system_program: &AccountInfo,
    rent: &AccountInfo,
    token_metadata_program: &AccountInfo,
    edition: u64,
    signer_seeds: Option<&[&[&[u8]]]>,
) -> ProgramResult {
    let mut data: Vec<u8> = Vec::with_capacity(9);
    data.push(11);
    data.extend_from_slice(&edition.to_le_bytes());
    let metas = [
        pinocchio::instruction::AccountMeta::new(new_metadata.key(), true, false),
        pinocchio::instruction::AccountMeta::new(new_edition.key(), true, false),
        pinocchio::instruction::AccountMeta::new(master_edition.key(), true, false),
        pinocchio::instruction::AccountMeta::new(new_mint.key(), true, false),
        pinocchio::instruction::AccountMeta::new(edition_mark_pda.key(), true, false),
        pinocchio::instruction::AccountMeta::new(new_mint_authority.key(), false, true),
        pinocchio::instruction::AccountMeta::new(payer.key(), true, true),
        pinocchio::instruction::AccountMeta::new(token_account_owner.key(), false, true),
        pinocchio::instruction::AccountMeta::new(token_account.key(), false, false),
        pinocchio::instruction::AccountMeta::new(new_metadata_update_authority.key(), false, false),
        pinocchio::instruction::AccountMeta::new(metadata.key(), false, false),
        pinocchio::instruction::AccountMeta::new(token_program.key(), false, false),
        pinocchio::instruction::AccountMeta::new(system_program.key(), false, false),
        pinocchio::instruction::AccountMeta::new(rent.key(), false, false),
    ];
    let ix = pinocchio::instruction::Instruction {
        program_id: token_metadata_program.key(),
        accounts: &metas,
        data: &data,
    };
    let infos = [
        new_metadata, new_edition, master_edition, new_mint, edition_mark_pda,
        new_mint_authority, payer, token_account_owner, token_account,
        new_metadata_update_authority, metadata, token_program, system_program, rent,
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

pub fn mpl_revoke_collection_authority(
    collection_authority_record: &AccountInfo,
    delegate_authority: &AccountInfo,
    revoke_authority: &AccountInfo,
    metadata: &AccountInfo,
    mint: &AccountInfo,
    token_metadata_program: &AccountInfo,
    signer_seeds: Option<&[&[&[u8]]]>,
) -> ProgramResult {
    let data: [u8; 1] = [24];
    // MPL RevokeCollectionAuthority spec: delegate_authority is writable
    // (writable=true, signer=false) — used in the record PDA close.
    let metas = [
        pinocchio::instruction::AccountMeta::new(collection_authority_record.key(), true, false),
        pinocchio::instruction::AccountMeta::new(delegate_authority.key(), true, false),
        pinocchio::instruction::AccountMeta::new(revoke_authority.key(), true, true),
        pinocchio::instruction::AccountMeta::new(metadata.key(), false, false),
        pinocchio::instruction::AccountMeta::new(mint.key(), false, false),
    ];
    let ix = pinocchio::instruction::Instruction {
        program_id: token_metadata_program.key(),
        accounts: &metas,
        data: &data,
    };
    let infos = [
        collection_authority_record, delegate_authority, revoke_authority,
        metadata, mint,
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

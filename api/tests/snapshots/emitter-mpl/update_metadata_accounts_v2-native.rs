pub fn mpl_update_metadata_accounts_v2<'a>(
    metadata: &AccountInfo<'a>,
    update_authority: &AccountInfo<'a>,
    token_metadata_program: &AccountInfo<'a>,
    new_update_authority: Option<&Pubkey>,
    has_data_update: bool,
    new_name: &str,
    new_symbol: &str,
    new_uri: &str,
    new_seller_fee_basis_points: u16,
    primary_sale_happened: Option<bool>,
    is_mutable: Option<bool>,
    signer_seeds: Option<&[&[&[u8]]]>,
) -> ProgramResult {
    let mut data: Vec<u8> =
        Vec::with_capacity(64 + new_name.len() + new_symbol.len() + new_uri.len());
    data.push(15);
    // MPL 5.1.1 UpdateMetadataAccountV2InstructionArgs Borsh field order:
    // data, new_update_authority, primary_sale_happened, is_mutable.
    if has_data_update {
        data.push(1);
        data.extend_from_slice(&(new_name.len() as u32).to_le_bytes());
        data.extend_from_slice(new_name.as_bytes());
        data.extend_from_slice(&(new_symbol.len() as u32).to_le_bytes());
        data.extend_from_slice(new_symbol.as_bytes());
        data.extend_from_slice(&(new_uri.len() as u32).to_le_bytes());
        data.extend_from_slice(new_uri.as_bytes());
        data.extend_from_slice(&new_seller_fee_basis_points.to_le_bytes());
        data.push(0); // creators = None
        data.push(0); // collection = None
        data.push(0); // uses = None
    } else {
        data.push(0);
    }
    match new_update_authority {
        Some(pk) => { data.push(1); data.extend_from_slice(pk.as_ref()); }
        None => data.push(0),
    }
    match primary_sale_happened {
        Some(b) => { data.push(1); data.push(if b { 1 } else { 0 }); }
        None => data.push(0),
    }
    match is_mutable {
        Some(b) => { data.push(1); data.push(if b { 1 } else { 0 }); }
        None => data.push(0),
    }
    let accounts = vec![
        AccountMeta::new(*metadata.key, false),
        AccountMeta::new_readonly(*update_authority.key, true),
    ];
    let ix = Instruction {
        program_id: *token_metadata_program.key,
        accounts,
        data,
    };
    let infos = [metadata.clone(), update_authority.clone()];
    match signer_seeds {
        Some(seeds) => invoke_signed(&ix, &infos, seeds),
        None => invoke(&ix, &infos),
    }
}

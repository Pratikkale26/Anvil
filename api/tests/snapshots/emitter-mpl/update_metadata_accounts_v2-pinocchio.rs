pub fn mpl_update_metadata_accounts_v2(
    metadata: &AccountInfo,
    update_authority: &AccountInfo,
    token_metadata_program: &AccountInfo,
    new_update_authority: Option<&Pubkey>,
    has_data_update: bool,
    new_name: &str,
    new_symbol: &str,
    new_uri: &str,
    new_seller_fee_basis_points: u16,
    creators: Option<Vec<Creator>>,
    primary_sale_happened: Option<bool>,
    is_mutable: Option<bool>,
    signer_seeds: Option<&[&[&[u8]]]>,
) -> ProgramResult {
    let mut data: Vec<u8> =
        Vec::with_capacity(64 + new_name.len() + new_symbol.len() + new_uri.len());
    // UpdateMetadataAccountV2 discriminator
    data.push(15);
    // MPL 5.1.1 UpdateMetadataAccountV2InstructionArgs field order:
    //   data: Option<DataV2>,
    //   new_update_authority: Option<Pubkey>,
    //   primary_sale_happened: Option<bool>,
    //   is_mutable: Option<bool>.
    // Anchor's wrapper uses named struct-literal init so its source-text
    // order doesn't matter; what's on the wire is determined by the
    // struct declaration. Borsh serializes fields in declaration order.
    // Option<DataV2> data
    if has_data_update {
        data.push(1);
        // DataV2.name
        data.extend_from_slice(&(new_name.len() as u32).to_le_bytes());
        data.extend_from_slice(new_name.as_bytes());
        // DataV2.symbol
        data.extend_from_slice(&(new_symbol.len() as u32).to_le_bytes());
        data.extend_from_slice(new_symbol.as_bytes());
        // DataV2.uri
        data.extend_from_slice(&(new_uri.len() as u32).to_le_bytes());
        data.extend_from_slice(new_uri.as_bytes());
        // DataV2.seller_fee_basis_points
        data.extend_from_slice(&new_seller_fee_basis_points.to_le_bytes());
        // DataV2.creators
        match creators {
            Some(arr) => {
                data.push(1);
                data.extend_from_slice(&(arr.len() as u32).to_le_bytes());
                for c in arr {
                    data.extend_from_slice(&c.address[..]);
                    data.push(if c.verified { 1 } else { 0 });
                    data.push(c.share);
                }
            }
            None => data.push(0),
        }
        // DataV2.collection = None, uses = None
        data.push(0);
        data.push(0);
    } else {
        let _ = creators;
        data.push(0);
    }
    // Option<Pubkey> new_update_authority
    match new_update_authority {
        Some(pk) => {
            data.push(1);
            data.extend_from_slice(pk);
        }
        None => data.push(0),
    }
    // Option<bool> primary_sale_happened
    match primary_sale_happened {
        Some(b) => { data.push(1); data.push(if b { 1 } else { 0 }); }
        None => data.push(0),
    }
    // Option<bool> is_mutable
    match is_mutable {
        Some(b) => { data.push(1); data.push(if b { 1 } else { 0 }); }
        None => data.push(0),
    }
    let metas = [
        pinocchio::instruction::AccountMeta::new(metadata.key(), true, false),
        pinocchio::instruction::AccountMeta::new(update_authority.key(), false, true),
    ];
    let ix = pinocchio::instruction::Instruction {
        program_id: token_metadata_program.key(),
        accounts: &metas,
        data: &data,
    };
    let infos = [metadata, update_authority];
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

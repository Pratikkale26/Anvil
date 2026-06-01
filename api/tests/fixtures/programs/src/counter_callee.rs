//! Minimal uncataloged callee for the #5 cpi_custom gold-standard gate.
//! `bump_counter`: accounts = [counter (writable, owned-by-this-program),
//! authority (must be a signer)]; data = u64 LE amount; effect = counter += amount.
//! The signer + owner + data checks make account-meta order, signer-seeds, and
//! instruction-data each LOAD-BEARING — a wrong cpi_custom emit diverges.
use solana_program::{
    account_info::{next_account_info, AccountInfo},
    entrypoint, entrypoint::ProgramResult, program_error::ProgramError, pubkey::Pubkey,
};
entrypoint!(process);
fn process(program_id: &Pubkey, accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {
    let ai = &mut accounts.iter();
    let counter = next_account_info(ai)?;     // accounts[0]
    let authority = next_account_info(ai)?;    // accounts[1]
    if !authority.is_signer { return Err(ProgramError::MissingRequiredSignature); }
    if counter.owner != program_id { return Err(ProgramError::IllegalOwner); }
    if data.len() < 8 { return Err(ProgramError::InvalidInstructionData); }
    let amount = u64::from_le_bytes(data[0..8].try_into().unwrap());
    let mut buf = counter.try_borrow_mut_data()?;
    if buf.len() < 8 { return Err(ProgramError::AccountDataTooSmall); }
    let cur = u64::from_le_bytes(buf[0..8].try_into().unwrap());
    buf[0..8].copy_from_slice(&cur.wrapping_add(amount).to_le_bytes());
    Ok(())
}

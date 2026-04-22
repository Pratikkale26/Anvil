use anchor_lang::prelude::*;

#[error_code]
pub enum ProgramError {
    #[msg("Value exceeds maximum")]
    ValueTooLarge,
    #[msg("Unauthorized")]
    Unauthorized,
}

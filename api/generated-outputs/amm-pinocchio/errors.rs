//! Error definitions for Amm

#[derive(Clone, Copy, Debug, PartialEq)]
#[repr(u32)]
pub enum AmmError {
    /// Invalid fee rate
    InvalidFeeRate = 6000,
    /// Invalid price
    InvalidPrice = 6001,
    /// Invalid amount
    InvalidAmount = 6002,
    /// Pool is frozen
    PoolFrozen = 6003,
    /// Slippage exceeded
    SlippageExceeded = 6004,
    /// Insufficient liquidity
    InsufficientLiquidity = 6005,
    /// Unauthorized
    Unauthorized = 6006,
    /// Arithmetic overflow
    Overflow = 6007,
    /// Arithmetic underflow
    Underflow = 6008,
}

impl From<AmmError> for ProgramError {
    fn from(error: AmmError) -> Self {
        ProgramError::Custom(error as u32)
    }
}
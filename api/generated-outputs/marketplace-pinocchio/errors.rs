//! Error definitions for Marketplace

#[derive(Clone, Copy, Debug, PartialEq)]
#[repr(u32)]
pub enum MarketplaceError {
    /// Price must be greater than zero
    InvalidPrice = 6000,
    /// Fee must be between 0 and 10000 bps
    InvalidFeeBps = 6001,
    /// Listing is not active
    ListingNotActive = 6002,
    /// Unauthorized
    Unauthorized = 6003,
    /// Arithmetic overflow
    Overflow = 6004,
    /// Arithmetic underflow
    Underflow = 6005,
}

impl From<MarketplaceError> for ProgramError {
    fn from(error: MarketplaceError) -> Self {
        ProgramError::Custom(error as u32)
    }
}
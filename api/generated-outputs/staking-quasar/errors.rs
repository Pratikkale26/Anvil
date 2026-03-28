//! Error definitions for Staking

#[derive(Clone, Copy, Debug, PartialEq)]
#[repr(u32)]
pub enum StakingError {
    /// Reward rate must be greater than zero
    InvalidRewardRate = 6000,
    /// Lock duration must be greater than zero
    InvalidLockDuration = 6001,
    /// Max stake must be greater than zero
    InvalidMaxStake = 6002,
    /// Amount must be greater than zero
    InvalidAmount = 6003,
    /// Pool is paused
    PoolPaused = 6004,
    /// Max stake exceeded
    MaxStakeExceeded = 6005,
    /// No rewards to claim
    NoRewards = 6006,
    /// Tokens are still locked
    StillLocked = 6007,
    /// Unauthorized
    Unauthorized = 6008,
    /// Arithmetic overflow
    Overflow = 6009,
    /// Arithmetic underflow
    Underflow = 6010,
}

impl From<StakingError> for ProgramError {
    fn from(error: StakingError) -> Self {
        ProgramError::Custom(error as u32)
    }
}
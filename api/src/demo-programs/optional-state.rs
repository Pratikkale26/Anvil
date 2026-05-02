// Optional-state differential fixture.
//
// Exercises borsh Option<T> encoding in account state. Borsh layout:
//   None  -> 1 byte: 0x00
//   Some  -> 1 byte: 0x01 + N bytes of T
// If the Anvil emit's Option<T> read or write desyncs by even one byte,
// every following field shifts and the byte-equal compare fails loudly.
//
// Two scenarios in the test exercise both code paths: one with delegate=None,
// one with delegate=Some(pubkey). Both must round-trip byte-equal across
// Anchor + Anvil-Pinocchio.

use anchor_lang::prelude::*;

declare_id!("optn111111111111111111111111111111111111111");

#[program]
pub mod optional_state_demo {
    use super::*;

    pub fn init(ctx: Context<Init>, delegate: Option<Pubkey>, expiry: Option<i64>) -> Result<()> {
        let v = &mut ctx.accounts.vault;
        v.owner = ctx.accounts.owner.key();
        v.delegate = delegate;
        v.expiry = expiry;
        v.balance = 0;
        v.bump = ctx.bumps.vault;
        Ok(())
    }

    pub fn deposit(ctx: Context<Update>, amount: u64) -> Result<()> {
        let v = &mut ctx.accounts.vault;
        v.balance = v.balance.checked_add(amount).ok_or(VaultError::Overflow)?;
        Ok(())
    }

    pub fn clear_delegate(ctx: Context<Update>) -> Result<()> {
        let v = &mut ctx.accounts.vault;
        v.delegate = None;
        Ok(())
    }
}

#[derive(Accounts)]
pub struct Init<'info> {
    #[account(
        init,
        payer = owner,
        space = 256,
        seeds = [b"opt-vault", owner.key().as_ref()],
        bump
    )]
    pub vault: Account<'info, OptVault>,
    #[account(mut)]
    pub owner: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Update<'info> {
    #[account(
        mut,
        has_one = owner,
        seeds = [b"opt-vault", owner.key().as_ref()],
        bump = vault.bump
    )]
    pub vault: Account<'info, OptVault>,
    pub owner: Signer<'info>,
}

#[account]
pub struct OptVault {
    pub owner: Pubkey,
    pub delegate: Option<Pubkey>,
    pub expiry: Option<i64>,
    pub balance: u64,
    pub bump: u8,
}

#[error_code]
pub enum VaultError {
    #[msg("Balance overflow")]
    Overflow,
}

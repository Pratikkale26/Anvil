use anchor_lang::prelude::*;

declare_id!("EnumD11111111111111111111111111111111111111");

// Regression fixture for the enum explicit-discriminant borsh divergence.
// `Kind` carries explicit `= N` discriminants. anchor-lang pins borsh 0.10,
// which serializes enum tags by ORDINAL position (A->0, B->1, C->2) and
// ignores the explicit values. The stored `kind` tag byte must therefore be
// the ordinal (Kind::B -> 1), NOT the declared value (20). Anvil must emit
// `#[borsh(use_discriminant = false)]` to match; emitting `= true` corrupts
// the on-chain tag byte (B -> 20) silently.
#[program]
pub mod enum_discriminant {
    use super::*;

    pub fn initialize(ctx: Context<Init>) -> Result<()> {
        let acc = &mut ctx.accounts.data;
        acc.kind = Kind::B;
        Ok(())
    }
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, PartialEq)]
pub enum Kind {
    A = 10,
    B = 20,
    C = 30,
}

#[account]
pub struct Data {
    pub kind: Kind,
}

#[derive(Accounts)]
pub struct Init<'info> {
    #[account(init, payer = payer, space = 8 + 1)]
    pub data: Account<'info, Data>,
    #[account(mut)]
    pub payer: Signer<'info>,
    pub system_program: Program<'info, System>,
}

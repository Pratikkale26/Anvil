use anchor_lang::prelude::*;
use anchor_spl::token_interface::{
    transfer_fee_initialize, transfer_fee_set, Token2022, TransferFeeInitialize,
    TransferFeeSetTransferFee,
};

declare_id!("Tf1mC7QPzUNqx4M2YxYx4dXq8j5wvwZ7VtWJTeyWfuV");

#[program]
pub mod t22_transfer_fee_init {
    use super::*;

    /// Initialize a TransferFee mint extension. Mint must be
    /// pre-allocated with extension space (caller's responsibility).
    /// Authority + withdraw authority both default to `payer`.
    pub fn make_transfer_fee(
        ctx: Context<MakeTransferFee>,
        transfer_fee_basis_points: u16,
        maximum_fee: u64,
    ) -> Result<()> {
        transfer_fee_initialize(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                TransferFeeInitialize {
                    token_program_id: ctx.accounts.token_program.to_account_info(),
                    mint: ctx.accounts.mint.to_account_info(),
                },
            ),
            Some(&ctx.accounts.payer.key()),
            Some(&ctx.accounts.payer.key()),
            transfer_fee_basis_points,
            maximum_fee,
        )?;
        Ok(())
    }

    /// Update the transfer-fee schedule on an existing TransferFee mint.
    pub fn update_transfer_fee(
        ctx: Context<UpdateTransferFee>,
        transfer_fee_basis_points: u16,
        maximum_fee: u64,
    ) -> Result<()> {
        transfer_fee_set(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                TransferFeeSetTransferFee {
                    token_program_id: ctx.accounts.token_program.to_account_info(),
                    mint: ctx.accounts.mint.to_account_info(),
                    authority: ctx.accounts.authority.to_account_info(),
                },
            ),
            transfer_fee_basis_points,
            maximum_fee,
        )?;
        Ok(())
    }
}

#[derive(Accounts)]
pub struct MakeTransferFee<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    /// CHECK: Pre-allocated mint with extension space; Token-2022 program
    /// validates state on the CPI. Anchor's InterfaceAccount<Mint> would
    /// reject the uninitialized mint at constraint time.
    #[account(mut)]
    pub mint: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token2022>,
}

#[derive(Accounts)]
pub struct UpdateTransferFee<'info> {
    pub authority: Signer<'info>,
    /// CHECK: Mint with TransferFee extension already initialized.
    #[account(mut)]
    pub mint: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token2022>,
}

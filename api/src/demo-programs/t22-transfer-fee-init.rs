use anchor_lang::prelude::*;
use anchor_spl::token_interface::{
    harvest_withheld_tokens_to_mint, transfer_checked_with_fee, transfer_fee_initialize,
    transfer_fee_set, withdraw_withheld_tokens_from_mint, HarvestWithheldTokensToMint,
    Token2022, TransferCheckedWithFee, TransferFeeInitialize, TransferFeeSetTransferFee,
    WithdrawWithheldTokensFromMint,
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

    /// TransferFee variant of transfer_checked. Caller asserts decimals
    /// + the expected fee for the transfer; Token-2022 verifies both.
    pub fn fee_transfer(
        ctx: Context<FeeTransfer>,
        amount: u64,
        decimals: u8,
        fee: u64,
    ) -> Result<()> {
        transfer_checked_with_fee(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                TransferCheckedWithFee {
                    token_program_id: ctx.accounts.token_program.to_account_info(),
                    source: ctx.accounts.source.to_account_info(),
                    mint: ctx.accounts.mint.to_account_info(),
                    destination: ctx.accounts.destination.to_account_info(),
                    authority: ctx.accounts.authority.to_account_info(),
                },
            ),
            amount,
            decimals,
            fee,
        )?;
        Ok(())
    }

    /// Withdraw fees that have been harvested into the mint to a
    /// destination token account. Authority is the withdraw_withheld
    /// authority configured at TransferFee init.
    pub fn withdraw_fees(ctx: Context<WithdrawFees>) -> Result<()> {
        withdraw_withheld_tokens_from_mint(CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            WithdrawWithheldTokensFromMint {
                token_program_id: ctx.accounts.token_program.to_account_info(),
                mint: ctx.accounts.mint.to_account_info(),
                destination: ctx.accounts.destination.to_account_info(),
                authority: ctx.accounts.authority.to_account_info(),
            },
        ))?;
        Ok(())
    }

    /// Sweep accrued fees from a single source token account into the
    /// mint's withheld pool. The wrapped CPI accepts Vec<AccountInfo>
    /// for runtime-length lists; this demo passes a 1-element Vec to
    /// keep the Context shape simple. Pinocchio emit dispatches the
    /// invoke through a match-on-N branch table (N=1..16).
    pub fn harvest_fees(ctx: Context<HarvestFees>) -> Result<()> {
        let sources = vec![ctx.accounts.source.to_account_info()];
        harvest_withheld_tokens_to_mint(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                HarvestWithheldTokensToMint {
                    token_program_id: ctx.accounts.token_program.to_account_info(),
                    mint: ctx.accounts.mint.to_account_info(),
                },
            ),
            sources,
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

#[derive(Accounts)]
pub struct FeeTransfer<'info> {
    pub authority: Signer<'info>,
    /// CHECK: TransferFee mint
    pub mint: UncheckedAccount<'info>,
    /// CHECK: Source token account
    #[account(mut)]
    pub source: UncheckedAccount<'info>,
    /// CHECK: Destination token account
    #[account(mut)]
    pub destination: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token2022>,
}

#[derive(Accounts)]
pub struct WithdrawFees<'info> {
    pub authority: Signer<'info>,
    /// CHECK: TransferFee mint
    #[account(mut)]
    pub mint: UncheckedAccount<'info>,
    /// CHECK: Destination token account for withdrawn fees
    #[account(mut)]
    pub destination: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token2022>,
}

#[derive(Accounts)]
pub struct HarvestFees<'info> {
    /// CHECK: TransferFee mint — fees swept here from `source`.
    #[account(mut)]
    pub mint: UncheckedAccount<'info>,
    /// CHECK: Source token account holding accrued fees.
    #[account(mut)]
    pub source: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token2022>,
}


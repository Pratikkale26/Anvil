use anchor_lang::prelude::*;
use anchor_spl::token_interface::{memo_transfer_initialize, MemoTransfer, Token2022};

declare_id!("74QBDrdTNg8hqnDzZzLoCzQL1T7eR9KtCKmHy5R1vGDr");

#[program]
pub mod t22_memo_transfer {
    use super::*;

    /// Enable the RequiredMemoTransfers extension on a token account.
    /// The account must be pre-initialized with MemoTransfer extension
    /// space and owned by `owner`, who signs the toggle. After this call,
    /// the account's `require_incoming_transfer_memos` flag is set.
    pub fn enable_memos(ctx: Context<EnableMemos>) -> Result<()> {
        memo_transfer_initialize(CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            MemoTransfer {
                token_program_id: ctx.accounts.token_program.to_account_info(),
                account: ctx.accounts.token_account.to_account_info(),
                owner: ctx.accounts.owner.to_account_info(),
            },
        ))?;
        Ok(())
    }
}

#[derive(Accounts)]
pub struct EnableMemos<'info> {
    /// CHECK: Pre-initialized Token-2022 account with MemoTransfer extension
    /// space; the Token-2022 program validates state on the CPI.
    #[account(mut)]
    pub token_account: UncheckedAccount<'info>,
    /// CHECK: The token account owner — signs the RequiredMemoTransfers toggle.
    pub owner: Signer<'info>,
    pub token_program: Program<'info, Token2022>,
}

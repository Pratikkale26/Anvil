// Anchor demo: Anchor's `close = receiver` constraint — closes the
// account, transferring its lamports to the receiver and zeroing the
// data. The differential test asserts that Anvil-Pinocchio emits the
// same lamport movement + post-close data layout as Anchor.
use anchor_lang::prelude::*;

declare_id!("CLoSeAccount11111111111111111111111111111111");

#[program]
pub mod close_account_demo {
    use super::*;

    pub fn open(ctx: Context<Open>, value: u64) -> Result<()> {
        let note = &mut ctx.accounts.note;
        note.owner = ctx.accounts.owner.key();
        note.value = value;
        Ok(())
    }

    /// Close the note, refund rent to receiver. Anchor's
    /// `close = receiver` macro generates: zero the data, transfer
    /// lamports, mark closed (8-byte CLOSED_ACCOUNT_DISCRIMINATOR).
    /// Anvil's emit must produce byte-identical post-state.
    pub fn shut(_ctx: Context<Shut>) -> Result<()> {
        Ok(())
    }
}

#[account]
pub struct Note {
    pub owner: Pubkey,
    pub value: u64,
}

#[derive(Accounts)]
pub struct Open<'info> {
    #[account(
        init,
        payer = owner,
        space = 8 + 32 + 8,
        seeds = [b"note", owner.key().as_ref()],
        bump
    )]
    pub note: Account<'info, Note>,
    #[account(mut)]
    pub owner: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Shut<'info> {
    #[account(
        mut,
        close = receiver,
        has_one = owner,
        seeds = [b"note", owner.key().as_ref()],
        bump
    )]
    pub note: Account<'info, Note>,
    /// CHECK: receiver of the rent refund — any pubkey is fine.
    #[account(mut)]
    pub receiver: AccountInfo<'info>,
    pub owner: Signer<'info>,
}

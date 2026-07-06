use anchor_lang::prelude::*;
declare_program!(spl_account_compression);
use spl_account_compression::program::SplAccountCompression;

declare_id!("8ApKuJUB9aJkSznXacuAq1aDgUX16TciJuR2Y3a8ZSGg");

#[program]
pub mod compression_append {
    use super::*;

    /// Append a leaf to an already-initialized concurrent Merkle tree by
    /// CPI'ing into spl-account-compression. The tree + noop log-wrapper are
    /// passed through; the authority signs. Exercises the declare_program! +
    /// IDL external-CPI path for a state-compression program.
    pub fn add_leaf(ctx: Context<AddLeaf>, leaf: [u8; 32]) -> Result<()> {
        let cpi_ctx = CpiContext::new(
            ctx.accounts.compression_program.key(),
            spl_account_compression::cpi::accounts::Append {
                merkle_tree: ctx.accounts.merkle_tree.to_account_info(),
                authority: ctx.accounts.authority.to_account_info(),
                noop: ctx.accounts.noop.to_account_info(),
            },
        );
        spl_account_compression::cpi::append(cpi_ctx, leaf)?;
        Ok(())
    }
}

#[derive(Accounts)]
pub struct AddLeaf<'info> {
    /// CHECK: concurrent Merkle tree account, validated by spl-account-compression.
    #[account(mut)]
    pub merkle_tree: UncheckedAccount<'info>,
    /// CHECK: tree authority — signs the append.
    pub authority: Signer<'info>,
    /// CHECK: spl-noop log wrapper.
    pub noop: UncheckedAccount<'info>,
    pub compression_program: Program<'info, SplAccountCompression>,
}

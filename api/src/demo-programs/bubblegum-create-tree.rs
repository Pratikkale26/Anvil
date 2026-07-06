use anchor_lang::prelude::*;
declare_program!(mpl_bubblegum);
use mpl_bubblegum::program::MplBubblegum;

declare_id!("2JuzxrX9LQh89wZgqkydKU7mzbdTeQhUMVfayTgXdhGE");

#[program]
pub mod bubblegum_create_tree {
    use super::*;

    /// Create a Bubblegum compressed-NFT tree config by CPI'ing into
    /// mpl-bubblegum's `create_tree` (which itself CPIs spl-account-compression
    /// to init the concurrent Merkle tree + spl-noop for the changelog).
    /// Exercises the declare_program! + IDL external-CPI path for Bubblegum.
    pub fn make_tree(ctx: Context<MakeTree>, max_depth: u32, max_buffer_size: u32) -> Result<()> {
        let cpi_ctx = CpiContext::new(
            ctx.accounts.bubblegum_program.key(),
            mpl_bubblegum::cpi::accounts::CreateTree {
                tree_authority: ctx.accounts.tree_authority.to_account_info(),
                merkle_tree: ctx.accounts.merkle_tree.to_account_info(),
                payer: ctx.accounts.payer.to_account_info(),
                tree_creator: ctx.accounts.tree_creator.to_account_info(),
                log_wrapper: ctx.accounts.log_wrapper.to_account_info(),
                compression_program: ctx.accounts.compression_program.to_account_info(),
                system_program: ctx.accounts.system_program.to_account_info(),
            },
        );
        mpl_bubblegum::cpi::create_tree(cpi_ctx, max_depth, max_buffer_size, None)?;
        Ok(())
    }
}

#[derive(Accounts)]
pub struct MakeTree<'info> {
    /// CHECK: tree-config PDA, initialized by Bubblegum.
    #[account(mut)]
    pub tree_authority: UncheckedAccount<'info>,
    /// CHECK: pre-allocated concurrent Merkle tree account.
    #[account(mut)]
    pub merkle_tree: UncheckedAccount<'info>,
    #[account(mut)]
    pub payer: Signer<'info>,
    /// CHECK: tree creator — signs.
    pub tree_creator: Signer<'info>,
    /// CHECK: spl-noop log wrapper.
    pub log_wrapper: UncheckedAccount<'info>,
    /// CHECK: spl-account-compression program.
    pub compression_program: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
    /// CHECK: mpl-bubblegum program being CPI'd.
    pub bubblegum_program: UncheckedAccount<'info>,
}

//! Regex-pattern fixture: unsalvageable-helper commentout.
//!
//! Locks the behavior of `commentOutUnsalvageableCallSites` in
//! emitter-base-utils.ts. Helpers whose signature uses Anchor-only
//! wrapper types (`InterfaceAccount`, `Box<Account>`,
//! `Interface<TokenInterface>`, etc.) get added to
//! `unsalvageableHelpers` by `computeUnsalvageableHelpers`; their bodies
//! are replaced with a banner + commented-out source in helpers.rs and
//! every call site in instruction files is also commented out.
//!
//! The fixture defines `transfer_via_helper(...)` whose signature
//! references `InterfaceAccount<'info, TokenAccount>` so the helper
//! lands in the unsalvageable set. The call site in `do_xfer` is what
//! gets commented out by the post-process pass.
use anchor_lang::prelude::*;
use anchor_spl::token_interface::{TokenAccount, TokenInterface, TransferChecked};

declare_id!("UnsHlp111111111111111111111111111111111111");

#[program]
pub mod unsalvageable_helper_pattern {
    use super::*;

    pub fn do_xfer(ctx: Context<DoXfer>, amount: u64) -> Result<()> {
        transfer_via_helper(
            &ctx.accounts.from,
            &ctx.accounts.to,
            &ctx.accounts.mint,
            &ctx.accounts.authority,
            &ctx.accounts.token_program,
            amount,
        )?;
        Ok(())
    }
}

pub fn transfer_via_helper<'info>(
    from: &InterfaceAccount<'info, TokenAccount>,
    to: &InterfaceAccount<'info, TokenAccount>,
    mint: &InterfaceAccount<'info, anchor_spl::token_interface::Mint>,
    authority: &Signer<'info>,
    token_program: &Interface<'info, TokenInterface>,
    amount: u64,
) -> Result<()> {
    let cpi_accounts = TransferChecked {
        from: from.to_account_info(),
        mint: mint.to_account_info(),
        to: to.to_account_info(),
        authority: authority.to_account_info(),
    };
    let cpi_ctx = CpiContext::new(token_program.to_account_info(), cpi_accounts);
    anchor_spl::token_interface::transfer_checked(cpi_ctx, amount, mint.decimals)
}

#[derive(Accounts)]
pub struct DoXfer<'info> {
    #[account(mut)]
    pub from: InterfaceAccount<'info, TokenAccount>,
    #[account(mut)]
    pub to: InterfaceAccount<'info, TokenAccount>,
    pub mint: InterfaceAccount<'info, anchor_spl::token_interface::Mint>,
    pub authority: Signer<'info>,
    pub token_program: Interface<'info, TokenInterface>,
}

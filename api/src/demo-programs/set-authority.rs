// Anchor demo: token::set_authority — change the owner of a token
// account from one signer to another. Anchor and Anvil must produce
// byte-identical post-state on the token account. Pinocchio has no
// pinocchio_token::set_authority helper, so the emit hand-rolls the
// raw CPI against the SPL Token program ID — this fixture is the
// runtime gate on that hand-rolled path.
use anchor_lang::prelude::*;
use anchor_spl::token::{self, SetAuthority, Token, TokenAccount};
// AuthorityType is referenced inline by qualified path so the import
// doesn't leak through to non-Anchor targets that lack spl_token.

declare_id!("2Q4rAEjnfX9saZXrMieuKR49ozRVQiuJtamC7d8WFpGE");

#[program]
pub mod set_authority_demo {
    use super::*;

    pub fn change_owner(ctx: Context<ChangeOwner>, new_owner: Pubkey) -> Result<()> {
        token::set_authority(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                SetAuthority {
                    account_or_mint: ctx.accounts.token_account.to_account_info(),
                    current_authority: ctx.accounts.current_owner.to_account_info(),
                },
            ),
            spl_token::instruction::AuthorityType::AccountOwner,
            Some(new_owner),
        )?;
        Ok(())
    }
}

#[derive(Accounts)]
pub struct ChangeOwner<'info> {
    #[account(mut)]
    pub token_account: Account<'info, TokenAccount>,
    pub current_owner: Signer<'info>,
    pub token_program: Program<'info, Token>,
}

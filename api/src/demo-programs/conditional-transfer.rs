use anchor_lang::prelude::*;
use anchor_lang::system_program;

declare_id!("WNsPBjkFcra8ypL4C5Wke76c2aAaxqsfYnKiXoXLiRo");

#[program]
pub mod conditional_transfer {
    use super::*;

    // Squads' realloc_if_needed shape, minus the realloc: a Type-associated
    // method that CONDITIONALLY moves lamports (`if <cond> { system_program::
    // transfer(…) }`). Exercises both impl-method inlining (#18) and the #13
    // conditional-CPI emit: the transfer must run iff the vault is underfunded.
    pub fn top_up(ctx: Context<TopUp>, target: u64) -> Result<()> {
        Vault::top_up_if_needed(
            ctx.accounts.vault.to_account_info(),
            target,
            ctx.accounts.payer.to_account_info(),
            ctx.accounts.sys_prog.to_account_info(),
        )?;
        Ok(())
    }
}

#[derive(Accounts)]
pub struct TopUp<'info> {
    /// CHECK: lamport-only top-up target; balance compared byte-equal.
    #[account(mut)]
    pub vault: UncheckedAccount<'info>,
    #[account(mut)]
    pub payer: Signer<'info>,
    pub sys_prog: Program<'info, System>,
}

#[account]
pub struct Vault {
    pub data: u64,
}

impl Vault {
    fn top_up_if_needed<'info>(
        account: AccountInfo<'info>,
        target: u64,
        rent_payer: AccountInfo<'info>,
        sys_prog: AccountInfo<'info>,
    ) -> Result<()> {
        let current = account.lamports();
        if current < target {
            let delta = target - current;
            system_program::transfer(
                CpiContext::new(
                    sys_prog,
                    system_program::Transfer {
                        from: rent_payer,
                        to: account.clone(),
                    },
                ),
                delta,
            )?;
        }
        Ok(())
    }
}

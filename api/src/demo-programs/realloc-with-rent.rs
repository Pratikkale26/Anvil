use anchor_lang::prelude::*;
use anchor_lang::system_program;

declare_id!("CQXay9KL7pihVii9Jub9J3zYR9j2aUNHdnNKjy5tbsqp");

#[program]
pub mod realloc_with_rent {
    use super::*;

    pub fn grow(ctx: Context<Grow>, extra: u64) -> Result<()> {
        Vault::realloc_if_needed(
            &ctx.accounts.blob.to_account_info(),
            extra as usize,
            &ctx.accounts.payer.to_account_info(),
            &ctx.accounts.system_program.to_account_info(),
        )?;
        Ok(())
    }
}

#[derive(Accounts)]
pub struct Grow<'info> {
    /// CHECK: program-owned blob, resized in place
    #[account(mut)]
    pub blob: AccountInfo<'info>,
    #[account(mut)]
    pub payer: Signer<'info>,
    pub system_program: Program<'info, System>,
}

pub struct Vault;

impl Vault {
    pub fn realloc_if_needed<'info>(
        account: &AccountInfo<'info>,
        extra: usize,
        rent_payer: &AccountInfo<'info>,
        sys_prog: &AccountInfo<'info>,
    ) -> Result<()> {
        let new_size = account.data_len() + extra;
        let rent = Rent::get()?;
        let new_minimum = rent.minimum_balance(new_size);
        let delta = new_minimum.saturating_sub(account.lamports());
        if delta > 0 {
            system_program::transfer(
                CpiContext::new(
                    sys_prog.clone(),
                    system_program::Transfer {
                        from: rent_payer.clone(),
                        to: account.clone(),
                    },
                ),
                delta,
            )?;
        }
        account.realloc(new_size, false)?;
        Ok(())
    }
}

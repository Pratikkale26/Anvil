// Demo: exercises the `cpi_custom` BodyStatement kind via bare invoke().
// The detector dispatches `extractCustomCpi` only on bare `invoke` /
// `invoke_signed` (not the fully-qualified solana_program::program::*
// form); modern Anchor sources commonly `use anchor_lang::solana_program::
// program::{invoke, invoke_signed}` and call bare. M3 coverage fixture.
//
// cpi_custom by definition emits a parser warning (cpi_custom_emitted) and
// a `// ⚠️ Anvil: CPI to external program ... — manual rebuild required`
// stub in the emit. The fixture's job here is to ensure that stub flow
// stays alive and the parser produces the kind at all.
use anchor_lang::prelude::*;
use anchor_lang::solana_program::program::invoke;
use anchor_lang::solana_program::system_instruction;

declare_id!("CpiCustom111111111111111111111111111111111");

#[program]
pub mod cpi_custom {
    use super::*;

    pub fn raw_transfer(ctx: Context<RawTransfer>, amount: u64) -> Result<()> {
        let ix = system_instruction::transfer(
            ctx.accounts.from.key,
            ctx.accounts.to.key,
            amount,
        );
        invoke(
            &ix,
            &[
                ctx.accounts.from.to_account_info(),
                ctx.accounts.to.to_account_info(),
                ctx.accounts.system_program.to_account_info(),
            ],
        )?;
        Ok(())
    }
}

#[derive(Accounts)]
pub struct RawTransfer<'info> {
    #[account(mut, signer)]
    pub from: AccountInfo<'info>,
    #[account(mut)]
    pub to: AccountInfo<'info>,
    pub system_program: Program<'info, System>,
}

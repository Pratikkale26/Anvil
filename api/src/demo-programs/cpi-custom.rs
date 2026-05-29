// Demo: exercises the `cpi_custom` BodyStatement kind via a bare invoke()
// of an ARBITRARY external program's instruction. No typed IR kind can
// represent an unknown program's instruction, so the emit must fall back to
// the review-required stub (// ⚠️ Anvil + unimplemented!()).
//
// NOTE: a bare invoke() of `system_instruction::transfer` is no longer a
// valid cpi_custom example — as of #20 the inline AND let-bound forms fold
// into the typed cpi_system_transfer kind (byte-equal verified). A
// hand-built Instruction to an arbitrary program is the canonical case the
// emitter genuinely cannot translate, so it stays cpi_custom.
//
// cpi_custom by definition emits a parser warning (cpi_custom_emitted) and
// the stub in the emit. The fixture's job is to keep that stub flow alive
// and ensure the parser produces the kind at all. M3 coverage fixture.
use anchor_lang::prelude::*;
use anchor_lang::solana_program::program::invoke;
use anchor_lang::solana_program::instruction::{Instruction, AccountMeta};

declare_id!("CpiCustom111111111111111111111111111111111");

#[program]
pub mod cpi_custom {
    use super::*;

    pub fn raw_cpi(ctx: Context<RawCpi>, amount: u64) -> Result<()> {
        let ix = Instruction {
            program_id: *ctx.accounts.target_program.key,
            accounts: vec![
                AccountMeta::new(*ctx.accounts.from.key, true),
                AccountMeta::new(*ctx.accounts.to.key, false),
            ],
            data: amount.to_le_bytes().to_vec(),
        };
        invoke(
            &ix,
            &[
                ctx.accounts.from.to_account_info(),
                ctx.accounts.to.to_account_info(),
            ],
        )?;
        Ok(())
    }
}

#[derive(Accounts)]
pub struct RawCpi<'info> {
    #[account(mut, signer)]
    pub from: AccountInfo<'info>,
    #[account(mut)]
    pub to: AccountInfo<'info>,
    /// CHECK: arbitrary target program invoked via a raw, hand-built instruction
    pub target_program: AccountInfo<'info>,
}

// Demo: the #5 cpi_custom GOLD-STANDARD gate (paired with the committed
// counter_callee.so fixture). `bump_counter` invokes an ARBITRARY external
// program via a hand-built `Instruction` + `invoke_signed`, with a PDA
// authority that signs the CPI ONLY through invoke_signed — never as a tx
// signer. The callee enforces signer + owner + data-length, so the
// account-meta order, the signer seeds, and the instruction data are each
// LOAD-BEARING: a wrong cpi_custom emit (dropped signer seed, swapped metas,
// truncated data) diverges at runtime instead of silently "working".
//
// A hand-built `Instruction` to an arbitrary `program_id` is the canonical
// case the emitter genuinely cannot type (post-#20 the system_program raw
// invokes fold into typed kinds; this one does not). Anvil therefore emits
// the review-required stub (`// ⚠️ Anvil` + `unimplemented!("Anvil: cpi_custom`)
// today; the byte-equal differential built around this program is gated until
// #5 lands a real generic-invoke emit. See cpi-custom-goldstandard differential.
use anchor_lang::prelude::*;
use anchor_lang::solana_program::program::invoke_signed;
use anchor_lang::solana_program::instruction::{Instruction, AccountMeta};

declare_id!("Counterca11er111111111111111111111111111111");

#[program]
pub mod cpi_counter_caller {
    use super::*;

    pub fn bump_counter(ctx: Context<BumpCounter>, amount: u64) -> Result<()> {
        let ix = Instruction {
            program_id: *ctx.accounts.callee_program.key,
            accounts: vec![
                AccountMeta::new(*ctx.accounts.counter.key, false),
                AccountMeta::new_readonly(*ctx.accounts.authority.key, true),
            ],
            data: amount.to_le_bytes().to_vec(),
        };
        invoke_signed(
            &ix,
            &[
                ctx.accounts.counter.to_account_info(),
                ctx.accounts.authority.to_account_info(),
            ],
            &[&[b"authority", &[ctx.bumps.authority]]],
        )?;
        Ok(())
    }
}

#[derive(Accounts)]
pub struct BumpCounter<'info> {
    /// CHECK: raw counter account, owned by the callee program; mutated by the CPI
    #[account(mut)]
    pub counter: AccountInfo<'info>,
    /// CHECK: PDA authority; signs the CPI via invoke_signed only (never a tx signer)
    #[account(seeds = [b"authority"], bump)]
    pub authority: AccountInfo<'info>,
    /// CHECK: arbitrary target program invoked via a raw, hand-built instruction
    pub callee_program: AccountInfo<'info>,
}

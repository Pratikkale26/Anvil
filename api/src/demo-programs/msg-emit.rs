// Minimal program for the compareMsgLogs fixture.
//
// Three instructions covering the supported msg!() shapes:
//   - say_hello / say_status: pure string literals (always byte-equal)
//   - say_formatted: formatted args (M7 8c — Anvil expands via the
//     stack-allocated u64_to_ascii / pubkey_to_base58 helpers in
//     m7-helpers.ts, byte-equal to Anchor's runtime format!() for
//     u64 + Pubkey arg types)

use anchor_lang::prelude::*;

declare_id!("MsgEmit111111111111111111111111111111111111");

#[program]
pub mod msg_emit {
    use super::*;

    pub fn say_hello(_ctx: Context<NoAccounts>) -> Result<()> {
        msg!("hello world");
        msg!("second line");
        Ok(())
    }

    pub fn say_status(_ctx: Context<NoAccounts>, ok: bool) -> Result<()> {
        if ok {
            msg!("status: ok");
        } else {
            msg!("status: bad");
        }
        msg!("done");
        Ok(())
    }

    pub fn say_formatted(_ctx: Context<NoAccounts>, amount: u64, target: Pubkey) -> Result<()> {
        // Both args are instruction args with primitive types — Anvil's
        // strict-mode lookup resolves them, so M7 8c's format expansion
        // fires. Output should byte-equal Anchor's `format!()` runtime.
        msg!("amount: {} target: {}", amount, target);
        msg!("count: {}", amount);
        Ok(())
    }
}

#[derive(Accounts)]
pub struct NoAccounts {}

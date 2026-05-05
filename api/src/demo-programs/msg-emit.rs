// Minimal program for the compareMsgLogs fixture.
//
// Two instructions, each emitting two `msg!()` lines using PURE STRING
// LITERALS (no format args). Goal: prove that Anvil's emit produces
// byte-identical user-emitted log text to Anchor's reference for the
// supported subset of msg!() shapes.
//
// Why no `msg!("fmt {}", arg)` here: Pinocchio's `sol_log` has no format
// support. Anvil's emitter intentionally collapses formatted msg!() to
// sol_log of the format string only (args dropped) — see
// pinocchio-emitter.ts:emitMsg. A format-args fixture would byte-diverge
// by design, which would be a misleading test failure (it'd be testing
// the documented-limitation, not the surface). When formatted msg!()
// emit lands (likely via a hand-rolled format helper), add a separate
// fixture to lock that in.

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
}

#[derive(Accounts)]
pub struct NoAccounts {}

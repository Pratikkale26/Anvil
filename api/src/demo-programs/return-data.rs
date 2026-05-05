// Minimal program for the compareReturnData fixture.
//
// One instruction calling set_return_data() explicitly with a fixed byte
// payload. Goal: prove that Anvil's emit produces byte-identical
// set_return_data output to Anchor's reference, so callers reading via
// get_return_data observe the same bytes on either runtime.
//
// Why explicit set_return_data instead of `Result<T>` for non-unit T:
// Anchor's macro-expansion for `Result<T>` returns calls set_return_data
// with a borsh-encoded T. The borsh layout is well-defined but the macro
// machinery is more code surface than we need to prove the surface
// works end-to-end. Explicit set_return_data is the simpler, more
// direct test.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::program::set_return_data;

declare_id!("Retdata111111111111111111111111111111111111");

#[program]
pub mod return_data {
    use super::*;

    pub fn echo(_ctx: Context<NoAccounts>) -> Result<()> {
        // 8 bytes of fixed pattern. Real programs would set this from a
        // computed value; the fixture only needs determinism.
        let payload: [u8; 8] = [0xDE, 0xAD, 0xBE, 0xEF, 0xCA, 0xFE, 0xBA, 0xBE];
        set_return_data(&payload);
        Ok(())
    }
}

#[derive(Accounts)]
pub struct NoAccounts {}

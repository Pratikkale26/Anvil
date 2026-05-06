//! Regex-pattern fixture: Token-2022 extension commentout.
//!
//! Locks the behavior of `commentOutT22ExtensionCallSites` in
//! pinocchio-emitter.ts. The regex matches `\.data\.borrow()` calls and
//! `StateWithExtensions` references in pass-through statements; both
//! mark the enclosing statement for commentout because pinocchio has no
//! spl_token_2022 dep and cannot link the extension surface.
//!
//! Pinocchio-only fixture — Native target auto-imports those types via
//! filteredSourceImports (commit 5c9a097), so it would NOT fire the
//! commentout pass and the snapshot would be testing a different
//! pattern. Native is filtered out in binary-parity-snapshot.test.ts.
use anchor_lang::prelude::*;

declare_id!("T22Pat1111111111111111111111111111111111111");

#[program]
pub mod t22_extension_pattern {
    use super::*;

    pub fn read_extension(ctx: Context<ReadExtension>) -> Result<()> {
        let mint_data = ctx.accounts.mint.data.borrow();
        msg!("mint data len: {}", mint_data.len());
        Ok(())
    }
}

#[derive(Accounts)]
pub struct ReadExtension<'info> {
    /// CHECK: raw account read for extension probe
    pub mint: AccountInfo<'info>,
}

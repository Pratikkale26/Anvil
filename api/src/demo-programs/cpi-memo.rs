// Demo: exercises the `cpi_memo` BodyStatement kind via spl_memo::build_memo.
// The memo program is well-known (MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr)
// and trivially-deployable in test environments. M3 coverage fixture.
//
// Note: full byte-equal differential gate would require deploying the SPL
// memo program into LiteSVM and comparing logs. The M3 fixture covers
// parser-level kind production today; full byte-equal is the H2-followup
// pattern (see deferred task #35-equivalent for memo).
use anchor_lang::prelude::*;
use anchor_spl::memo::{self, BuildMemo, Memo};

declare_id!("CpiMemo111111111111111111111111111111111111");

#[program]
pub mod cpi_memo {
    use super::*;

    pub fn write_memo(ctx: Context<WriteMemo>, data: Vec<u8>) -> Result<()> {
        let cpi_ctx = CpiContext::new(
            ctx.accounts.memo_program.to_account_info(),
            BuildMemo {},
        );
        memo::build_memo(cpi_ctx, &data)?;
        Ok(())
    }
}

#[derive(Accounts)]
pub struct WriteMemo<'info> {
    pub authority: Signer<'info>,
    pub memo_program: Program<'info, Memo>,
}

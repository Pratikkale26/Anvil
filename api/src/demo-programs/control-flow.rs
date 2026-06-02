use anchor_lang::prelude::*;

declare_id!("G7YktF9wccZku7o1JDcKCa6CxWYGGuP7cBUni7utHx86");

// #4 — real control-flow in an instruction body, exercised end-to-end:
//   - a `for` loop whose count comes from an arg (accumulates into state),
//   - a `match` dispatched on an arg, with each arm + a `_ => Err` arm.
// The byte-equal differential (differential-control-flow.test.ts) varies the
// control-flow-determining args (loop N=5 and N=0; match arm 0/1/Err) so the
// gate actually exercises branch + iteration semantics, not one happy path.
#[program]
pub mod control_flow {
    use super::*;

    pub fn run(ctx: Context<Run>, n: u64, action: u8) -> Result<()> {
        for _ in 0..n {
            ctx.accounts.state.counter += 1;
        }
        match action {
            0 => {
                ctx.accounts.state.mode = 10;
            }
            1 => {
                ctx.accounts.state.mode = 20;
            }
            _ => {
                return Err(CfError::BadAction.into());
            }
        }
        Ok(())
    }
}

#[derive(Accounts)]
pub struct Run<'info> {
    #[account(mut)]
    pub state: Account<'info, CfState>,
}

#[account]
pub struct CfState {
    pub counter: u64,
    pub mode: u64,
}

#[error_code]
pub enum CfError {
    #[msg("bad action")]
    BadAction,
}

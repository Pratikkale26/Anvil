// Demo: exercises the legacy `pyth_sdk_solana` oracle read pattern.
// The parser should collapse:
//   let price_feed = load_price_feed_from_account_info(&ctx.accounts.pyth_price)?;
//   let current_price = price_feed
//       .get_price_no_older_than(&Clock::get()?, MAX_AGE)
//       .ok_or(ErrorCode::StalePrice)?;
// into ONE `cpi_pyth_read_price_legacy` IR statement.
//
// On a target without pyth_sdk_solana available (Pinocchio), the emit
// hand-rolls the PriceFeed deserialization + age check against the
// documented account layout, binding `current_price` to a struct with
// fields `{ price, conf, exponent, publish_time }`.
//
// This fixture also locks the lint-table downgrade: pre-M2a,
// `pyth_sdk_solana` was an unconditional blocker; post-M2a it's
// reviewable when every Pyth call is IR-classified.
use anchor_lang::prelude::*;
use pyth_sdk_solana::load_price_feed_from_account_info;

declare_id!("PythRead11111111111111111111111111111111111");

const MAX_AGE: u64 = 60;

#[program]
pub mod pyth_read_legacy {
    use super::*;

    pub fn read_price(ctx: Context<ReadPrice>) -> Result<()> {
        let price_feed = load_price_feed_from_account_info(&ctx.accounts.pyth_price)?;
        let current_price = price_feed
            .get_price_no_older_than(&Clock::get()?, MAX_AGE)
            .ok_or(ErrorCode::StalePrice)?;
        msg!("price={}, exponent={}", current_price.price, current_price.exponent);
        Ok(())
    }
}

#[derive(Accounts)]
pub struct ReadPrice<'info> {
    pub pyth_price: AccountInfo<'info>,
}

#[error_code]
pub enum ErrorCode {
    #[msg("Pyth price is stale.")]
    StalePrice,
}

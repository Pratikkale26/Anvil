//! Switchboard On-Demand PullFeed reader demo.
//!
//! Mirrors the Pyth M2a legacy reader pattern. Anvil parses the
//! `PullFeedAccountData::parse(...)` + `.value()` two-line idiom into a
//! single `cpi_switchboard_read_feed` IR statement, then hand-rolls the
//! byte deserialization at emit time so neither target needs the
//! `switchboard-on-demand` crate dep.
//!
//! Byte-equal differential gate is deferred until a switchboard-on-
//! demand `.so` fixture lands (see docs/plan-switchboard.md). Until
//! then, cargo-build green is the available correctness signal.

use anchor_lang::prelude::*;
use switchboard_on_demand::accounts::PullFeedAccountData;

declare_id!("Sb11111111111111111111111111111111111111111");

#[program]
pub mod switchboard_read {
    use super::*;

    /// Reads the latest f64 value from a Switchboard On-Demand PullFeed.
    /// Errors with `MyError::StalePrice` when the feed has no
    /// publication yet (slot=0).
    pub fn read_price(ctx: Context<ReadFeed>) -> Result<()> {
        let feed = PullFeedAccountData::parse(&ctx.accounts.feed.data.borrow())?;
        let price = feed.value().ok_or(MyError::StalePrice)?;
        msg!("price (f64): {}", price);
        Ok(())
    }

    /// Same shape but gates on max-staleness slots.
    pub fn read_with_max_staleness(ctx: Context<ReadFeed>) -> Result<()> {
        let feed = PullFeedAccountData::parse(&ctx.accounts.feed.data.borrow())?;
        let price = feed
            .value_with_max_staleness(100)
            .ok_or(MyError::StalePrice)?;
        msg!("price (f64): {}", price);
        Ok(())
    }
}

#[derive(Accounts)]
pub struct ReadFeed<'info> {
    pub feed: AccountInfo<'info>,
}

#[error_code]
pub enum MyError {
    #[msg("Switchboard feed has no published value yet (slot=0).")]
    StalePrice,
}

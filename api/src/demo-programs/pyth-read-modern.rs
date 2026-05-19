// Demo: exercises the modern Pyth oracle read pattern via the
// pyth-solana-receiver-sdk crate (PriceUpdateV2 account format).
// Distinguished from the legacy `pyth_sdk_solana` pattern by:
//   - typed `Account<'info, PriceUpdateV2>` (legacy was `AccountInfo`)
//   - 3-arg `get_price_no_older_than(&clock, max_age, &feed_id)`
//     (legacy was 2-arg + .ok_or)
//   - feed_id sourced via `get_feed_id_from_hex` at runtime
//
// Anvil's emit:
//   - Native: re-emits the receiver-sdk call chain; crate auto-injected.
//   - Pinocchio: hand-rolls PriceUpdateV2 bytes (32B feed_id +
//     i64+u64+i32+i64) after dynamic verification_level offset
//     computation. Embedded feed_id is cross-checked against the
//     user-supplied feed_id — fails loud if a client passes the wrong
//     feed account (common DeFi attack vector).
//
// This is the Pyth Receiver path that the local solana-test-validator
// has cloned (program ID rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ),
// so it's the first Pyth IR kind with end-to-end differential infra
// on the bench. Differential gate lands in a future M2c session once
// the seed-PriceUpdateV2-account helper is built.
use anchor_lang::prelude::*;
use pyth_solana_receiver_sdk::price_update::{get_feed_id_from_hex, PriceUpdateV2};

declare_id!("PythRead22222222222222222222222222222222222");

const MAX_AGE: u64 = 60;

#[program]
pub mod pyth_read_modern {
    use super::*;

    pub fn read_price(ctx: Context<ReadPrice>) -> Result<()> {
        // Inline hex literal — the parser detects this and emits a
        // [u8; 32] byte-array literal at compile time, dropping the
        // pyth-solana-receiver-sdk dep. A const-string indirection
        // (e.g. `get_feed_id_from_hex(SOL_USD_FEED_ID)`) survives as
        // pass_through; future N5c could resolve constants too.
        let feed_id: [u8; 32] = get_feed_id_from_hex("0xef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d")?;
        let price = ctx.accounts.price_update
            .get_price_no_older_than(&Clock::get()?, MAX_AGE, &feed_id)?;
        msg!("price={}, exponent={}", price.price, price.exponent);
        Ok(())
    }
}

#[derive(Accounts)]
pub struct ReadPrice<'info> {
    pub price_update: Account<'info, PriceUpdateV2>,
}

# Switchboard On-Demand reader — implementation plan

**Status:** Plan + initial IR kind shipped. Byte-equal differential gate
deferred until a switchboard-on-demand `.so` fixture lands.

**Scope:** 1 IR kind covering the `PullFeed` account read pattern that
Switchboard On-Demand programs use. Mirrors the Pyth M2 arc shape
(legacy + modern reader, byte-equal vs the Pyth Receiver `.so`).

## Source pattern Anvil needs to handle

Anchor programs reading a Switchboard On-Demand feed look like:

```rust
use switchboard_on_demand::accounts::PullFeedAccountData;

#[derive(Accounts)]
pub struct ReadFeed<'info> {
    pub feed: AccountInfo<'info>,
    // ...
}

pub fn read_feed(ctx: Context<ReadFeed>) -> Result<()> {
    let feed_data = ctx.accounts.feed.try_borrow_data()?;
    let feed = PullFeedAccountData::parse(feed_data)?;
    let price: f64 = feed.value().ok_or(MyError::StalePrice)?;
    msg!("price: {}", price);
    Ok(())
}
```

The `feed.value()` call returns the most recent value as `Option<f64>`.
Switchboard On-Demand feeds carry a result struct with `result.value`,
`result.range`, `result.std_dev`, `result.mean`, and `result.last_update_slot`.

## IR design

New IR kind `cpi_switchboard_read_feed`:

```ts
{
  kind: z.literal("cpi_switchboard_read_feed"),
  feedAccount: z.string(),       // ctx.accounts.<feed>
  resultLocal: z.string(),       // local var name for the f64 result
  /** Optional maxStalenessSecs from .value_with_max_staleness(slots) shape. */
  maxStalenessSlots: z.string().optional(),
}
```

## Parser detection

In `cpi-detector.ts`, add a branch that matches:
- `PullFeedAccountData::parse(<feed_account>.<data-borrow>)?`
- Followed by `.value()` or `.value_with_max_staleness(N)` access.

Two-line idiom (mirror of Pyth M2a):
```
let feed_data = ctx.accounts.feed.try_borrow_data()?;
let feed = PullFeedAccountData::parse(feed_data)?;
let price = feed.value().ok_or(...)?;
```

## Emit

**Both targets**: hand-roll byte deserialization from the PullFeed account
layout (drops the switchboard-on-demand crate dep, same approach as the
Pyth M2 reader). The `PullFeedAccountData` byte layout is publicly
documented in the switchboard-on-demand-rust crate's `accounts/pull_feed.rs`.

Key offsets (verify against current Switchboard source before shipping):
- 8 bytes — Anchor discriminator
- 32 bytes — submitter
- 32 bytes — queue
- 8 bytes — value (i128 scaled by precision)
- 8 bytes — min_response_value
- 8 bytes — max_response_value
- 8 bytes — value_with_max_staleness_slots
- ... (more)

The emit reads the `value` field as `i128` then converts to `f64` via
the documented precision scale (PRECISION = 18 decimal places →
`value as f64 / 10_f64.powi(18)`).

## Test plan

1. **`parser-switchboard-read.test.ts`** — verify the IR kind is
   detected on the two-line idiom.
2. **`emitter-switchboard-byte-offsets.test.ts`** — independently re-
   implement the Pinocchio emit's offset reads in TS and verify
   against synthetic PullFeed buffers.
3. **`differential-switchboard.test.ts`** — byte-equal vs the bundled
   `switchboard_on_demand.so` fixture. Blocked until the fixture is
   acquired + scenario harness wired (LiteSVM `addProgram` + crank
   simulation).

## Effort estimate

- IR + parser + Pinocchio emit + Native emit + unit tests: ~1 day
- Byte-offset regression test: ~half day
- Demo Anchor program (cargo-build green): ~half day
- Byte-equal differential fixture: blocked on .so + scenario; +1 day once unblocked

Total: 3 days for parser+emit+cargo-verify; 4 days for full byte-equal.

## Out of scope

- Switchboard "Legacy" (pre-On-Demand) feeds — V2 only.
- Switchboard randomness (VRF) — separate IR kind, separate arc.
- Multi-feed batch reads — single-feed only in v1.

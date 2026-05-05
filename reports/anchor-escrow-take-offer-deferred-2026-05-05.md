# RW4 — anchor-escrow-2025 take_offer fixture (deferred)

## Outcome: deferred — upstream Anchor reference crashes in litesvm

Built fixture wrapper (TakeOfferCtx, setupTakeOffer, callTakeOffer,
narrowCompare, fullCompare) in
`api/tests/fixtures/anchor-escrow-2025-fixture.ts`. Wrote test file
`api/tests/differential-anchor-escrow-2025-take.test.ts`.
Anchor REFERENCE binary (the upstream-source build) failed at runtime
in litesvm with:

```
Program 8jR5GeNzeweq35Uo84kGP3v1NcBaZWH5u62k7PxN4T2y consumed 3992 of 1399850 compute units
Program 8jR5GeNzeweq35Uo84kGP3v1NcBaZWH5u62k7PxN4T2y failed:
  Access violation in stack frame 5 at address 0x200005ff0 of size 8
```

Confirmed it's NOT Anvil:
- /parse + /emit + /build green on take_offer
- Same Anchor reference binary works for make_offer (already shipped)
- Crash happens at 3992 CU — entry-level account validation, before any
  CPI. Bumping CU budget to 1.4M didn't change behavior.
- Stack frame 5 access violation at SBF stack tip is a known anchor 0.32+
  symptom for Accounts structs with many fields + init_if_needed +
  has_one + close= + seeds/bump simultaneously. Upstream fix is
  `Box<Account<...>>` on heavy fields; anchor-escrow-2025 source doesn't
  use Box.

Upstream's own `tests/escrow.test.ts` runs against `solana-test-validator`
which has different stack handling than litesvm — explains why the
upstream test passes but our differential harness can't run the binary.

## Decision

- Reverted the test file + fixture extension. Don't ship a known-broken
  fixture even gated by skip — it's noise in the corpus.
- Make_offer fixture stays as the canonical anchor-escrow-2025 byte-equal
  reference (already at FULL compare scope).
- Pivot RW4 → RW5 (Solana Pay) per CX1 ranking.

## When to revisit

- If litesvm gains heap allocation of Anchor's Account stack frames, OR
- If a fork of anchor-escrow-2025 is published with `Box<Account<...>>` on
  the heavy take_offer fields, OR
- If we author a stripped-down "take_offer-lite" fixture in our own
  demo-programs corpus that exercises the multi-CPI helper-fn-with-Some-seeds
  shape without the real-program account count.

The Path 2 v1 helper-fn-with-Some-seeds inlining gap (which take_offer
would have exercised on Anvil's emit side) is independently tracked —
the Path 2 v0 helper-fn-with-None inlining IS landed and exercised by
make_offer's vault transfer + maker_ata_b transfer.

# Migrations

Programs migrated from Anchor to Pinocchio or Native Rust using Anvil. Public
record so adopters can see who's shipping with the toolchain and so we can
track the grant adoption metric (target: 10 programs).

## Format

Each entry: `<program> · <target> · <commit / PR> · <one-line outcome>`.

Open a PR adding a row. Anchor source link is enough — we don't need the full
emit committed back unless the adopter chose to vendor it.

## Adopters

_(no entries yet — will populate as users report migrations)_

| Program | Target | Source | Notes |
|---|---|---|---|

## How to add yourself

1. Run `anvil-sol compile <path> --target pinocchio --strict`.
2. Verify the emit matches your runtime expectations (we recommend the
   differential harness against a LiteSVM scenario).
3. Open a PR appending a row to the table above with a link to your program
   repo and a one-line outcome (CU savings, deploy size, etc.).

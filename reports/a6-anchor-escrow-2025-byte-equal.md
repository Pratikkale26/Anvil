# A6 — first real-world Anchor program byte-equal verified

**Date:** 2026-05-05
**Program:** [`mikemaccana/anchor-escrow-2025`](https://github.com/mikemaccana/anchor-escrow-2025)
**Status:** `make_offer` init flow passes byte-equal on the offer PDA. Two related divergences tracked separately.

## What this proves

For the first time, Anvil's emit produces **byte-identical state** to the Anchor reference for an instruction in a real, public, mainnet-shaped Anchor 0.31 program — not a hand-written demo. The fixture compiles the upstream crate verbatim via `cargo-build-sbf`, builds the Anvil-emitted `.so` via the same toolchain, runs the same `make_offer(id, token_a_offered_amount, token_b_wanted_amount)` instruction in two LiteSVM scenarios with shared keypairs, and asserts the offer PDA's data + lamports + owner are equal byte-for-byte after the call returns.

The `Offer` struct that ships with anchor-escrow-2025:

```rust
#[account]
pub struct Offer {
    pub id: u64,
    pub maker: Pubkey,
    pub token_mint_a: Pubkey,
    pub token_mint_b: Pubkey,
    pub token_b_wanted_amount: u64,
    pub bump: u8,
}
```

Anvil writes every field correctly. Same 113 bytes (8 disc + 105 struct) on both sides.

## What changed in the parser to make this work

`make_offer` writes the entire struct in one Anchor-idiomatic call:

```rust
context.accounts.offer.set_inner(Offer {
    id,
    maker: context.accounts.maker.key(),
    token_mint_a: context.accounts.token_mint_a.key(),
    token_mint_b: context.accounts.token_mint_b.key(),
    token_b_wanted_amount,
    bump: context.bumps.offer,
});
```

Pre-fix, the parser fell through to `pass_through`, emitting raw `ctx.accounts.offer.set_inner(...)` text in the IR body. On Pinocchio, the post-process step strips `ctx.accounts` references as Anchor-only — leaving no actual field-write in the emitted code. Cargo-build was green. The on-chain account stayed zero-initialized post-init. Differential testing surfaced this as a 113-byte all-zero `offer` PDA on the Anvil side vs the populated reference on the Anchor side.

The fix (`api/src/parser/body-classifier.ts:classifySetInner`) decomposes any `<X>.set_inner(<Type> { f1: v1, f2: v2, ... })` call into a sequence of `state_field_assign` IR statements, one per field. The emitter already knows how to render those correctly per target. Shorthand fields (`Foo { id }` ≡ `Foo { id: id }`) are handled. Base-update spreads (`Foo { x: 1, ..base }`) are explicitly refused because expanding without all fields visible would silently drop unmentioned ones; those fall through to `pass_through` with the existing classifier behavior.

Single source statement → multiple IR statements is a new shape. It rides on a new `extraStmts?: BodyStatement[]` field on `ClassifyResult` that the dispatcher pushes after the primary `stmt`. All emit paths work unchanged because they consume one IR statement at a time.

This unblocks any Anchor program using `set_inner` for state init — Squads v4, Streamflow, Marinade liquid-staking, jito-tip-distribution, mpl-bubblegum all use the pattern.

## What's NOT covered (yet)

Two related accounts in `make_offer` would also need to byte-equal for a "complete" verification of the instruction. Both surface separable emit gaps and were left out of this fixture's `accountsToCompare` deliberately:

### vault_ata — `init, associated_token::*` constraint emit gap

The vault is declared with:

```rust
#[account(
    init,
    payer = maker,
    associated_token::mint = token_mint_a,
    associated_token::authority = offer,
    associated_token::token_program = token_program
)]
pub vault: InterfaceAccount<'info, TokenAccount>,
```

Anchor reference: emits an Associated Token Program CPI to create the ATA at the canonical address (mint=token_mint_a, owner=offer). Anvil emit: doesn't currently generate the create-ATA CPI for the `init + associated_token::*` constraint combination. Result: `vault_ata` exists post-call on the Anchor side, doesn't exist on the Anvil side. Surfaced in the differential as `PRESENCE MISMATCH on 'vault_ata': anchor=true, anvil=false`.

This is a real emitter gap. The IR has `cpi_ata_create` as a body-statement kind, but it's only emitted when the source explicitly calls `anchor_spl::associated_token::create(...)`; the constraint-derived form (where Anchor's macro expands the create call inline) doesn't reach this code path. Fixing it requires recognizing the constraint shape on an `init`-bearing AccountRef and synthesizing a `cpi_ata_create` IR statement during parse / emit.

### maker_ata_a — user-helper inlining gap

`make_offer` calls a user helper from the upstream `shared.rs`:

```rust
transfer_tokens(
    &ctx.accounts.maker_token_account_a,
    &ctx.accounts.vault,
    &token_a_offered_amount,
    &ctx.accounts.token_mint_a,
    &ctx.accounts.maker.to_account_info(),
    &ctx.accounts.token_program,
    None,
)
.map_err(|_| ErrorCode::InsufficientMakerBalance)?;
```

`transfer_tokens` lives in a sibling module (`handlers/shared.rs`) and wraps `transfer_checked` from `anchor_spl::token_interface`. Anvil's classifier handles inline `transfer_checked(CpiContext::new(...), ...)` calls fine — but a user helper that wraps the call needs the From-trait / impl-method inlining pass to be applied to the helper itself. The current implementation doesn't inline arbitrary user helpers (only `From<&Accounts>` trait impls). Result: `transfer_tokens` is a `pass_through`, doesn't fire on Pinocchio, and the maker's token balance never gets debited.

Closing this gap is the same shape as `set_inner`: identify the user helper's body, inline the SPL CPI it wraps, classify at the call site. Heavier lift than `set_inner` because the helper signature varies; out of scope for A6.

## How to reproduce

```bash
cd api
bun test tests/differential-anchor-escrow-2025.test.ts
```

First run clones `https://github.com/mikemaccana/anchor-escrow-2025` to `/tmp/anchor-escrow-2025` (depth=1, blob-filtered). Reuses the clone on subsequent runs. Builds both `.so` files via `cargo-build-sbf` (~1m 30s cold; ~7s warm via Anvil's source-hash cache). Runs the `make_offer` scenario in two LiteSVM instances. Asserts the offer PDA byte-equals.

Toolchain requirements (same as all differential fixtures): `cargo-build-sbf` + `anchor` CLI on PATH; the harness skips loudly when either is missing.

## Implications for the byte-equal pitch

Before A6, "Anvil verifies your program byte-equal" was true for the 27-fixture corpus of hand-written demos. A6 lifts that to "Anvil verifies your program byte-equal — including real public Anchor programs you didn't write." The narrowing remains honest: `make_offer`'s offer-PDA byte-equality is verified; the ATA-init + helper-fn-inlining gaps are documented and tracked.

Next fixtures should be picked to exercise the gaps that A6 surfaced, not to repeat them: a program that does explicit `anchor_spl::associated_token::create(...)` (rather than constraint-derived ATA init) would byte-equal cleanly today, while one that relies on user helper wrappers around SPL CPIs would surface the same `transfer_tokens` blocker. The pattern is: **let real programs decide what to fix next**, not the other way around.

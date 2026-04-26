# Anvil Out-of-Corpus Coverage Probe — 2026-04-25

Goal: run Anvil's deterministic emitter against fresh Anchor programs that
**aren't** in its tracked corpus, and surface the patterns that break. No AI
refine. No fixes. Just signal.

## TL;DR

**0 / 5 programs produced a clean `cargo build`.** Every program parsed, every
program emitted output, every program then failed at compile time. The failures
cluster into 5 patterns; one of them — **test-module imports leaking into
`lib.rs`** — looks like a small, high-leverage fix that breaks 1-2 modern
real-world programs by itself.

The other patterns (`token_interface` / Token-2022 set-authority, impl-method
inlining, custom DEX CPIs like serum/phoenix, zero-copy) are previously known
unsupported features and matched the lint output.

---

## Programs tested

| ID                | Source                                                                                          | LOC (lib.rs) | Notes                                                            |
| ----------------- | ----------------------------------------------------------------------------------------------- | -----------: | ---------------------------------------------------------------- |
| `winternitz-vault`  | https://github.com/deanmlittle/solana-winternitz-vault                                          |           33 | **Pinocchio-native, not Anchor.** Parser correctly rejects.      |
| `escrow2025`        | https://github.com/mikemaccana/anchor-escrow-2025                                               |   36 + 414 in submodules | Modern Anchor escrow (`token_interface`, multi-handler, `solana-kite` tests) |
| `coral-escrow`      | https://github.com/coral-xyz/anchor (`tests/escrow/programs/escrow/src/lib.rs`)                  |          260 | `token_interface::transfer_checked` + helper-method CPI ctx      |
| `coral-swap`        | https://github.com/coral-xyz/anchor (`tests/swap/programs/swap/src/lib.rs`)                      |          496 | Serum DEX integration (`serum_dex` crate, `anchor_spl::dex`)     |
| `coral-multisig`    | https://github.com/coral-xyz/anchor (`tests/multisig/programs/multisig/src/lib.rs`)              |          280 | Classic Anchor multisig — instruction execution proxy            |
| `phoenix-mm`        | https://github.com/Ellipsis-Labs/phoenix-onchain-market-maker (`programs/phoenix-onchain-mm`)    |          637 | Phoenix DEX market-maker — zero-copy account loads, custom CPIs  |

Two of the originally suggested URLs 404'd (`deanmlittle/anchor-vault`,
`solana-developers/anchor-escrow-2025`, `Ellipsis-Labs/phoenix-onchain-mm`) and
were substituted with the closest matching live repo.

`winternitz-vault` is reported for completeness but doesn't count against
coverage — Anvil only claims to transpile Anchor inputs and the parser surfaces
a clean error message: `Parse failed: No Anchor #[program] module found`.

---

## Per-program results

| ID              | Parse | Emit | Pinocchio cargo | Native cargo | Top-3 rustc codes (pinocchio) | Top-3 rustc codes (native) |
| --------------- | :---: | :--: | :-------------: | :----------: | ----------------------------- | -------------------------- |
| escrow2025      | yes   | yes  | **fail** (67)   | **fail** (62) | `E0425`×22 · `E0412`×18 · `E0433`×10 | `E0425`×22 · `E0412`×18 · `E0433`×9 |
| coral-escrow    | yes   | yes  | **fail** (34)   | **fail** (19) | `E0425`×18 · `E0599`×6 · `E0433`×6   | `E0425`×9 · `E0599`×3 · `E0308`×3   |
| coral-swap      | yes   | yes  | **fail** (82)   | **fail** (73) | `E0433`×31 · `E0107`×17 · `E0261`×13 | `E0433`×31 · `E0261`×13 · `E0609`×8 |
| coral-multisig  | yes   | yes  | **fail** (10)   | **fail** (13) | `E0433`×2 · `E0277`×2 · `E0614`×1    | `E0599`×6 · `E0614`×1 · `E0433`×1   |
| phoenix-mm      | yes   | yes  | **fail** (30)   | **fail** (26) | `E0433`×13 · `E0412`×7 · `E0425`×6   | `E0433`×13 · `E0412`×7 · `E0422`×3  |
| winternitz      | n/a — parser refuses (program is not Anchor) |

Numbers in parentheses = total compile errors (incl. uncoded `error: expected
…` syntax errors). All ten cargo invocations exited non-zero.

The Anvil CLI itself exits 0 in every case — emit happens regardless of
downstream cargo health, which is consistent with the existing pipeline (cargo
is the accept-gate).

---

## Patterns that broke things — frequency-ranked

Counted as "1 hit" per program × target where the pattern was load-bearing for
at least one error.

### #1 — Unresolved external crates in CPI passthrough (5 programs / 10 builds)

`error[E0433]: failed to resolve: use of unresolved module or unlinked crate
'<x>'` — `serum_dex`, `phoenix`, `solana_program`, `token`, `solana_kite`,
`litesvm`, `solana_instruction`, `solana_keypair`, `solana_signer`,
`solana_pubkey`.

Two distinct root causes here, deserving to be split:

- **(1a) Custom-program CPI** (serum, phoenix). These are the documented gap
  for non-SPL/non-Metaplex/non-Pyth programs. Anvil carries the `use phoenix::`
  / `use serum_dex::` lines through verbatim and the target Cargo.toml has no
  such dep. **No surprise.**
- **(1b) Test-only imports leaking from `#[cfg(test)]` modules** (escrow2025).
  This is a clean bug. The `escrow2025` `lib.rs` declares a `#[cfg(test)] mod
  tests;`. The emitted Pinocchio `lib.rs` has these as top-level imports:
  ```rust
  use litesvm::LiteSVM;
  use solana_instruction::AccountMeta;
  use solana_keypair::Keypair;
  use solana_kite::{ … };
  ```
  These come from `tests.rs`, which is gated by `#[cfg(test)]` in the original
  source. The parser is walking into `cfg(test)` modules and the emitter is
  hoisting their imports. **Confirmed by `bun cli/anvil.ts parse … --json`**:
  the JSON output included a function whose body literally starts with
  `let mut test_environment = setup_escrow_test();` — i.e. the parser walked
  the test functions into the IR. **This single fix would meaningfully improve
  escrow2025's signal** (currently 67 errors, of which ~10 are direct
  unresolved-import errors and another set are downstream type-resolution
  failures that disappear once the imports do).

### #2 — Helper-method CPI context returning `CpiContext` (2 programs)

Triggered cleanly in `coral-escrow` (`into_transfer_to_taker_context()`,
`into_set_authority_context()`) and `coral-swap`
(`orderbook_from()`, `orderbook_to()`).

This is the **impl-inlining** gap that's already in `KNOWN GAPS` in MEMORY.md
and the lint accurately calls it out as a `BLOCKER`. The visible failure mode
in escrow is the worst kind: the consolidator sees `transfer_checked(ctx.accounts.into_xxx_context().with_signer(...), amount, mint.decimals)`,
can't resolve which `mint` field the helper would've referenced, and emits a
literal `/* TODO: mint */` placeholder inside an `AccountMeta::readonly(...)`
call:

```rust
pinocchio::instruction::AccountMeta::readonly(/* TODO: mint */.key()),
…
pinocchio::cpi::invoke(&__t22_ix, &[from, /* TODO: mint */, to, authority])?;
```

That's a syntax error (`error: expected expression, found '.'`) that wedges
parsing of the surrounding function. **Two of the four uncoded `error: …` lines
in `coral-escrow-pinocchio` come from this single placeholder.** The good
news: the placeholder format is grep-able and stable.

### #3 — `err!(ErrorCode::X)` macro emitted without parens (1 program)

`coral-multisig`, both targets:

```rust
return err!ErrorCode::InvalidThreshold;
```

The original source is `return err!(ErrorCode::InvalidThreshold);`. Notice the
opening paren of the `err!` call is missing in the emit, which makes rustc emit
`error: expected one of '(', '[', or '{', found 'ErrorCode'`. This affects 3
out of 4 uncoded errors in `coral-multisig-{native,pinocchio}`.

A `grep -rn "err!" /home/pk/Anvil/api/src --include='*.ts'` finds **zero**
literal rewrite for the `err!` macro, so the bug isn't an over-eager regex —
more likely the body-emitter walker (`api/src/emitter/body-emitter/walker.ts`)
is reconstructing the macro from the IR and dropping the parenthesized
`token_tree` argument because it doesn't recognize `err!` specifically. **Tiny
fix, high leverage** because anyone using `err!` with a positional
`ErrorCode::X` argument hits it on every emit.

### #4 — `'info` lifetime not introduced in helper signatures (1 program, heavy)

`coral-swap` produces 13 `error[E0261]: use of undeclared lifetime name 'info`,
all from helper functions copied verbatim. The original source declares them
inside `impl<'info>` blocks; once Anvil flattens the helper into a free
function it loses the `<'info>` generic on the signature.

This compounds with pattern #1 (the helpers also reference `serum_dex` types),
so even fixing the lifetime wouldn't make `coral-swap` build, but it's a
distinct emitter bug.

### #5 — Zero-copy account loads (1 program)

`phoenix-mm` uses `MarketHeader::load_mut` / `bytemuck` zero-copy patterns,
including `phoenix::program::CancelOrderParams` and `MarketHeader` types from
the upstream phoenix crate. The Anvil lint correctly identifies this as a
blocker (`#[account(zero_copy)] detected`) and matches MEMORY.md's documented
gap. The 30+ errors are largely downstream of `MarketHeader` / `phoenix::*`
being unresolvable on the target side.

---

## Surprises

**The escrow2025 test-import leak.** This is genuinely a bug. The code shape
"declare `#[cfg(test)] mod tests;` in lib.rs and put litesvm/solana-kite
imports inside" is the standard recommended pattern for new Anchor programs
(per the upstream Solana developer guidance referenced in `escrow2025`'s
README). Every modern Anchor program written in 2025-2026 likely follows this
convention, which means Anvil silently fails on a growing fraction of recent
real-world inputs that older corpus programs never exercised.

**`coral-multisig` lint says `READY 100/100` but cargo fails.** The lint scorer
gave the program a perfect score (zero blockers, zero reviews) and yet cargo
errored on 13 separate problems including the `err!ErrorCode` parse breakage.
The lint is doing pattern-match readiness and not actually compiling, which is
fair, but a 100/100 with 13 cargo errors suggests the readiness heuristics
don't yet recognize the `err!(…)` macro form, the `*Multisig` deref pattern, or
the `Pubkey::iter()` call-shape that `multisig.owners.iter()` resolves to.

**`coral-escrow` lint correctly flags the impl-inlining blocker.** The lint
output (`initialize_escrow() calls ctx.accounts methods: into … doesn't yet
inline them at the call site`) is the tightest description of the failure mode
anywhere in the codebase. Self-aware.

**Anvil never lies about parsing.** Parser exit 0 in every Anchor case; clean
non-Anchor refusal on the Pinocchio-native vault. No silent partial parses.

**Errors don't compound across targets.** Pinocchio and native fail on roughly
the same patterns with similar error counts (escrow2025: 67 vs 62; phoenix-mm:
30 vs 26). The two targets have *different* error codes for the same broken
pattern, but the *count* of broken sites is similar. This suggests the
emitter's deterministic transforms are fairly target-symmetric — the bugs
mostly live upstream in walker / parser / consolidator.

---

## Recommendations — highest leverage to fix next

If the goal is to break a new tier of real-world Anchor programs, in priority
order:

### #1 — Drop `#[cfg(test)]` modules during the import-extraction walk

**Effort: small (1-2 hr).** Single addition to walker.ts: skip any `mod X;` /
inline `mod X { … }` that has a `#[cfg(test)]` (or `#[cfg(any(test, …))]`)
attribute. The escrow2025 emit goes from 67 errors down by ~10 (the
`use solana_kite::…` / `use litesvm::…` family) and removes confusion about
which imports to scaffold dependencies for. **This is the highest-ROI fix
because it unblocks the most modern Anchor pattern with the least code.**

### #2 — Fix the `err!(ErrorCode::X)` paren-stripping regex

**Effort: tiny (30 min including a regression test).** Find the rewrite that
turns `err!(ErrorCode::X)` into `err!ErrorCode::X` (likely in walker.ts where
`err!()` is being collapsed) and add the parens back. Affects coral-multisig
specifically (-3 errors) but any program using the `return err!(MyErr::X)`
shape benefits. Bonus: add a test case to `realworld-cargo.test.ts`.

**Symmetry bonus.** Both #1 and #2 fixes live upstream of the target-specific
emit (in walker / parser), so they help **both** Pinocchio and Native targets
simultaneously — the data shows the two targets fail with similar error counts
on the same programs (escrow2025: 67 vs 62; phoenix-mm: 30 vs 26), so per
program they double their leverage.

### Honourable mentions (lower ROI for hackathon timeline)

- The `/* TODO: mint */` placeholder in the Token-2022 transfer_checked
  consolidator. Real fix needs impl-inlining which is documented as 6-10 hr;
  the band-aid would be: when the helper-derived AccountMeta site can't
  resolve, comment out the entire CPI block instead of emitting broken syntax.
  That at least gets the surrounding code to compile (and shows up as a clear
  "TODO" to the user) instead of a syntax error two lines deep.
- `'info` lifetime hoisting on flattened helper functions is a real bug but
  only `coral-swap` exercised it, and `coral-swap` is doomed anyway by Serum
  CPI absence. Defer.
- Zero-copy + custom-DEX CPI rewrites are documented post-grant work; no
  surprise here.

---

## Methodology notes (for reproducibility)

- Pipeline per program: `bun cli/anvil.ts compile <lib.rs> --target {pinocchio,native} --output /tmp/anvil-test/<id>-<target>` then `cd <out> && cargo build > <id>.full.log 2>&1`.
- Error code tally: `grep -oE 'error\[E[0-9]+\]' <log> | sort | uniq -c | sort -rn`.
- Logs preserved at `/tmp/anvil-test/*.full.log` (3973 lines total).
- Wall time: ~25 min including clones and three rounds of cargo (fresh deps
  download dominated). Per-program incremental cargo would be ~30 sec.
- No AI refine was invoked at any point; all numbers are deterministic-emitter
  ground truth.

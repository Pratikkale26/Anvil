# Squads v4 probe (RW3) — 2026-05-05

## Outcome: deferred

Cloned `Squads-Protocol/v4` to `/tmp/squads-v4` (~250 MB), probed via
local API. Parser succeeded (36 instructions). Emit produced 41 files
with 50 validation issues (15 errors, 35 warnings). Cargo build NOT
attempted (errors block).

## Why deferred

Squads v4 is a single-program monolith with 36 instructions sharing
one state.rs (286 LoC of nested impl methods + Anchor wrappers). A
narrow byte-equal fixture for `multisig_create_v2` requires the
entire state.rs + errors.rs + every shared seeds module to compile,
which they don't right now.

## Concrete blockers (frequency-ranked)

### Blocker 1 — Brace-imbalance in `*_accounts_close.rs` (3 files)
The Token-2022 extension commentout pass marks `let X = if cond.data.borrow().is_empty() { None } else { Some(Proposal::try_deserialize(...)) };` as a Token-2022 chain because of the `.data.borrow()` pattern. The emit comments PART of the if-else: the `let` line is commented, the `None` / `} else {` lines are not, the `Some(...)?)` re-matches and is commented, the `};` is not. Result: 4 unbalanced braces, file won't compile.

**Root cause:** `computeTopLevelStatementSpans` doesn't span-merge multi-line if-let-else expressions. The `commentOutT22Ranges` function comments via line-splitting which only produces well-formed Rust when the matched range is a complete top-level statement.

**Fix shape (out of scope for this fixture):** the T22 commentout statement-bound walker needs to either (a) refuse to match when the matched range starts mid-`let`-binding, or (b) extend the range to the closing `;` of the enclosing `let`.

### Blocker 2 — `Member::INIT_SPACE` undefined
Anchor's `#[derive(InitSpace)]` macro generates the `pub const INIT_SPACE` associated constant. Anvil's parser doesn't extract `#[derive(InitSpace)]` markers nor synthesize the constant. `Multisig::size(args.members.len())` references it via `Member::INIT_SPACE * n`. Single-line fix in either parser (extract InitSpace + auto-emit constant) or emitter (recognise unresolved `*::INIT_SPACE` and synthesize from struct-field byte counts).

### Blocker 3 — `ctx.accounts` / `ctx.bumps` leaked into state.rs impl method
Squads v4's `Multisig::invariant` impl method takes `&self` and references nothing context-y. The leak in state.rs:669 is from a DIFFERENT impl method — likely a CPI helper. Need to inspect the specific line.

### Blocker 4 — `CpiContext::` leaked in 4 places
state.rs:468/491, instructions/spending_limit_use.rs:77, instructions/vault_transaction_create_from_buffer.rs:35. Anvil's CpiContext folder doesn't reach all these shapes.

### Blocker 5 — `require!()` leaked in lib.rs:464 + state.rs:491
Mid-source rewrite missed two specific shapes.

## Next-session direction

1. **Pivot to RW4 (anchor-escrow-2025 take_offer)** — already cloned,
   uses the same Anchor source we've already promoted to FULL byte-
   equal compare scope on `make_offer`. Adding take_offer extends
   from "1 instruction byte-equal" to "multi-instruction byte-equal"
   on a real-world program.
2. **Squads v4 needs a separate emit-fix sweep** — Blockers 1 + 4 + 5
   each need targeted fixes, then re-probe. This is its own
   workstream, NOT a fixture-shipping task.

## Cleanup

`/tmp/squads-v4` left in place for now (852 GB free on root, no
pressure). Delete with `rm -rf /tmp/squads-v4` when done. NOT under
`/home/pk/Anvil/`, so doesn't affect WSL bloat.

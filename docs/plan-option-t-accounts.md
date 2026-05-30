# Plan — `Option<T>` account support (B6 arc)

**Status:** started 2026-05-29, fixture-first. Foundation laid (target fixture); emit surfaces NOT yet implemented.

## Goal
Support Anchor `Option<Account<'info, T>>` (optional) accounts. Today any instruction whose `#[derive(Accounts)]` has an `Option<T>` field has its **whole body stubbed `unimplemented!()`** + an `optional_accounts_unsupported` ParserWarning (loud-safe, but unported).

## Why fixture-first + surface-by-surface (the hard rule)
A **partial** `Option<T>` impl is *more dangerous than the current loud stub*: if the optional account lands in the wrong account-meta slot (or the None-sentinel is mishandled), the program reads the **wrong account at runtime** — a silent miscompile, the exact class the production-readiness review is about. So: **never ship a partial.** Each emit surface lands only when the differential fixture for it goes byte-equal green. Don't trade the loud stub for a quiet maybe.

## The Anchor ABI (what we must match)
- The optional account always occupies its fixed slot in the accounts slice.
- **None sentinel:** the client passes the *program's own ID* in that slot. Anchor deserializes `if account.key == program_id { None } else { Some(deserialize) }`.

## Current gap (empirical)
Target fixture `api/tests/differential-option-account.test.ts` (guarded by `B6_OPTION_T`; run with `B6_OPTION_T=1 bun test …`). Program: `init_counter` (no Option, works on both) + `bump` (reads `Option<Config>`, adds `cfg.factor` or 1). Scenario: init → bump(None) → expect counter = 8.

Result today: **RED** — `DATA MISMATCH on 'counter': anchor=8, anvil=7`. Anchor's `bump` runs (7+1=8); Anvil's `bump` is `unimplemented!()` → panics → reverts → counter stays 7. Both `.so` build; the gate is real. (The B5 revert-parity gate also catches it: bump = ok on Anchor, revert on Anvil.)

## Implementation order (one surface per fixture-slice, green-gated)
1. **Parser — stop stubbing.** Carry the `Option<T>` account (flagged optional) + the body instead of `unimplemented!()`. Gate behind a flag until the emit surfaces below exist, so we don't regress the loud stub into broken emit.
2. **Account-meta + None sentinel.** Emit the optional account in its slot; resolve `Some`/`None` via `key == program_id`. This is the *highest-risk* surface (wrong slot = wrong account) — verify byte-equal on both None and Some scenarios before moving on.
3. **`if let Some(x) = &ctx.accounts.maybe { … }` body.** Emit the Some/None branch + conditional deserialize. → target fixture (None case) should go green here.
4. **`Some` case.** Extend the fixture: init a `Config` (factor), bump(Some(config)) → counter += factor. Byte-equal green.
5. **Option call sites:** `.key()` / `.lamports()` / `.data_len()` on an optional account.
6. **Option in CPI helpers / `init` / `has_one`.** The long tail; each its own fixture-slice.

## Acceptance per surface
- The relevant slice of `differential-option-account` (and its `Some`/`None` variants) is byte-equal green AND revert-parity green.
- `bun run test:fast` stays green (no regression to the existing corpus).
- Only when a surface is fully green do we un-guard its fixture and remove the corresponding `optional_accounts_unsupported` stub path.

## Done
Un-guard the fixture (drop the `B6_OPTION_T` gate), remove the `unimplemented!()` stub for the covered shapes, and the `optional_accounts_unsupported` warning fires only for genuinely-unsupported residual shapes (documented).

## Progress (2026-05-29)

**Surface 1 — presence check: DONE (commit `0e59f24`, byte-equal green).** Behind `B6_OPTION_T`: optional accounts bind as `Option<&AccountInfo>` via the None-sentinel (emitter-base, `accounts.get(idx).filter(|a| a.key() != program_id)`); `ensureStateRead` + `stateAccountNames` skip optionals (walker); `ctx.accounts.X.is_some()` → `X.is_some()` was already wired (walker.ts:1920). Fixture `differential-option-account` (None case) green; no default regression (test:fast 1631/1631).

**Surface 2 — read-only if-let-Some deserialize: DONE (commit `b723e19`, byte-equal green).** Added the parallel regex (walker, mirrors 1926 minus `&mut`/save). Fixture exercises both branches: None (else → +1) and Some (deserialize `Config` → `+= cfg.factor`) → counter=18, config=10 byte-equal both runtimes. No default regression.

**Surface 3 — mutable if-let-Some: DONE (`57a5fc4`).** Verified the existing `&mut` handler end-to-end (deserialize-mutate-save).

**Surface 4 — `key()`/`owner()` on an optional: DONE (`eafebe6`).** AccountInfo-level calls inside `if let Some(cfg) = …` route to the underlying binding. Key insight: pinocchio `key()`/`owner()` return `&Pubkey`, so the routing derefs → `(*cfg_account.key())` to match Anchor's owned `Pubkey` (this was the E0277 from the first attempt — a deref mismatch, not a deep issue). `lamports`/`data_len`/`is_signer`/`is_writable` → owned, no deref.

**Surface 5 — `to_account_info()` + `lamports()`: DONE (`55edf00`).** `cfg.to_account_info()` routes to the AccountInfo binding; this is the *only* valid way to reach `lamports()` (the direct `cfg.lamports()` doesn't compile on Anchor's `Account<T>`).

**Remaining tail (harder/rarer):** optional in a state-changing CPI arg, optional in an `init` constraint, optional in `has_one` — each its own fixture-slice. **Then un-gate** (drop `B6_OPTION_T`, un-skip fixture, remove the stub for covered shapes) — only safe once the tail is covered OR a conservative "instruction uses the optional only in covered shapes" detector gates the stub. Plan rule still holds: never ship a partial. Minor wart to optimize later: surface 5 emits a dead `let cfg = …::from_account_info` when only the AccountInfo is touched (harmless unused-var warning).

## Progress (2026-05-30) — un-gate slice started; the detector needs TWO axes

**Key correction (advisor): the un-gate detector must gate on BOTH (a) layout-matches-a-verified-fixture AND (b) all-body-uses-covered — not body-use alone.** Body-use says how the optional is read (the 5 surfaces); it says nothing about the highest-risk axis (line 22): the account-meta slot + None-sentinel + hardcoded `idx` mapping. A body-use-only detector would happily un-gate a layout the fixture never exercised → wrong-account read = the partial the plan forbids, via the axis the detector doesn't look at.

**Measurement (decisive):**
- Existing `differential-option-account` verifies **1 trailing optional**.
- squads-v4's 8 optional-bearing instructions are **all TRAILING** but **multiple**: 7 have 2 optionals (`@[2,3]` or `@[4,5]`), `spending_limit_use` has **5** (`@[5,6,7,8,9]`). NONE interleaved. So the real-world demand is multi-trailing, which the single fixture never covered.

**New fixture: `differential-option-account-multi.test.ts`** (gated `B6_OPTION_T`) — 2 trailing optionals, factors 10 & 100 so a None in slot-1-only vs slot-2-only is distinguishable; scenario hits all four combos (None,None)(Some,None)(None,Some)(Some,Some). Emit verified correct by inspection (each optional binds independently `accounts.get(idx).filter(key!=program_id)` + per-branch deserialize; idx stable because Anchor sentinel-fills every optional slot). **Byte-equal differential GREEN (commit `7f8ad1d`)** — multi-trailing layout verified.

## Progress (2026-05-30 cont'd) — un-gate detector IMPLEMENTED (sole gate, env bypass removed)

`optionalAccountsAllCovered(instr, isStateType)` lands in the new shared module
**`src/emitter/body-emitter/optional-accounts.ts`** and *replaces* the
`!process.env.B6_OPTION_T` emit gate at emitter-base.ts (the env var is now only
a test-runner selector for the gated fixtures, never an emit gate — there is no
longer any way to force-emit a non-covered shape). Three axes, all must hold or
the loud `unimplemented!()` stub stays:

- **A. layout** — `min(optionalIdx) > max(requiredIdx)` (all-trailing; the
  verified family). Interleaved/leading → stub. 2-trailing is byte-equal proven;
  N-trailing is the same mechanism (each optional binds independently via its own
  `accounts.get(idx)`), so squads-v4's up-to-5 trailing optionals pass Axis A
  (they're nonetheless stubbed by Axis B — their types aren't state structs).
- **B. type** — every optional wraps a generated state type
  (`Option<Account<'info, S>>`, `S ∈ ir.accounts`). `Option<Program/Signer/
  UncheckedAccount>` → stub.
- **C. constraint-free** — every optional is a BARE `Option<Account<…>>` (no
  `mut`/`signer`/`init`/`pda`/`seeds`/`has_one`/`owner`/`address`). **Advisor-
  caught + empirically confirmed:** the emit's signer/writable/owner prechecks
  all filter `!a.isOptional`, and no `has_one`/seeds verification is emitted for
  optionals, so a constrained optional un-gated with NONE of its checks (verified
  via `/tmp/confirm-gap.ts`: `#[account(mut, has_one, seeds, bump)]` optional →
  zero checks) — Anvil would deserialize+mutate whatever account sits in the slot
  = wrong-PDA / `has_one` bypass. Stub until those checks are emitted
  conditionally inside the Some-branch + adversarially byte-equal verified
  (a separate slice). Consequence: the single fixture's `bump_mut` (`#[account
  (mut)]` optional) was removed — the `&mut` surface returns with that slice.
- **D. body-use** — strip the three covered shapes (`is_some` / `if-let-Some &` /
  `if-let-Some &mut`) using the walker's *exact* regexes, then any surviving
  `ctx.accounts.<optional>` token → stub. Empty body → stub. **Nested-optional
  guard:** an optional's if-let body referencing another optional false-passes
  the residue check (non-greedy `}` eats the inner header) → caught explicitly →
  stub (clean stub, not a compile error — advisor-flagged).

**Single-source-of-truth (critical):** the three regexes live ONLY in
`optional-accounts.ts`; the walker imports the factory functions
(`makeOptionalIf...Re`) instead of inlining literals. A future edit to a walker
shape can't silently desync the gate from what emit actually handles — that
desync *is* the silent-miscompile class this arc prevents.

**Default-suite flip set = EMPTY (verified before un-gating).** Demos have zero
optional *accounts*; `optional-state.rs`'s `Option<>` are borsh state fields, not
accounts; the only internal optional-account fixtures (`fixture-if-let-ctx-
accounts`, `fixture-cargo-gate`) are `Option<Program<Token>>` → Axis B keeps them
stubbed (unchanged). So removing the env gate flips nothing in `test:fast`.

**Verification — all green:** detector unit tests `tests/optional-accounts-
detector.test.ts` (7, each axis covered+uncovered incl. constraint + nested)
pass; squads-v4 re-classify still 8/8 STUB; `test:fast` **1731/0** (+7 new tests,
zero snapshot flipped — empty flip set confirmed); both B6 differentials
**byte-equal green with the detector driving emit** (`B6_OPTION_T=1`, 2/2);
`tsc` clean.

**Target scope — PINOCCHIO only (advisor-flagged).** The gate lives in the
shared `BaseEmitter`, so the detector un-gates BOTH emitters, but the two
differentials default to `anvilTarget: pinocchio`. The Native optional emit
(`.key` field vs `.key()` method in the binding) is plausibly correct but NOT
yet differential-verified — a Native optional-account differential is a
follow-up; until then the byte-equal claim is Pinocchio-scoped.

**Deserialize enforcement (advisor's final gate) — disc YES, owner NO.** The
happy-path differentials always pass the correct account, so they can't prove
what a bare `Option<Account<'info, T>>` relies on intrinsically: Anchor's
`Account<T>` enforces **owner == program_id** AND **disc == T** on deserialize,
even with zero constraints. Inspected the generated `T::from_account_info` →
`Self::read` (`/tmp/check-fai.ts`):
- **Discriminator: enforced** (`if data[..8] != Self::DISCRIMINATOR { return Err
  (InvalidAccountData) }`) — a wrong-TYPE account is rejected, matching Anchor.
- **Owner: NOT enforced** — `from_account_info` does `borrow_data` + `read`, no
  `owner() == program_id`. So a wrong-OWNER account carrying a forged Config
  discriminator would be accepted by Anvil and rejected by Anchor (ConstraintOwner).

**This is NOT optional-specific and NOT introduced by this slice** — it's the
behavior of `from_account_info` for *every read-only* `Account<T>` deserialize
(the handler emits an explicit owner check only for `mut` custom-state accounts,
`!a.isOptional && a.isMut`; read-only reads rely on `from_account_info`, which
skips owner). The un-gate just extends the same existing path to bare optionals.
**Claim scope:** bare-optional emit is happy-path byte-equal + discriminator-
enforced; owner enforcement is *inherited (currently absent)*, a pre-existing
general gap. → **FINDING for the user** (separate slice; fixing it = adding an
owner check to the read-only `Account<T>` deserialize for ALL accounts, broad
blast radius, its own adversarial verification). Do not word the un-gate as
"byte-equal safe for bare optionals" unqualified.

**Real-world classification (squads-v4, /tmp/squads-classify.ts):** all **8**
optional-bearing instructions classify **STUB** — and the reason is the safety
win. Their layout is all-trailing (Axis A would pass: `@[2,3]`, `@[4,5]`,
`spending_limit_use @[5,6,7,8,9]`), but their optionals are
`Signer`/`System`/`Mint`/`TokenAccount`/`TokenInterface` — **none a generated
state type**, so **Axis B keeps every one loud-stubbed**. The detector refuses to
un-gate a type family it never byte-equal-verified. So this slice does NOT yet
transpile squads; it un-gates only the verified `Option<Account<'info, State>>`
pattern (which my fixtures + real DeFi optional-state accounts use).

**Remaining / next (in order):**
1. **`Option<Signer>` / `Option<Program>` / `Option<Token*>` surface** — the
   actual squads un-gate. Each its own byte-equal fixture-slice (presence +
   used-in-CPI), then extend Axis B to admit the verified type. Until then squads
   stays correctly stubbed.
2. Un-gate the differential fixtures (drop their test-level `B6_OPTION_T` guard →
   permanent `test:slow` coverage) once this slice is reviewed.
3. Tail surfaces (optional in CPI arg / `init` / `has_one`) stay stubbed by Axis
   C until each is its own fixture-verified slice.
All LOCAL for review (emit-path + safety-critical). Clones in /tmp/rw; squads at
/tmp/rw/v4; classifier at /tmp/squads-classify.ts.

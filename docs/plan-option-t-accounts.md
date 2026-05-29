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

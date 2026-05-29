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

**Next — if-let-Some deserialize (precise finding).** The deserialize-inside-Some rewrite ALREADY EXISTS at walker.ts:1925-1946 — but ONLY for the `&mut ctx.accounts.X` (mutable, emits trailing `T::save`) shape. The read-only `&ctx.accounts.X` shape (`if let Some(cfg) = &ctx.accounts.maybe_x { cfg.field }`) has NO handler → carried verbatim → `cfg.field` on `&AccountInfo` fails to compile. **ACTION:** add a parallel regex mirroring walker.ts:1926 but matching `&\s*ctx\.accounts` (no `&mut`) and emitting the deserialize WITHOUT the trailing save (read-only). Then extend the fixture with a Some-case scenario (init a `Config { factor }`, `bump(Some(config))` → counter += factor) and verify byte-equal green. Then: `.key()`/`.lamports()` on optionals, CPI/init/has_one, finally un-gate.

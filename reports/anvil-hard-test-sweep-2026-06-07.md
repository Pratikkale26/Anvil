# Anvil — Hard-Test Adversarial Sweep #3 (2026-06-07)

8 parallel category hunters wrote **new** edge-case Anchor contracts in fresh territory (steered away from the
F1–F8 / prior-sweep classes), ran each through Anvil parse→emit→validate for both targets + a silent-ship audit;
then each suspected finding got an adversarial verify (reachability via the #25 compile-gate + re-emit). Workflow:
17 agents, ~1.37M subagent tokens, ~48min. **9 suspected, 9 CONFIRMED REAL** (every finding survived adversarial
verification — high signal). Each: parses + validator-CLEAN (0 errors, no `unimplemented!()` / no `⚠️ Anvil`
marker) yet semantically wrong vs Anchor, on a contract that **compiles** (reachable).

Severity: **3 HIGH, 4 MED, 2 LOW.**

## HEADLINE class: `#[derive(InitSpace)]` + read-guard mis-size VARIABLE-LENGTH fields (G1/G2/G4/G5)

The variable-length-field guard added in commit `8c62c10` protected only the read/write **offset** path. The
**INIT_SPACE synthesis** and the **read guard-floor selector** never got the same guard, so a `#[account]` struct
with a data-carrying enum or `Option<T>` field gets a wrong synthesized size constant — silently baked into the
artifact (allocation + read floor), validator-clean. Two of these are HIGH (account *under-allocation* → an
out-of-bounds slice panic/revert exactly where Anchor commits successfully).

- **G1 [HIGH] — data-carrying enum field under-sized to 1 byte.** `resolveTypeSize` (emitter-base.ts:3942)
  returns a flat `1` for ANY enum; the INIT_SPACE sum (emitter-base.ts:4390) has no var-len guard. For
  `State { amount:u64, side:Order, owner:Pubkey }` with `Order{ Buy{price:u64}, Sell }`, Anvil emits
  `INIT_SPACE = 41` (8+1+32) → allocates 49 bytes vs **Anchor's 57** (the enum contributes `1+max(8,0)=9`).
  Latent when the default `Sell` (1-byte) variant is stored, but any handler storing `Buy{..}` (9 bytes) runs the
  trailing `owner` write at `[25..57]` on a 49-byte buffer → **OOB panic / revert**, where Anchor (space=57)
  commits. `isVariableLengthType("Order")` already returns true → a guard at line 4390 mirroring the read/write
  path would have suppressed the wrong constant.
- **G2 [HIGH] — top-level `Option<T>` field sized flat 32.** `typeSize` (emitter-utils.ts, `return sizes[t] ?? 32`
  at ~line 304) has no `Option<>` branch → `typeSize("Option<[u8;64]>") = 32` regardless of inner type. Anchor's
  derive sizes it `1 + sizeof(T)`. For `State { x:u64, p:Option<[u8;64]> }`: Anvil `INIT_SPACE=40` → 48 bytes vs
  **Anchor's 81**. The field read/write is *correct* (top-level Option takes the open-ended Borsh branch), so the
  divergence is purely the under-allocated buffer → storing `Some([u8;64])` (65 Borsh bytes) writes at `[16..81]`
  on a 48-byte buffer → **OOB panic**, where Anchor succeeds. `Option<Pubkey>` (32 vs 33) under-allocs by 1 → OOB
  on `Some`. (`Option<u64>`: 32 vs 9 → over-allocs, benign — see G5.)
- **G4 [HIGH] — top-level `Option<T>` read guard-floor over-rejects EVERY account.** The guard selector
  `acc.fields.some(f => f.type==="String" || /^Vec</.test(f.type))` (native-emitter.ts:1867-1870 /
  pinocchio-emitter.ts:3069-3072) does NOT include `Option<`, so an Option-only struct gets the fixed-path guard
  `if data.len() < TOTAL_LEN`. For `Config2 { admin:Option<Pubkey>, fee:Option<u64> }`: TOTAL_LEN=72, but the real
  max on-disk size is `8 + 33 + 9 = 50`. Every validly-sized account is `< 72` → `read()`/`from_account_info()`
  **always returns InvalidAccountData**. The read body itself is correct (Borsh branch) — body=correct,
  guard=wrong, the exact inconsistency. The broader `isVariableLengthType` (8c62c10, which DOES include Option) is
  only wired to the nested-refuse path, not this guard selector.
- **G5 [MED] — `Option<T>` INIT_SPACE over-allocation** (same root as G2; over-alloc direction). `Option<u64>` →
  33 vs Anchor's 10. Divergent rent + a `read` guard that loudly rejects a genuine 18-byte Anchor-created account
  on cross-implementation read. Same fix as G2.

## Other confirmed findings

- **G3 [MED] — `remaining_accounts` loop double-counts a positional optional account.** `Option<Account<T>>`
  always consumes a positional slot in Anchor, so `ctx.remaining_accounts` starts AFTER it. Anvil's loop offset =
  `instr.accounts.filter(a=>!a.isOptional).length` (walker.ts:1433 + pass-through-emit.ts:664), excluding the
  optional → the loop iterates one slot too early, **including the optional account in the remaining-accounts
  sum** (e.g. `treasury.total += bonus.lamports() + r1 + r2` instead of `r1 + r2`). Behind a **false** parser
  warning (`optional_accounts_unsupported`, instruction-parser.ts:342) that claims the body is
  `unimplemented!()`-stubbed — empirically the body is real compiling code; the warning never escalates to an
  error so `/emit` + `--strict` pass it. Correct fix needs a *dynamic* cursor (`named_required + bonus.is_some()`)
  since the None-sentinel optional doesn't pop a slot the way Anchor does; interim safe move = loud-refuse when a
  body references `ctx.remaining_accounts` AND any optional account exists.
- **G7 [MED] — `#[account(owner = X)]` explicit owner override silently dropped.** The parser captures
  `{kind:"owner", value:X}` but `emitAccountConstraintChecks` (walker.ts:2101-2285) has branches only for
  `constraint`/`address`/`has_one` — an `owner` constraint falls through and is dropped (no check emitted, both
  targets). The existing `emitOwnerCheck` is NOT a substitute (it's `isCustomState`-gated + hardcoded to
  `owner == program_id`, not the override value). Adversarial account (not owned by `X`): Anchor reverts
  ConstraintOwner (2004); Anvil accepts → confused-deputy / account-substitution. Corpus-absent (→ MED not HIGH).
- **G8 [MED] — inline `CpiContext::new(prog, <hoisted-struct-var>)` drops the SPL account mapping.**
  `extractSplTransfer` (cpi-detector.ts:1781) takes the inline branch when `firstArg.includes("CpiContext::")`,
  then `findDescendant(firstArg, "struct_expression")` finds no inline struct (it was hoisted to a `let`) → from/
  to/authority keep their literal defaults `?? "from"/"to"/"authority"`. A crosswise `Transfer { from: ctx.to, to:
  ctx.from }` therefore emits a from→to transfer — **the opposite direction**. Silent only when the account fields
  are named exactly `from`/`to`/`authority` (else the wrong defaults are undefined idents → E0425 loud). Same gap
  in `extractSplMintTo`/`extractSplBurn` (wider silent window — no direction to reverse). Distinct from the F4
  variable-*context* work (here the context is inline, the *accounts struct* is the var). The fix threads the
  existing `cpiAccountsByVar` map (body-classifier.ts:1178) into the extractor.
- **G9 [LOW] — explicit `bump = <expr>` on a non-init seeds constraint dropped.** IR captures `{kind:"bump",
  value:...}` but the emit (walker.ts:812 `normalizedBumpLine` + visitor mirror :1451) always emits the canonical
  bump *search* (`find_program_address` / the `bump_seed` loop), never Anchor's `Some(b)` branch
  (`create_program_address([seeds, &[expr]])`). Net: Anvil is LAXER — a tx passing the correct PDA but a WRONG
  bump arg is rejected by Anchor (ConstraintSeeds) and accepted by Anvil. No fund-misroute (Anvil always pins the
  canonical PDA), so LOW. Stored-field form `bump = vault.bump` is the higher-corpus shape.
- **G6 [LOW] — local var shadowing a `Sysvar<Clock>` account name misroutes a field read to the syscall.**
  `applyClockRentRewrites` (visitor-base.ts:4483-4496) builds `clockNames` from any `Sysvar<Clock>` account and
  regex-rewrites `<name>.epoch` → `Clock::get()?.epoch` with no lexical-scope check. So
  `let clock = &ctx.accounts.pool; out.v = clock.epoch;` (reading the stored `Pool.epoch`) is rewritten to the
  **live runtime epoch** syscall — Anvil even binds the local correctly (`let clock = Pool::read(...)`) then
  ignores it. Contrived (needs a name collision + a type-compatible Clock field), so LOW; the Rent analogue is
  UNREACHABLE (`Rent.exemption_threshold` is f64 → type-mismatch won't compile). Same family as F1/F7 (scope-blind
  name substitution) but a distinct code path.

## Reusable

- **The headline class is the variable-length-field sizing seam.** `8c62c10` guarded the read/write OFFSET path;
  the INIT_SPACE synthesis (emitter-base.ts:4390), the `typeSize`/`resolveTypeSize` resolvers, and the read
  guard-floor selector (native:1867 / pinocchio:3069) each need the SAME var-len awareness. Grep every consumer of
  `resolveTypeSize`/`typeSize` for the same blind spot. The conservative posture (already used for the nested
  read/write path) is to SUPPRESS the synthesized constant when any field is variable-length, rather than ship a
  wrong number.
- **A `severity="warning"` validator issue is NOT a safety net if its text lies.** G3's warning claims an
  `unimplemented!()` stub that isn't there; `/emit`/`--strict` gate on errors, not warnings, so it ships. Either
  escalate to error (loud-refuse) or make the body actually correct — a warning that promises a panic-stub but
  delivers silent wrong output is worse than nothing.
- **The #25 compile-gate held up:** the verify phase distinguished real from unreachable (the Rent-shadow analogue
  of G6 was correctly excluded because `Rent.exemption_threshold: f64` won't compile against a `u64` field).
- See [[project-hardtest-sweep-2026-06-06.md]] for sweep #2 (F1–F8) and the earlier sweeps.

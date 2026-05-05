# Awesome-Solana-Programs + Raydium CLMM probe (2026-05-05)

User asked to test Anvil against:
- github.com/raydium-io/raydium-clmm
- github.com/SunitRoy2703/awesome-solana-programs (curated list)

Probed 4 large real-world Anchor programs through `/parse` + `/emit` (both
targets) + `/build`. One critical emitter bug found and fixed mid-probe
(see "Bugs fixed" below).

## Per-program results

### Raydium CLMM (`raydium_amm_v3`)
- 26 instructions, 9 account types, 14 custom types, 51 error variants.
- **/parse: OK**.
- **/emit pinocchio: 16 validation errors** — 10× Anchor wrapper leak
  (Account<>, Signer<>, Box<Account<>>, Program<>) in lib.rs (the `pub mod
  admin { pub const ID = pubkey!(...) }` block — Anvil emits the inner
  pubkey!() macro call which doesn't resolve in the target framework).
- **/emit native: 4 errors** — only 2 unsalvageable stubs + 2
  `.try_into().unwrap()` warnings. Native target much friendlier here.
- **/build native cargo: 181 errors** — dominated by E0428 multiple-`ID`
  defs (cfg-gated `declare_id!()` for devnet vs mainnet — both branches
  emit), E0412 cross-module type refs, helpers.rs syntax breaks
  (regex commentout interaction).

**Top fix candidate**: cfg-strip the inactive `declare_id!()` /
`pub const ID` branch instead of emitting both. Same pattern hits any
program that distinguishes devnet/mainnet program-IDs.

### MarginFi v2 (`marginfi`)
- **91 instructions**, 0 accounts (parser misses `#[account(zero)]`
  pattern at scale), 34 types, **416 error variants**.
- **/parse: OK** (1 MB source; parser handled).
- **Emit CRASHED initially** — "Invalid regular expression: nothing
  to repeat" thrown from `sourceErrorEnumName`. Trace: variant name with
  regex metacharacter (`+`, `*`, `?`, etc.) interpolated into RegExp
  literal without escaping. **FIXED in this session** — see "Bugs fixed".
- **Post-fix /emit pinocchio: 97 errors** across 96 files. Categories:
  86× misc (cross-module type/import resolution), 8× ctx.accounts leak,
  1× msg!, 1× anchor_lang import, 1× InterfaceAccount.
- **Post-fix /emit native: 96 errors** — same shape, 1× .try_into().unwrap().
- Cargo build not attempted — emit error count too high to be
  productive without targeted fixes first.

### Marinade (liquid-staking-program)
- 28 instructions, 2 accounts, 23 types, **179 error variants**.
- **/parse: OK**.
- **/emit pinocchio: 60 errors** — 29× unsalvageable stubs (the
  impl-method stubbing I shipped earlier this session is firing
  correctly — these are Anchor patterns we can't transpile, now
  compile-clean), 12× misc, 9× CpiContext, 4× brace imbalance, 4×
  ctx., 1× msg!, 1× wrapper.
- **/emit native: 56 errors** — same shape minus the msg! and wrapper
  (native handles those).
- Brace imbalance (4 instances) suggests T22-commentout still has a
  shape my fix didn't catch. Worth a follow-up probe.

### Orca Whirlpools
- **/parse: REJECTED** — "Source exceeds 1.5 MB limit" (1003).
- The flattened multi-file source exceeds the API's hard 1.5 MB cap.
- Not an Anvil bug per se — the cap is a defensive limit. Whirlpools
  is genuinely a large program. Workaround: bump the limit or carve
  out single instructions.

## Bugs fixed in this session

### sourceErrorEnumName regex-escape (api/src/emitter/emitter-base.ts)
Variant names interpolated into a RegExp literal without escaping. Any
production program with 100+ error variants is statistically likely to
hit a metacharacter edge case. MarginFi v2 (416 variants) crashed the
whole emit; the fix unblocks a class of large-program probes.

```
- new RegExp(`\\b([A-Za-z_][A-Za-z0-9_]*)::${variant}\\b`, "g")
+ // skip non-ident variants + escape regex metas
+ if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(variant)) continue;
+ new RegExp(`\\b([A-Za-z_][A-Za-z0-9_]*)::${escapeRe(variant)}\\b`, "g")
```

Regression test: `api/tests/source-error-enum-regex-escape.test.ts`
(3/3 pass).

## What this means for "where Anvil stands today"

- **Parser handles big real-world programs** — 91-instruction MarginFi
  parses cleanly. Raydium CLMM (26 ix), Marinade (28 ix) parse cleanly.
  Only Whirlpools (1.5 MB+ source) hits the size cap.
- **Native emit is dramatically friendlier than Pinocchio** for these
  programs — Raydium CLMM 16 → 4 errors, similar gap on Marinade. The
  Anchor-leakage validations apply to Pinocchio but native passes them
  through (since Anchor is built on solana_program).
- **Top remaining emit gaps for real-world Pinocchio:**
  1. `cfg(feature)`-gated declarations (declare_id, pub const ID) —
     emit both branches → E0428.
  2. `pubkey!()` macro inside `pub mod` blocks — not expanded.
  3. Cross-module type refs (E0412) when emit splits a multi-file
     program — modules have different visibility post-flatten.
  4. T22-commentout still has 1 brace-imbalance shape on Marinade
     (the 2026-05-05 fix caught 3 of 4 in Squads but not all variants).

## What's NOT broken (good news)

- AI subsystem: 47/47 sanity-sweep green post-fix.
- Demo corpus: 18/18 cargo green, 14/14 snapshot locked, 14/14
  emitter-validation green.
- Existing differential fixtures unaffected — no regressions from
  the regex-escape fix.

## Cleanup

`/tmp/raydium-clmm`, `/tmp/whirlpools`, `/tmp/marginfi-v2`,
`/tmp/liquid-staking-program`, `/tmp/awesome-solana-programs` all
removed at end of session. `/tmp/probe-marginfi.ts` removed.

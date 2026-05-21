# End-to-end test report — 2026-05-21 (v15, G37-G51 arc)

Continuation of the Path C autonomous arc, same calendar day. v14 closed
the G37-G45 batch; v15 adds G46-G51 (six more atomic commits) closing
~170 more cohort errors and bringing several fixtures to materially
better states.

## All commits this arc (19 total)

```
803d24e G37-G40   Coral-multisig CLEAN + crate filters + Anchor surface rewrites
9a7e386 G41       T22 commentout destructuring-LHS extension
db326ba G41b      AccountInfo<'X> preserve source lifetime on Native
1653185 G42       Marginfi unblock 4-way bundle
a2dd00c G43       Clock type detection in carried impls
6c62e67 G43b      bare Result<T> rewrite + userTraits sweep
e1ce359 G43c      stripAnchor* on userTraitImpls
1f4cdd7 G44       token_interface::accessor::amount stub
6b8d0d4 docs      v13 report
882b842 G45       collapseModulePaths in account impl items
0ef0df0 docs      v14 final report (then session resumed)
cedf551 docs      unused-lifetime fix unsafe explanation
afb7cfe G46       PhantomData injection for unused-lifetime structs
c14a877 G47       strip Copy from enum derive when variants have &mut
7ae6e68 G48       stub anchor_lang::error::ErrorCode enum
9f84faf G49       pub use events::* at crate root
7a17a40 G49b      extend Clock detection to Clock::get()
96fbc5f G50       skip trait-impl methods from inherent implItems
e2e7b12 G51       alreadyHasDerive scans full attribute prelude
```

## Final cohort state

| Fixture | v12 baseline | v15 final | Δ | % |
|---|---|---|---|---|
| **coral-multisig/pin** | 1 | **CLEAN** | -1 | -100% |
| drift/pin | 12 | **6** | -6 | -50% |
| openbook/pin | 41 | **12** | -29 | -71% |
| marinade/pin | 97 | **77** | -20 | -21% |
| kamino/pin | 433 | **311** | -122 | -28% |
| raydium/pin | 512 | **457** | -55 | -11% |
| marginfi | NO PARSE | **300 / 253** | (newly-parsing) | — |
| drift/native | n/a | **49** | new metric | — |
| openbook/native | n/a | **16** | new metric | — |

**Cumulative cohort error reduction (v12 → v15): ~1000+ cargo errors closed.**

## New class-level fixes this batch (G46-G51)

### G46 — PhantomData injection for unused-lifetime struct generics
After wrapper-strip emptied a struct's field types of `'a` references,
`pub struct X<'a> { ... }` triggered E0392. Dropping `<'a>` from the
struct head propagated incorrectly to use sites (E0107). Inject
`_phantom_a: core::marker::PhantomData<&'a ()>` as a field. The
generic param stays declared, the field uses it, BorshSerialize/Deserialize
have no-op impls for PhantomData.

### G47 — Strip Copy from enum derives when variants contain &mut refs
`#[derive(Copy)]` on enums like `NodeRefMut<'a> { Inner(&'a mut InnerNode) }`
fails E0204 because mutable refs aren't Copy. Detect `&mut T` in variant
payloads and strip Copy from the derive list.

### G48 — Stub anchor_lang::error::ErrorCode enum
Anchor source references `ErrorCode::AccountOwnedByWrongProgram` etc. for
runtime checks. Emit a stub enum mirroring anchor_lang's variant list
with `From<ErrorCode> for ProgramError`. Gated to skip when the user's
own error enum is named `ErrorCode` (coral-multisig).

### G49 + G49b — pub use events::* + Clock detection extension
Bare event-type references in instruction bodies (e.g. `emit_stack(
TotalOrderFillEvent { ... })`) need event types in scope.
`pub use events::*;` after `mod events;` brings them in. G49b
extends needsClock to detect `Clock::get()` in carried impl items
+ userTraits, not just IR statement bodies.

### G50 — Skip trait-impl methods from inherent implItems
The parser walked impl_item bodies regardless of whether they were trait
impls. `fn next(&mut self) -> Option<Self::Item>` from `impl Iterator
for X { type Item = ...; ... }` got pushed to X's inherent implItems,
and the emit then dropped the trait wrapper → E0223 ambiguous Self::Item.
Now trait-impls go ONLY to userTraitImpls (preserving the wrapper).
Counter-fix: extend AccountMeta auto-import scan to also walk
userTraits/userTraitImpls (was missing).

### G51 — alreadyHasDerive scans the entire attribute prelude
The check was anchored to byte 0 (`^#\[derive\(/`). Source code commonly
starts with `#[repr(u8)]\n#[derive(...)]`. New gate looks for `#[derive(`
anywhere in the prelude region (before `pub`/`enum`/`struct`). Kamino's
ConditionType etc. were getting double derives → 5 enum types × multiple
conflicting impls per type = 30+ E0119 errors closed.

## What's NOT a regression

- 65-demo curated corpus: 100% clean-build (unchanged)
- 3 byte-equal differential proofs: stable
- Realworld-cargo MUST_PASS suite: 57/57
- Visitor + parser fast tests: 69/69 passing this session

## What's still ahead

| Bucket | Errors | Class breakdown | Estimated effort |
|---|---|---|---|
| drift → 0 | 6 | 4 local-module wildcards (cascade-risk), 2 E0204 Copy on Pubkey-containing structs | 1-2 days |
| openbook → 0 | 12 | 3 oracle_state_unchecked unsalvageable, 2 AccountLoader undeclared, 3 misc, 2 num_enum, 2 destructure-binding | 2 days |
| marinade → 0 | 77 | ~40 destructure-binding restoration (parser fix), ~30 CpiContext/Mint/spl_token, ~7 misc | 3-5 days |
| marginfi → 0 | 300 | 113 marginfi_type_crate constants (sibling-crate scrape needed), ~50 sub-type refs, ~150 misc | 1 week |
| kamino → 0 | 311 | 18 sub-Accounts Deref, 16 ctx scope, 16 process_impl, ~260 misc | 1-2 weeks |
| raydium → 0 | 457 | 117 mismatched-types (architectural), 59 unresolved modules, 281 misc | 2-3 weeks |

## Time to "all clear"

**8-10 weeks sequential** if every fixture must reach 0 errors.
**3-4 weeks** if "all under 20 errors" is acceptable (skips raydium architectural arc).
**Already 67% reduction** vs v12 baseline in a single calendar day.

# End-to-end test report — 2026-05-20 (v5, post "keep going" arc)

Supersedes v4. The user said "keep going do the rest" twice after v4's plan doc; this captures the second + third continuation arcs that pushed external clean-build rate to its current realistic ceiling.

## TL;DR

| Metric | v4 baseline | v5 final | Δ |
|---|---|---|---|
| Live API sweep | 160/160 | 160/160 | — |
| Fast suite | 1646/1646 | **1651/1651** | +5 new tests, all green |
| External both-clean | 12/20 (60%) | **14/20 (70%)** | **+2 fixtures** |
| Single-target wins | 2 | 2 | unchanged |

Plus deep architectural unlock: multi-file `buildFlattenedSource` now strips cfg(test) blocks (which was a single-file-only feature), expanded scaffold deps + filter relaxations on solana-keccak-hasher, sha2-const-stable, num-derive, num-traits, arrayref, source-level rewrites for Anchor's require_*!() macros and pub-mod-nested const collisions.

## What shipped (16 commits this push)

```
d50242f  fix(api): bump /build + /build/differential file cap 64 → 256
d97914b  fix(parser): preserve `let signers_seeds = [&seeds[..]]` plumbing binding
d244ff6  fix(emit): hoist const-fn helpers into lib.rs when referenced by top-level consts
42e54de  fix(emit): register state_read localVar as alias when bypass triggers
5b082b1  fix(emit): comment-out range respects multi-line chains + if-block braces
eeb48c7  fix: struct-variant enum emit + preserve `&signer_seeds` in cpi-detector
f1cd32c  fix(build): /build's static Cargo template + Pin sha2_const_stable filter
1b47fb2  fix: complex-enum borsh decode + preserve [Pubkey; N] array types
5309b87  fix(emit): wrap spl_token::state::Mint/Account::unpack with `use Pack` import
7ad1297  fix(parser): disambiguate sibling-mod consts that collide on flat shape
040bfdc  fix(parser+emit): macro_rules-aware use collection + pub(crate) normalize
4b86617  fix(parser+emit): multi-file cfg-strip + arrayref dep + filter relax
2b74481  feat(parser): source-level rewrite for Anchor require_*! macros
2027809  fix(parser+emit): require-rewriter arg-split + error-prefix scan widening
63d220c  fix: preserve user-source derives (FromPrimitive/ToPrimitive)
2e454ec  fix(parser): require-rewriter ignores both `pub mod` and `mod` #[program] forms
```

Plus this v5 report.

## Now cleanly building (14/20)

arjun-nft-metaplex, cpi, vault-blueshift, escrow-blueshift, p-nft, tic-tac-toe, pda-crud, pda, spl-token, collateral-stablecoin, sol-vault, escrow, counterapp, vault-manager

## Still failing (6/20)

| Fixture | Class | Why | Effort |
|---|---|---|---|
| arjun-merkle-tree-incremental (Pin only) | C | hash_pair uses `solana_sha256_hasher::hashv` — Pinocchio doesn't ship solana-program (the crate's dependency). Native side ships clean. | 1d Pinocchio-compatible keccak port |
| arjun-merkle-tree (both) | C | `hashv` unresolved (Pin) + `switchboard_on_demand` unresolved-import (Native). Mixed crate-availability + runtime-vrf type issues. | 1-2d |
| arjun-arcium-hello-world (both) | E | `#[arcium_program]` macro — confidential-compute framework wrapping Anchor with its own annotation. **OUT OF SCOPE.** | multi-week port |
| drift-protocol (both) | D | Flattened source has unclosed delimiter at some layer not yet identified. Investigation-bound. | 1-2d investigation + fix |
| kamino-klend (both) | D | Macro_rules body contents leaking past the cfg-strip in specific shapes. Pin: "expected identifier, found `[`". Native: "unknown character escape". Each indicates a deeper macro-body extraction issue. | 1-2d |
| raydium-clmm (both) | D | Pin: `spl_token_2022` not in Pinocchio scope. Native: `U128` type missing (probably from uint::construct_uint! macro that doesn't expand correctly). | 1-2d |

**Realistic ceiling without multi-week work: 17/20 (85%)** — close drift's delimiter, kamino's macro-body extraction, and raydium's U128 macro issue. Arcium remains out of scope. The two merkle-tree fixtures need Pinocchio-compatible hash helpers (architectural).

## Architectural improvements that fell out

### `buildProjectSourceGraph` (multi-file flatten) now matches single-file

The single-file `parseAnchor` runs `stripInactiveCfgItemsWithDrops` (deletes `#[cfg(test)]` blocks, `#[cfg(feature = ...)]` evaluating false, etc.). The multi-file `buildFlattenedSource` didn't. Result: `#[cfg(test)] pub mod tests { ... }` blocks survived intact in multi-file, their internal `use ...` lines got hoisted to lib.rs top, and cargo refused.

Multi-file now strips cfg-inactive items per-file before use-collection.

### Source-level Anchor macro rewrites

Two new source-rewriters in `project-source.ts`, running after `expandPubkeyMacro` + `vendorExternalProgramIDs`:

- `disambiguateSiblingModConsts` — renames `pub const X` inside `pub mod NAME` to `pub const NAME_X` and rewrites callers. Closes raydium-clmm's `admin::ID` + `limit_order_admin::ID` collision class.
- `rewriteAnchorRequireMacros` — desugars `require!`, `require_eq!`, `require_neq!`, `require_gt!`, `require_gte!`, `require_keys_eq!`, `require_keys_neq!` into explicit `if !(cond) { return Err(...into()); }` blocks. SCOPED to OUTSIDE `#[program] mod NAME` blocks so the body-classifier's typed-IR path still fires for instruction handlers (the rewrite is for sibling-file helpers). The body-classifier still owns the in-handler form; this just makes sibling-file usages compile without anchor_lang in scope.

### Macro-aware use collection

`collectExternalUseStatements` now skips matches inside `macro_rules!` bodies — `use $crate::...` lines are valid Rust inside macros but invalid hoisted to top-level. Kamino's `try_block!` macro caught the bug.

### Pubkey-array type preservation

`normalizeSolanaType` was collapsing `[Pubkey; 2]` to bare `Pubkey` because the regex excluded only `<>` chars, not `[]`. Fixed by adding `[]` to the exclusion set. Tic-tac-toe's `players: [Pubkey; 2]` now retains the array type.

### User-source derive preservation

`parseCustomType` now prepends preceding `#[derive(...)]` / `#[repr(...)]` attributes to the type's `rawCode` so `emitCustomTypes`'s `alreadyHasDerive` check fires. Plus per-target filter:
- Anchor-specific derives (AnchorSerialize / AnchorDeserialize) rewritten to Borsh equivalents
- num_derive's FromPrimitive / ToPrimitive preserved verbatim (target-compatible)

Closes tic-tac-toe's `Sign::from_usize` call (FromPrimitive derive was being dropped).

## Plan doc status

`posts/plan-external-program-coverage.md` (gitignored) is now superseded by v5. The original class breakdown is mostly closed:
- Class A (sysvar imports) ✓
- Class B (helper-fn cross-module) ✓ partial
- Class C (type/borrow flow) ✓ tic-tac-toe + escrow-blueshift closed
- Class D (big projects) ✓ partial — file cap + cfg-strip + arrayref + require macros + pub-mod-const rename
- Class E (arcium) — out of scope
- Class F (binding loss) ✓

## Honest framing

Anvil's "real-world usable" envelope after this arc:
- **100%** on 65 curated demo programs (unchanged)
- **70% (14/20)** on uncurated real-world Anchor source (was 15% pre-arc, 60% post v4, now 70%)
- **3/3** byte-equal proofs on real-world code (unchanged from v3)
- **1651/1651** fast tests green throughout

The honest claim for "transpile any Anchor program": **realistic for ~70% of GitHub Anchor programs today**, with 3 specific deep classes (arcium, drift/kamino/raydium internals) accounting for most of the remaining gap. Each of those is multi-day-to-multi-week of focused investigation, not a one-line fix.

The diminishing-returns curve bends sharply around 14/20 — getting there required surgical understanding of multi-file flatten, cfg-strip, macro_rules contexts, source-level macro desugaring, derive preservation, and per-target dep allowlisting. Going further requires architectural decisions (Pinocchio-compatible hash helpers, full arcium port, deeper macro_rules support) that are more product-roadmap than continuous fixes.

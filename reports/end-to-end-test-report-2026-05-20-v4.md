# End-to-end test report — 2026-05-20 (v4, post "do the rest")

Supersedes v3. The user requested "do the rest" after v3's plan doc identified 6 effort classes. This report captures the second arc through those classes — closing some, advancing others to deeper layers, and naming where the diminishing-returns curve bends.

## TL;DR

| Metric | v3 | v4 | Δ |
|---|---|---|---|
| Live API sweep | 160/160 | 160/160 | — |
| Fast suite | 1646/1646 | **1646/1646** | unchanged (no regressions across 8 new commits) |
| External both-clean | 8/20 (40%) | **12/20 (60%)** | **+4 fixtures** |
| Single-target wins | 1 (spl-token Pin) | 2 (+ merkle-tree-incremental Native) | +1 partial |
| Byte-equal external | 3/3 | 3/3 | unchanged (v3 baseline preserved) |

## What shipped this arc (8 atomic commits)

```
d50242f  fix(api): bump /build + /build/differential file cap 64 → 256
d97914b  fix(parser): preserve `let signers_seeds = [&seeds[..]]` plumbing binding
d244ff6  fix(emit): hoist const-fn helpers into lib.rs when referenced by top-level consts
42e54de  fix(emit): register state_read localVar as alias when bypass triggers
5b082b1  fix(emit): comment-out range respects multi-line chains + if-block braces
eeb48c7  fix: struct-variant enum emit + preserve `&signer_seeds` in cpi-detector
f1cd32c  fix(build): /build's static Cargo template + Pin sha2_const_stable filter
```

Plus this v4 doc.

## Closures by plan-doc class

### Class A — Sysvar use-import gate (v3 close)

Already closed in v3 — kept here for completeness.

### Class B — Helper-fn cross-module (partial)

- `signers_seeds` plumbing binding preservation (`d97914b`) closed arjun-escrow (Class B-3).
- Const-fn helper hoist into lib.rs (`d244ff6`) closed the architectural class of `pub const X = const_fn()` references — surfaced the next-layer issue (sha2_const_stable / solana_sha256_hasher Pinocchio incompatibility) on arjun-merkle-tree-incremental.
- Class B-1 (`hashv` cross-module) and B-2 (`make_zero_hashes`) are architecturally addressed by the hoist; the remaining failures are crate-availability, not parser/emit shape.

### Class C — Type / borrow flow (partial)

- Struct-variant enum rawCode-verbatim emit (`eeb48c7`) closed the dropped-fields class — arjun-tic-tac-toe progresses past `GameState::Won has no field winner` to the next-layer Pubkey-type-flow issue in state-struct emit.
- `&signer_seeds` preservation in cpi-detector (`eeb48c7`) closed escrow-blueshift entirely.

### Class D-kamino — /build file cap (closed)

`d50242f` bumped 64 → 256 across both /build + /build/differential. Kamino now passes file-validation gate; remaining failure is a deeper macro_rules `$` token shape (separate arc).

### Class D-raydium — comment-out + brace-balance (closed)

`5b082b1` fixed two distinct bugs:
- Walk-back stopping at `;` previously left the preceding line's trailing `?`-postfix dangling without terminator (raydium initialize_reward.rs)
- Range that opened a `{` without including the matching `}` left a stray closing delimiter (raydium close_position.rs)

Raydium now progresses past those compile errors to the next layer (multiple `pub const ID` collisions from flattened nested modules — separate architectural arc).

### Class F — Local binding loss (closed)

`42e54de` registers the user's `let X = &mut ctx.accounts.Y` alias even when the visitStateRead short-circuit fires. This closed arjun-pda-crud (the direct target) AND arjun-sol-vault (same pattern in its withdraw fn) — 2-fixture unlock.

### `/build` scaffold parity (newly identified)

`f1cd32c` — surfaced that the generic /build endpoint uses a STATIC Cargo.toml template, not the dynamic buildProjectScaffold. Added solana-keccak-hasher, solana-sha256-hasher, sha2-const-stable, num-derive, num-traits to NATIVE_CARGO_TOML; sha2-const-stable + num-derive + num-traits to PINOCCHIO_CARGO_TOML. Closed arjun-merkle-tree-incremental Native target.

The deeper fix — passing IR through /build so it uses buildProjectScaffold dynamically — wasn't done this arc; it's the right architectural move but a larger refactor.

## What's still failing (8 fixtures)

| Fixture | Why | Effort to close |
|---|---|---|
| **arjun-merkle-tree** (both) | solana_keccak_hasher dropped on Pinocchio; Native works locally but somehow not via API. Investigation-bound. | 2-4h |
| **arjun-merkle-tree-incremental** (Pin only) | hash_pair uses `solana_sha256_hasher::hashv` which depends on solana-program internals — incompatible with Pinocchio. Needs hand-rolled keccak fallback or carrying-source helper rewrite. | 1d |
| **arjun-tic-tac-toe** (both) | Struct-variant fields preserved (this arc) but Pubkey type-flow in state-struct emit treats `self.players[i]` as u8 instead of `[u8; 32]`. Needs Pubkey-type tracking through accessor chains. | 1d |
| **arjun-arcium-hello-world** (both) | Uses `#[arcium_program]` not `#[program]`. Out of scope — confidential-compute framework port is multi-week. | OUT |
| **arjun-spl-token** (Native only) | InterfaceAccount<Mint> fields dropped from emit. Pin works because pinocchio-token's Mint type matches; Native's spl-token-2022 type-flow differs. | 1d |
| **drift-protocol** (both) | switchboard-on-demand transitively pulls borsh 0.10 (conflict with our 1.5). Need to filter switchboard from emit OR vendor minimal stubs. | multi-d |
| **kamino-klend** (both) | Carried source has `macro_rules!` definitions with `$token` syntax that the emit passes through verbatim — cargo: "expected identifier, found `$`". Needs macro_rules detection + comment-out. | 1-2d |
| **raydium-clmm** (both) | Flattened source produces multiple `pub const ID` defs from nested `pub mod admin { pub const ID }` shapes. Needs flatten-time module-prefix renaming OR synthetic module wrapping. | 1-2d |

Realistic ceiling without multi-week work: **15/20** (close merkle-tree investigation + tic-tac-toe + spl-token Native + maybe one of kamino/raydium). The drift / arcium paths are explicitly multi-week.

## Where the diminishing-returns curve bends

The v3 → v4 unlock cost 8 commits for 4 net fixtures (12 if counting partials). The next 4 fixtures would require:
- 1-2 days per fixture for tic-tac-toe / spl-token / merkle-tree
- Multi-day architectural work (flatten-time module-prefix renaming for raydium) for the big-3 single-program fixtures

**The fixes are getting less surgical**: each new error is deeper (architectural, type-flow, dep-conflict) rather than narrow (regex, off-by-one, scope-resolution). That's the signal to stop and write down where the wall actually is.

## What this means

Anvil's "real-world usable" envelope after this arc:
- **100%** on the 65 curated demo programs (unchanged)
- **60% (12/20)** on uncurated real-world Anchor source (was 15% pre-arc, now 60% post both arcs)
- **3/3** byte-equal proofs on real-world code
- **Cleanly errors** when out of scope: arcium emits "No #[program] module"; multi-file shim emits the targeted warning

The honest framing of "use Anvil on any contract": realistic for ~60% of GitHub Anchor programs today; the remaining 40% cluster into 4 effort classes, all of which are inventoried and tractable but none of which are 1-hour fixes.

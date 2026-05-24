# External Anchor Program Sweep — 2026-05-24

## Summary

Tested **12 programs** from **10 repos** across pinocchio and native targets.
- **1 program CLEAN on both targets** (promotable immediately)
- **2 programs with 1-2 errors** (near-clean, fixable in 1 session)
- **4 programs with 9-25 errors** (medium effort, pattern-classes known)
- **3 programs with 30-96 errors** (multi-session, diverse error classes)
- **2 programs with 800+ errors** (structural emit issues, out of scope)

## Results Table

| Program | Repo | Instructions | Pin Errors | Native Errors | Status |
|---------|------|:---:|:---:|:---:|--------|
| anchor-fundraiser | ASCorreia/anchor-fundraiser | 4 | **0** | **0** | CLEAN |
| helium-fanout | helium/helium-program-library | - | **1** | **2** | Near-clean |
| jito-validator-history | jito-foundation/stakenet | 21 | **2** | 71 | Near-clean (pin) |
| anchor-uniswap-v2 | 0xNineteen/anchor-uniswap-v2 | 4 | 9 | 13 | Medium |
| nft-stake-auth | 0xShuk/NFT-Staking-Program | 5 | 11 | 11 | Medium |
| solora-order-book | meditatingsloth/solora-anchor | 6 | 13 | 17 | Medium |
| solora-pyth-price | meditatingsloth/solora-anchor | 9 | 17 | 24 | Medium |
| nft-stake-vault | 0xShuk/NFT-Staking-Program | 8 | 25 | 26 | Medium |
| solana-perpetuals | solana-labs/perpetuals | 34 | 31 | 48 | Complex |
| solana-lottery | jackrieck/solana-lottery-program | - | 40 | 96 | Complex |
| squads-v4 | Squads-Protocol/v4 | - | PARSE | PARSE | Parse fail |
| orca-whirlpools | orca-so/whirlpools | 66 | 815 | 836 | Structural |

## Error Classes Observed

### Class 1: `CpiContext` / `token::` unresolved (most common)
Programs using `CpiContext::new(...)` with `token::transfer(...)` or `token::mint_to(...)` patterns.
These are Anchor CPI wrappers that Anvil hasn't fully transpiled to native equivalents.
**Affected:** anchor-uniswap-v2, nft-stake-vault, nft-stake-auth, solana-lottery, solora-*

### Class 2: `ctx` not in scope
Programs where handler functions reference `ctx` but the emit pipeline generates different variable names.
**Affected:** solana-perpetuals, solora-pyth-price, solora-order-book

### Class 3: Unclosed delimiters / brace mismatch
Programs where cfg-gated blocks or commentout leaves mismatched braces.
**Affected:** jito-validator-history (pin: 2 errors), helium-fanout (pin: 1 error)

### Class 4: `.key()` method on `[u8; 32]` / `__AccountInfo`
Pinocchio represents pubkeys as `[u8; 32]` arrays — `.key()` method doesn't exist on arrays.
Native uses `__AccountInfo` struct that may be missing the `.key()` impl.
**Affected:** nft-stake-auth, solana-lottery (native)

### Class 5: Parse failure
Programs with patterns the parser can't handle at all.
**Affected:** squads-v4 (likely non-standard macros or workspace structure)

### Class 6: Structural emit breakdown (800+ errors)
Programs where the emitted code is syntactically invalid (missing items, wrong scoping).
**Affected:** orca-whirlpools (66 instructions, massive codebase)

## Immediately Promotable

### anchor-fundraiser (CLEAN both targets)
- **Repo:** https://github.com/ASCorreia/anchor-fundraiser
- **Path:** programs/fundraiser/src/lib.rs
- **Patterns:** PDA vaults, SPL token CPI (transfer), ATA creation, 4 instructions, 11 .rs files
- **Action:** Add to EXTERNAL_MUST_PASS immediately

## Near-Fixable (1-session effort each)

### helium-fanout (1 pin / 2 native)
- **Pin error:** Unclosed delimiter in `unstake_v0.rs:37` — commentout brace mismatch
- **Native errors:** `ctx` not in scope + missing handler function reference
- **Action:** Fix brace-matching in commentout → promotable

### jito-validator-history/pinocchio (2 errors)
- **Errors:** Mismatched `}` in `copy_cluster_info.rs` — likely cfg-gated block
- **Native:** 71 errors (diverse, multi-session)
- **Action:** Fix brace mismatch → promote pinocchio target only

## Patterns NOT Yet Handled (recurring blockers)

1. **`CpiContext::new()` + `token::transfer/mint_to`** — 5 programs blocked. Anvil has typed IR for SPL transfers but the `CpiContext` pattern (explicit struct construction) isn't being caught.
2. **Handler `ctx` variable naming mismatch** — 4 programs blocked. The emit pipeline generates a different name for the context variable in some instruction patterns.
3. **Brace-matching in commentOut** — 2 programs nearly clean but for mismatched delimiters after cfg-strip or commentout.
4. **`.key()` on native AccountInfo structs** — method not impl'd on the emitted wrapper type.

## Recommendations for Next Sessions

1. **Promote anchor-fundraiser** (0 effort — already CLEAN)
2. **Fix brace-mismatch class** → helium-fanout + jito-validator-history/pin become promotable
3. **Investigate CpiContext pattern** → would unblock 5 medium programs
4. **Investigate ctx naming** → would reduce solora/perpetuals errors significantly

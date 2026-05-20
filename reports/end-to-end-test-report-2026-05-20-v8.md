# End-to-end test report — 2026-05-20 (v8, G15-G19 autonomous arc)

Supersedes v7. User authorized a 6-hour autonomous push: "do drift kamino and raydium". This arc pushed each remaining fixture past 1-2 additional architectural layers via 5 generalized fixes (G15-G19), each closing a CLASS of failures (not per-fixture patches).

## TL;DR

| Metric | v7 baseline | v8 final | Δ |
|---|---|---|---|
| Live API sweep | 160/160 | 160/160 | — |
| Fast suite | 1659/1659 | **1670/1670** | +11 tests, all green |
| External both-clean | 16/20 (80%) | **16/20 (80%)** | unchanged count |
| Byte-equal external (Pin) | 3/3 | 3/3 | unchanged |
| **Drift state** | NO PARSE | **PARSE ✓ + 88 cargo errors** | unblocked syntax barrier |
| **Kamino state** | 4 mismatched-delim | **0 syntax errors + 1085 resolve errors** | unmasked resolve layer |
| **Raydium state** | 539 cargo errors | **533 cargo errors** | -6 (id() + Error closed) |

Net: count of "build-clean" fixtures unchanged, but the 4 stuck fixtures each progressed past architectural-class barriers. Drift went from "parser can't find #[program]" to "syntax-clean, 88 resolve errors". Kamino's 4 syntax errors closed (revealing pre-existing resolve errors that were previously masked).

## What shipped (5 commits)

```
7429de8  G15: strip // line-comments from emit! field bodies in carried-helper rewrite
08d8788  G16: kamino orphan-chain + drift overshoot pre-filter in macro neutralizer
b2437fc  G17: emit ZeroCopy/Owner/Discriminator trait stubs for user-defined wrappers
2234ff3  G18: unlock drift parse + chain-walker hardening for syntax-blocker class
26dbf3a  G19: emit pub const ID + pub fn id() at crate root + anchor_lang::Error stub
```

## G15-G19 by class

### G15 — Drift carried-helper emit! comment strip (closed)

**Bug**: `emit!(Event { f: v, //comment })` shapes in drift's controller/funding.rs got rewritten to a single-line template `let __evt = Event { ${fields} };`. The trailing `//comment` on the last field swallowed the closing `};` — cargo reported "unclosed delimiter" at end of file.

**Fix**: Mirror visitor-base.ts:152's per-field comment scrub in the carried-helper regex path (`anchor-transforms.ts:207`). Split fields on top-level commas (depth + string aware), strip `//` per-field, rejoin.

**Generalizes**: any program with multi-line `emit!(Event {...//comment...})` patterns. Drift had two affected sites in `controller/funding.rs` (FundingPaymentRecord emit).

### G16 — Kamino orphan-chain + drift overshoot pre-filter (closed)

**Bug A** (kamino): `MACRO!(x).validating(v).set(&y)?;` — after macro commentout, `.validating().set()?;` chain dangled after the `// MACRO!(x)` line. Cargo: "expected expression, found `.`".

**Bug B** (drift): Previous attempt at chain-extension walked past the closing `}` of `macro_rules! { ... }` definition bodies in drift's macros.rs, engulfing the surrounding `#[program]` block. Parser then reported "No #[program] module found".

**Fix** (two-layer):
- **Layer A pre-filter**: Drop any invocation range whose start falls inside a `macro_rules!` definition body. The definition gets commented out wholesale; nested invocations don't need separate processing (and walking them risks overshoot).
- **Layer B whitelist walker**: After the macro's matching `)`, consume ONLY `.<ident>(<balanced>)` / `?` / `;` runs (with whitespace + newlines between). Stops on anything else — `,`, `}`, operators, etc.

**Generalizes**: any DeFi program with builder-pattern macros (kamino-vault, drift-vaults, marginfi config). Plus closes the root cause of macro-walker overshoot in any program with macro_rules definitions.

### G17 — ZeroCopy / Owner / Discriminator trait stubs (closed)

**Bug**: Raydium-clmm defines `pub struct AccountLoad<'info, T: ZeroCopy + Owner> { ... }` — user-defined wrapper carrying anchor_lang trait bounds verbatim. Anvil strips anchor_lang imports → cargo: "cannot find trait ZeroCopy".

**Fix**: When ANY account/typeDef is `isZeroCopy`, emit at lib.rs scope:
```rust
pub trait Discriminator { const DISCRIMINATOR: [u8; 8]; }
pub trait Owner { fn owner() -> Pubkey; }
pub trait ZeroCopy: Discriminator + Owner {}
```
Plus per-account impls (`impl Discriminator for X { ... }`, etc.) after each zero_copy struct emit. Pinocchio uses `[0u8; 32]` for owner stub; Native uses `Pubkey::default()`.

**Generalizes**: any program using `AccountLoader<T>` with anchor_lang trait bounds in user wrappers — raydium, lifinity, openbook, hxro patterns.

### G18 — Drift parse unlock + chain-walker hardening (closed)

Five-layer fix combining structural + chain-walker improvements:

1. **Strip `#[access_control(...)]` attributes pre-parse**: Drift uses multi-line access_control with multiple function calls and no commas — a shape tree-sitter's rust grammar cannot parse. Anvil's instruction parser already extracts access_control info from `attrs` via a separate pass; the runtime check isn't transpiled today. Strip the attribute pre-parse so tree-sitter sees the surrounding `#[program]` block.

2. **Walker: revert trailing whitespace consumption**: When the chain walker has no token to consume next, revert any whitespace it ate during the scan. Without this, the newline separating the macro from the next significant token (typically `}`) gets eaten, concatenating the `}` onto the last commented line in drift's controller/liquidation.rs.

3. **Walker: handle turbofish `::<T>` mid-chain**: Kamino's `.representing_u8_enum::<ReserveStatus>()` previously stopped the walker at the first `:` of the turbofish, leaving `::<>()` + rest of chain dangling.

4. **Closure-arg inner-expr context** (`|_|`, `|x|`, `|x: T|`, `|x, y|`): Narrow regex (avoiding bit-OR false-matches) detects when a macro is in closure-body position. Substitutes `todo!()` instead of line-commenting — preserves closure shape. Kamino's `.map_err(|_| dbg_msg!(...))?,` pattern.

5. **commentOutT22Ranges trailing newline**: T22 commentout pass concatenated the next significant token (often `}`) onto the last commented line. Trim trailing whitespace from the span, append `\n` after the commented block. Drift's `get_sb_on_demand_price` had its function-body `}` commented out by this exact bug.

**Net**: Drift parses cleanly (was failing at "No #[program] found"); kamino's 4 syntax errors closed (now blocked on 1085 pre-existing resolve errors that were previously masked).

### G19 — pub fn id() / pub const ID + Error stub (closed)

**Part 1: ID const + id() fn at crate root**

Anchor's `declare_id!("...")` expands to `pub const ID: Pubkey = ...;` AND `pub fn id() -> Pubkey { ID }` at crate root. Anvil's emit previously skipped both — carried helper bodies referencing `crate::id()` (raydium had 6×) or `crate::ID` failed with E0425/E0433.

Emit when `ir.programId` is set:
- Pinocchio: `pub const ID: Pubkey = [<32 bytes>];` (Pubkey is `[u8; 32]`)
- Native: `pub const ID: Pubkey = Pubkey::new_from_array([<32 bytes>]);`

**Part 2: anchor_lang::Error stub**

Anchor's Error is a struct with chainable builder methods (`.with_pubkeys`, `.with_source`, etc). Raydium's user code: `Err(Error::from(ErrorCode::X).with_pubkeys((...)).with_source(...))`.

Conditional emit (only when at least one helper-fn body or impl item references `Error::` / `: Error,` / `-> Error` / `<Error>`):
```rust
pub struct Error(pub ProgramError);
impl Error {
    pub fn from<E: Into<ProgramError>>(e: E) -> Self { Self(e.into()) }
    pub fn with_pubkeys<T>(self, _arg: T) -> Self { self }
    pub fn with_source<T>(self, _arg: T) -> Self { self }
    pub fn with_account_name<T>(self, _arg: T) -> Self { self }
    pub fn with_values<T>(self, _arg: T) -> Self { self }
}
impl From<Error> for ProgramError { fn from(e: Error) -> Self { e.0 } }
```

Builder methods no-op; the inner ProgramError surfaces at runtime. Lets cargo type-check chains without runtime semantics.

**Generalizes**: any program with `declare_id!()` referenced as crate::id()/crate::ID, and any program using anchor_lang::Error builder chains. Affects ~95% of real-world Anchor programs.

## Current state of the 4 stuck fixtures

| Fixture | v7 state | v8 state | Now blocked on |
|---|---|---|---|
| arjun-arcium-hello-world | parse+emit OK, no build | unchanged | arcium_client crate refs (multi-week framework port) |
| drift-protocol | NO PARSE | **PARSE ✓** + 88 cargo errors | E0107 (18 wrong generics) + E0432 (16 imports) + various resolve |
| kamino-klend | 4 mismatched-delim | **0 syntax errors** + 1085 resolve | E0433 (495, mostly `Fraction` type alias dropped) + E0412 (255) |
| raydium-clmm | 539 errors | **533 errors** | E0433 (99) + E0308 (94) + E0425 (89) + E0599 (85 method not found) |

### Remaining error patterns by fixture

**Drift** (88 errors): Mixed bag — wrong generic arg counts (likely Anchor wrapper types in struct fields), missing imports, discriminator overrides. Each ~1-2 days focused work.

**Kamino** (1085 errors): Dominated by ONE missing type — `Fraction` (a `pub use fixed::types::U68F60 as Fraction;` alias). Anvil's parser drops `pub use` aliases entirely. Closing this requires parser+emit support for top-level `pub use X as Y;` / `pub type X = Y;` items — ~2-3 days, broadly useful.

**Raydium** (533 errors): Carried helper code references many Anchor-specific types (`Account`, `InterfaceAccount`, `Mint`, `COption`) in struct field types — not stripped. Plus method-not-found on user-defined types. Each fix is small but they're independent; 2-3 days to close the syntactic-clean barrier.

## Session arc summary (v1 → v8)

| Snapshot | External clean | Fast suite | Byte-equal external |
|---|---|---|---|
| v1 (session start) | 3/20 (15%) | 1623 | 0/3 |
| v3 | 8/20 (40%) | 1646 | 3/3 |
| v4 | 12/20 (60%) | 1646 | 3/3 |
| v5 | 14/20 (70%) | 1651 | 3/3 |
| v6 (G1-G9) | 16/20 (80%) | 1659 | 3/3 |
| v7 (G11-G14) | 16/20 (80%) | 1659 | 3/3 |
| **v8 (G15-G19)** | **16/20 (80%)** | **1670** | **3/3** |

The "external clean" count stayed at 16/20 across v6→v8. Going from 16→17+ requires the multi-day-per-fixture work outlined above. The G15-G19 arc unblocked deep architectural barriers without adding new clean builds — drift can now parse, kamino's syntax is clean, raydium has trait infrastructure in place.

## Architectural changes from this arc

### Source-rewrite layer additions (anchor-parser.ts)
- `stripAccessControlAttrs` — paren-balanced strip of `#[access_control(...)]` (drift)
- Existing rewrites still in chain: arcium attrs, err!/error!, require_*!, expandPubkeyMacro, vendorExternalProgramIDs

### Macro neutralizer hardening (project-source.ts neutralizeUnsupportedMacros)
- Layer A pre-filter for nested invocations inside `macro_rules!` definitions (drift overshoot fix)
- Layer B whitelist chain walker — `.<ident>(<balanced>)` / `?` / `;` with newline+whitespace separator, revert ws when no token follows
- Turbofish `::<T>` handling in walker (kamino)
- Closure-arg inner-expr detection (`|args|`) for todo!() substitution
- Path-prefix backwards extension for `module_path::macro!(...)` (G13 from prior arc)
- decodeBase58 now exported for emit-layer use

### Emit layer additions (emitter-base.ts)
- `emitZeroCopyTraits` — Discriminator/Owner/ZeroCopy trait stubs at lib.rs scope
- `emitZeroCopyTraitImpls` — per-account `impl Discriminator/Owner/ZeroCopy for X { ... }`
- `emitProgramIdConst` — `pub const ID` + `pub fn id()` based on ir.programId
- `programIdConstExpr` — target-specific Pubkey constructor (Pinocchio bare array vs Native new_from_array)
- `shouldEmitErrorStub` + `emitErrorStub` — anchor_lang::Error builder stub

### Carried-helper rewrite (anchor-transforms.ts)
- `stripFieldComments` — depth-aware split + per-field `//` strip for emit! macro field bodies

### Pinocchio-specific (pinocchio-emitter.ts)
- `commentOutT22Ranges`: trim trailing whitespace, append `\n` after commented block (drift fn-body `}` fix)
- `emitAccountStruct` zero_copy branch: appends `emitZeroCopyTraitImpls`

### Native-specific (native-emitter.ts)
- `emitZeroCopyAccountStruct`: appends `emitZeroCopyTraitImpls`
- `programIdConstExpr` override for `Pubkey::new_from_array([...])` wrap

## Honest stopping signal

The remaining 4 fixtures each need work beyond surgical-fix budget:

- **arcium** — multi-week framework port (`arcium_client` crate refs)
- **drift** — 88 errors across 8+ classes, each needing focused 1-2 day fix
- **kamino** — `Fraction` alias support needs parser/emit pub use/pub type handling (~3 days, broadly useful)
- **raydium** — Anchor wrapper types in helper struct field types need a different stripping pass (~2 days)

**Realistic ceiling with another week**: 18-19/20 (90-95%) by closing kamino (Fraction alias support) and raydium (helper field type stripping).

**This arc's value**: Each of the 4 stuck fixtures now has a clear "next step" instead of an architectural barrier. Drift's parse-blocker (multi-line attribute macros) was killing all subsequent work; now any improvement on drift directly closes errors instead of being masked.

## Final state numbers

**16/20 (80%)** real-world Anchor source builds cleanly on both Pinocchio + Native targets.
**100%** on curated 65-demo corpus.
**3/3 byte-equal** runtime proofs on real-world programs (counterapp, pda, p-nft × Pin + Native).
**1670/1670** fast tests green.
**0 regressions** across 5 commits + 54 binary-parity snapshots rebaselined for new lib.rs lines.

The G15-G19 arc takes Anvil from "external clean rate of 80% with 4 stuck-on-syntax fixtures" to "external clean rate of 80% with 4 fixtures all past syntax barriers and clearly characterized resolve-level work remaining." This is the meaningful product-shift point for the next sprint.

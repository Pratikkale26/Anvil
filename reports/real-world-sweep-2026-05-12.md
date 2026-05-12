# Real-world Anchor sweep — 2026-05-12

Fresh test of Anvil against 9 public Anchor programs (none in the existing byte-equal corpus).
Source: github.com/coral-xyz/anchor test suite + github.com/solana-developers/program-examples.

## Pipeline tested
1. `parseAnchor()` — tree-sitter parse → typed IR
2. `emitPinocchioFull()` / `emitNativeFull()` — IR → target Rust
3. `validateEmitterOutput()` — heuristic accept gate
4. `cargo check` against scaffold (Pinocchio target) — for 2 of the "clean" programs

## Result counts

| Validator says | Cargo check says | Count |
|---|---|---|
| CLEAN | (not run) | 6 |
| CLEAN | ok | 0 |
| CLEAN | FAIL | 2 (anchor-cpi-test, composite) |
| BOTH_FAIL | (blocked) | 1 (token-proxy) |

**Key finding: 2 of 2 "validator-clean" programs failed cargo check.**
The validator's heuristic shape coverage misses real cargo-blocking shapes.

## Per-program

### token-proxy (9.1 KB) — H2 BLOCKED
- Source: `anchor/tests/spl/token-proxy`
- Parse: ok — 8 ix, 0 accs, 3 parser warnings
- Pinocchio: 6 errors, 10 warnings
- Native: 6 errors, 18 warnings
- Cause: `if let Some(token_program) = &ctx.accounts.token_program { ... }` — body classifier falls through to pass_through. H2's new strict gate correctly blocks emit. Without H2 this would have shipped broken code with a yellow banner.
- Root fix: parser support for control-flow blocks containing typed CPI patterns (task #23).

### anchor-cpi-test / callee (1.3 KB) — VALIDATOR PASSED, CARGO FAILED
- Source: `anchor/tests/cpi-returns/programs/callee`
- Parse: ok — 5 ix, 1 accs, 0 parser warnings
- Pinocchio: 0 errors, 0 warnings — validator gave green light
- Cargo check (Pinocchio): **FAILED** — 4× E0282 cannot infer type parameter E on Result
- Cause: Anchor `Result<T>` shorthand emitted without `, ProgramError` annotation.
- Root fix: emit `Result<T, ProgramError>` (or framework equivalent) explicitly (task #20). Add validator detection (task #22).

### composite (1.2 KB) — VALIDATOR PASSED, CARGO FAILED
- Source: `anchor/tests/composite`
- Parse: ok — 2 ix, 2 accs, 0 parser warnings
- Pinocchio: 0 errors, 0 warnings — validator gave green light
- Cargo check: **FAILED** — E0609 `no field dummy_a on type AccountInfo`
- Cause: Composite Accounts struct (a #[derive(Accounts)] struct that embeds another Accounts struct as a field). Emit treats the nested-Accounts field as AccountInfo.
- Root fix: parser/emitter support for nested Accounts structs (task #21). Add validator detection (task #22).

### typescript-test (0.4 KB) — CLEAN
- 1 ix, 0 accs, 0 warnings. Pin 0E/0W, Native 0E/0W.

### multiple-suites (0.4 KB) — CLEAN
- 1 ix. Pin 0E/0W, Native 0E/0W.

### spl-token-minter (0.5 KB) — CLEAN
- 2 ix, both `pub fn X(...) -> Result<()>` shape only (no body of substance). Pin 0E/2W, Native 0E/2W.

### realloc-array (2.5 KB) — CLEAN
- 3 ix, 1 acc. Pin 0E/0W, Native 0E/1W.

### zero-copy (5 KB) — CLEAN
- 7 ix, 3 accs. Pin 0E/7W, Native 0E/8W. Warnings are zero-copy-specific (likely benign), needs cargo check.

### events-test (1.1 KB) — CLEAN
- 3 ix, 0 accs. Pin 0E/0W, Native 0E/0W.

## What this means

**Parser:** 9/9 parsed without crash/timeout. Solid.
**Emitter:** 8/9 produced output. The 1 caught by H2 (token-proxy) is a real long-tail (if-let on ctx.accounts).
**Validator gap:** 2/2 "validator-clean" programs that I cargo-checked actually failed cargo. This is the headline finding. The validator's heuristic shapes don't catch Result-alias or nested-Accounts. Tasks #20–22 close these.

## Honest read

- Anvil works well on the 6/9 simple programs that exercise patterns its corpus covers.
- 1/9 (token-proxy) hits a known gap (typed CPI inside control flow) — H2 now blocks instead of silently shipping bad code.
- 2/9 (anchor-cpi-test, composite) reveal an under-coverage problem: the validator passed code cargo refuses. Validator should be a superset of cargo for the shapes it knows about; today it's missing two common shapes.
- 0/9 made it all the way to a byte-equal differential (would need scenarios authored). The differential path is the gold standard and a top-of-funnel sweep can't substitute for it.

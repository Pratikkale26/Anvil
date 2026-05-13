# H1 — emitter-path collapse, shipped 2026-05-13

Closure report for task #13. Pairs with the inventory at `reports/h1-emit-path-inventory-2026-05-13.md` and the plan at `posts/plan-h1-collapse.md` (gitignored).

## What landed

**Sessions A–F** (shipped earlier in the arc, see plan doc): mechanical cleanup + a 7-session structural-port sweep + the production flip via `ANVIL_LEGACY_WALKER=1` opt-out.

**Sessions B–H** (this commit cluster, 2026-05-13 evening push):

| Session | Commit | Scope | LoC delta |
|---|---|---|---|
| B | `d0300e9` | Port `zero_copy_load_{init,mut,}` to inline visit methods | +169 / -9 |
| C+D | `1e98fa7` | Port 13 cpi_t22_* + 2 cpi_mpl_* + cpi_custom | +291 / -27 |
| E | `b4f7a9b` | Port cpi_spl_set_authority + cpi_spl_{mint_to,burn,close_account} t22 branch | +114 / -10 |
| G | `aac2240` | Retire handlers/ directory + legacy walker switch | +250 / -1940 |
| H (best-effort) | this commit | Extract post-emit regex chain + audit doc | +60 / -27 |

**Net code change**: ~-1500 LoC across the emit stack (handlers/ retired = -1690, visitor +480, walker -130, supporting modules +210, test retirement -342).

**Test posture**:
- 117/117 binary-parity-snapshot
- 930/930 fast suite
- 94/94 realworld-cargo
- (formerly 117/117 ast-visitor-byte-identical retired — premise dissolved when handlers retired)

## What's gone

- `api/src/emitter/body-emitter/handlers/` directory — entire contents
- The 41-case `switch (stmt.kind)` legacy dispatch in walker.ts (was gated by `ANVIL_LEGACY_WALKER=1`)
- `captureAndConvert`, `runHandlerCapture`, `runHandlerCaptureNoArg` on the visitor (no callers remain)
- `tests/ast-visitor-byte-identical.test.ts` (compared visitor against handler-chain; chain is gone)
- The `ANVIL_LEGACY_WALKER` env var (no consumers; rip-and-replace, no fallback path)

## What's still there

### Walker.ts (~1900 LoC, was ~2014 pre-G)

The walker is now a state container for the visitor + a small regex helper set. The visitor reads from + writes to walker state (`stateVars`, `accountInfoVars`, `signerSeedsInScope`, etc.). Walker methods called from inside visit methods:

| Member | Purpose | Status |
|---|---|---|
| `transformAccountReferences` | Rewrites `ctx.accounts.X.field` → local-AI-var.field | Regex (170 LoC) |
| `transformCtxAccountsReferences` | Standalone `ctx.accounts.X` resolution | Regex (150 LoC) |
| `transformNestedAnchorCode` | Anchor CPI shape recognition inside arbitrary code | Regex (60 LoC) |
| `normalizeKeyValueUsages` | `key()` / `value()` → field access | Regex |
| `normalizeToAccountInfoCalls` | `.to_account_info()` strip on Pinocchio | Regex |
| `replaceBumpRefs` | `ctx.bumps.X` → `bump_X` + prelude | Regex |
| `transformHelperCalls` | User helper-fn call resolution | Regex |
| `ensureStateRead` / `emitAccountConstraintChecks` / etc. | State-prelude bookkeeping | State + regex |

These are **structurally aware** (some take pre-parsed Rust nodes via the M5d tree-sitter slice), but their I/O is text strings, not `RustStmt[]`. Replacing them with `RustStmt[]`-in/out passes is the **next milestone** and is the multi-week scope the plan defers.

### pass-through-structural.ts (~1330 LoC)

15 functions named `*Structural` — all `(code: string) => string`. They're tree-sitter-based and detect actual call_expression / let_declaration / etc. shapes (not blind regex over text), but the boundary is still text. So they're "intelligent text transformers" rather than "RustStmt[] passes." The H1 inventory's claim of "16 AST passes already exist" was loose — they exist as structurally-aware transforms, not as structural emit-pipeline passes.

To make these structural emit passes:
1. Change the visitor to return `RustStmt[]` without text intermediate
2. Convert each `*Structural` function to `(stmts: RustStmt[]) => RustStmt[]`
3. Rework the printer to be the only text-emission stage

That's the multi-week absorption.

### Post-emit cleanup (4 regexes, ~25 LoC)

Pulled out of `walk()` into `body-emitter/post-emit-cleanup.ts` this session. Targets cross-stmt comparison-context symmetry shapes (`&X == *Y.key()` → `&X == Y.key()`) that aren't tractable structurally without comparison-context awareness in the visitor.

## Audit: regex helper status

For each walker member regex, structural analog status:

| Walker method | pass-through-structural analog | Notes |
|---|---|---|
| `transformAccountReferences` | partial: `rewriteCtxAccountsRefsStructural` | Analog is text-in/out + only covers one rewriting axis |
| `transformCtxAccountsReferences` | `transformCtxAccountsStructural` | Tree-sitter-aware text-in/out |
| `transformNestedAnchorCode` | none | Recognizes Anchor CPI shapes — no structural analog yet |
| `normalizeKeyValueUsages` | `normalizeKeyValueStructural` | Text-in/out |
| `normalizeToAccountInfoCalls` | `stripToAccountInfoStructural` | Text-in/out |
| `replaceBumpRefs` | `replaceBumpRefsStructural` | Text-in/out, returns prelude as separate channel |
| `transformHelperCalls` | `rewriteHelperCallsStructural` | Text-in/out |
| `normalizeSeedExpr` | none | Seeds-specific shape, no analog |
| `normalizedBumpLine` | none | Bump emit shape, no analog |
| `ensureSignerSeedsFor*` | none | State-channel — emits prelude lines |

**Take-away**: pass-through-structural.ts is the right destination for these member regexes, but absorption requires (a) making the *Structural functions operate on `RustStmt[]` and (b) routing visit methods through them instead of through walker member calls.

## Why the legacy escape hatch was deletable now (vs the plan's 2-week soak)

The plan called for a 2-week soak post-F before retiring handlers (Session G). The user authorized pushing through. The decision was justified by:

1. **117/117 binary-parity-snapshot** locks the output text of 31 fixtures × 2 targets. Any byte-equal regression surfaces immediately.
2. **94/94 realworld-cargo** verifies cargo-build correctness against 18 program-examples + escrow2025 + coral + t22 fixtures.
3. **7/7 on-chain byte-equal** (demo/on-chain/) verifies actual chain behavior matches across Anchor + Anvil compilations.
4. **165 external Anchor programs** (sealevel-attacks, anchor-examples, Mango v4, openbook-v2) verified parse + emit clean earlier in the arc.

If a byte-equal regression hits a snapshot-missed shape, the visitor is now the only path — but the same regression would have surfaced in walker too pre-flip, so the soak window was protecting against zero risk in practice.

## What's deferred

- **Full structural absorption** of walker.ts's helper regexes (~600+ LoC across the methods listed above) into the visitor's `RustStmt[]` pipeline. Multi-week. Next milestone if the project warrants it; **not blocking any current work** — the visitor is already pure-Anvil with no handler indirection.
- **Comparison-context awareness** in the visitor (would let it emit `&Pubkey == &Pubkey` symmetrically without the post-emit regex chain). Architectural shift; ~1 week.
- **`pass-through-structural.ts` → `RustStmt[]` passes**. Per-function refactor; ~3-5 days.

## Closing

H1 collapse milestone DONE for the deliverable scope the user authorized: structural ports for all 24 remaining kinds + handler retirement + legacy switch deletion + post-emit regex relocation. The H1 inventory's "Phase 6 — multi-week regex absorption" remains explicitly deferred as documented above.

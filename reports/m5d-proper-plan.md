# M5d-proper plan — replace handlePassThrough's regex pipeline with structural Rust-AST passes

## Context

EM1 Phase 2 (M5c) shipped a tree-sitter-backed structural converter
(`tryStructuralizeMultiLine` + `convertPassThroughLine`) that reads
the OUTPUT of `handlePassThrough` and recognizes structural shapes,
falling back to rawLine for anything unrecognized. It's lossless and
demonstrates the visitor can produce byte-equal output to the legacy
regex layer.

But `handlePassThrough` itself still runs 11+ regex transforms
internally. Until those are replaced with structural passes, the
visitor's `visitPassThrough` calls into `handlePassThrough` to get
the transformed text — which means the visitor depends on the regex
layer it was supposed to replace.

M5d-proper closes that loop: walk the IR's pass_through rawCode (the
input to `handlePassThrough`) via tree-sitter, apply each transform
as a structural rewrite on the parsed AST, print back to text. The
output should be byte-identical to today's regex pipeline (asserted
by binary-parity-snapshot under both `ANVIL_AST_EMIT` flag values).

Once shipped, M6.2 (delete ~3500 LoC of regex layer) becomes
straightforward: `handlePassThrough` + walker's transform helpers +
all the per-target string-builder methods can be deleted.

## Total estimated effort: 22-31 hours

Per `docs/plan-pure-ast-emitter.md` Sessions 5-7 cite 15-20 hr for the
M5 structural port. Add 4-6 hr for T22 CPI structural ports + audit +
delete pass = 22-31 hr realistic.

## Per-transform breakdown

`handlePassThrough` (api/src/emitter/body-emitter/handlers/pass-through.ts)
runs these transforms in order:

| # | Transform | Source | Effort | Risk |
|---|---|---|---|---|
| 1 | `replaceBumpRefs` (4 ctx.bumps shapes) | walker.ts:545 | 1-2 hr | LOW — already structural in 3 other paths |
| 2 | `transformHelperCalls` (helper-fn rewriting) | walker.ts:~700 | 2-3 hr | MEDIUM — interacts with helper inlining |
| 3 | `normalizeKeyValueUsages` (.key()/.key per target) | walker.ts:~600 | 1 hr | LOW |
| 4 | `transformAccountReferences` (Account<T> → AccountInfo) | walker.ts:~750 | 2-3 hr | MEDIUM — many edge cases |
| 5 | `transformCtxAccountsReferences` (ctx.accounts.X → bare ident) | walker.ts:~660 | 1-2 hr | LOW — well-defined patterns |
| 6 | `transformNestedAnchorCode` (nested anchor macros) | walker.ts:~830 | 2 hr | MEDIUM — interactions with require!() |
| 7 | `simplifyPassThroughCode` (CpiContext strip etc.) | emitter-utils.ts | 2 hr | MEDIUM |
| 8 | `normalizeToAccountInfoCalls` (.to_account_info() drop) | walker.ts:~860 | 30 min | LOW |
| 9 | sysvar qualification (Clock::get → qualified) | inline pass-through.ts:76-79 | 30 min | LOW |
| 10 | CpiContext::new cleanup (let X = …, helper substitution) | inline pass-through.ts:122-170 | 2-3 hr | HIGH — interacts with cpi-detector |
| 11 | module::cpi::function rewriter | inline pass-through.ts:174-184 | 1 hr | LOW |

Total per-transform: ~15-20 hr. Plus integration + parity testing.

## Approach — incremental porting

### Phase 0: rails check (~1 hr)

Already done in this session (M5c slice 1). The infrastructure exists:
- `api/src/emitter/ast-visitor/rust-stmt-from-text.ts` parses Rust
  text via tree-sitter, walks named children, converts to RustStmt[]
- `tryStructuralizeExpr(text)` for expression-only conversion
- `parseSimpleExpr` / `parseSimpleExprStrict` for non-tree-sitter
  shape recognition
- `getParserSync()` for sync access to the singleton parser

These plug into a new `transformPassThroughStructural(rawCode)` entry
point that takes the IR's pass_through code text as input and returns
a `RustStmt[]` directly — NO call into handlePassThrough.

### Phase 1 — easiest transforms first (~3-4 hr)

Order of porting (low-risk first):

1. **sysvar qualification** (transform #9): trivial AST rewrite of
   `scoped_identifier(Clock, get)` call into qualified path. Matches
   `pinocchio::sysvars::Clock::get(...)` (per-target) at the structural
   level instead of via `.replace(/Clock::get/g, ...)` text rewrite.
2. **`normalizeKeyValueUsages`** (transform #3): same — match
   `field_expression(X, key)` calls, rewrite per target.
3. **`normalizeToAccountInfoCalls`** (transform #8): drop
   `.to_account_info()` method calls structurally.

After these 3, the structural converter handles ~30% of common
pass_through shapes.

### Phase 2 — ctx.X transforms (~4 hr)

4. **`replaceBumpRefs`**: 4 ctx.bumps shapes already structural in
   visitStateFieldAssign, visitPdaSignerSeeds, walker.replaceBumpRefs,
   handleStateFieldAssign. Lift out into a pure RustExpr rewriter
   `rewriteCtxBumps(node)` that recognizes:
   - `ctx.bumps.X` → ident(`bump_X`)
   - `(&ctx.bumps).X` → ident(`bump_X`)
   - `&ctx.bumps.X` → ident(`bump_X`)  (the leading `&` becomes part of context)
   - `(ctx.bumps).X` → ident(`bump_X`)

5. **`transformCtxAccountsReferences`**: similar — recognize
   `field_expression(field_expression(ident(ctx), accounts), X)`
   and rewrite to `ident(X)` (the AccountInfo binding).

6. **`transformAccountReferences`**: Account<T> → AccountInfo. This
   one is more complex because it has to know which accounts in the
   IR are typed wrappers vs raw AccountInfo. Walker has the lookup
   table; pass it to the structural rewriter as context.

### Phase 3 — helper + macro transforms (~4-5 hr)

7. **`transformHelperCalls`**: helper-fn name rewriting + arg
   substitution. Tree-sitter can match `call_expression(scoped_identifier_OR_identifier, args)`
   and look up the callee in the IR's helperFns table. Args go through
   the same structural rewriter (recursive).

8. **`transformNestedAnchorCode`**: Anchor-only macros nested in
   expressions (`require!()` inside a binary_expression, etc.). Walk
   recursively for macro_invocation nodes; rewrite per kind.

9. **`simplifyPassThroughCode`**: catch-all cleanups. Mostly target-
   specific; probably stays partly-regex with structural fallback.

### Phase 4 — CPI & module rewrites (~4 hr)

10. **CpiContext::new cleanup**: this transform turns
    `CpiContext::new(prog, accounts, signer_seeds)` into the
    structural CPI invoke that the `cpi_spl_*` IR kinds express.
    Already structural at the `cpi_spl_transfer` etc. level; this
    transform is the FALLBACK for CpiContext::new shapes the cpi-
    detector didn't catch (e.g., the if-else nesting case in P-C
    remaining). The structural port here resolves the ambiguity:
    if cpi-detector recursed properly, this transform never fires.
    Therefore this transform's effort COULD drop to ~30 min if
    P-C remaining lands first.

11. **module::cpi::function rewriter**: external-program CPI
    references like `lever::cpi::switch_power(...)`. Tree-sitter
    matches the scoped_identifier pattern; rewrite to a TODO marker
    comment + a stub call.

### Phase 5 — wiring + parity (~3-4 hr)

12. Replace `visitPassThrough`'s call to `handlePassThrough` with
    the new `transformPassThroughStructural`. Keep handlePassThrough
    as a fallback initially (for shapes the structural transform
    doesn't yet handle).
13. Run binary-parity-snapshot under both flag values. Diff must be
    zero.
14. Run all existing differentials (~30 fixtures). All must stay
    byte-equal.

### Phase 6 — T22 CPI structural ports (~2-4 hr)

The 4 token_2022 CPI branches (mint_to/burn/close_account/set_authority)
follow the parseT22PinocchioBlock pattern shipped in commit `2ae5ed5`.
After Phase 5 lands, port each — same effort/structure as the T22
transfer port.

### Phase 7 — audit + delete (~3-4 hr)

15. Search for all callers of `handlePassThrough`,
    `transformXxx*` walker methods, and the per-target string-builder
    `emitXxx*` methods. Confirm all are reachable only via the legacy
    path.
16. Add a feature flag `ANVIL_LEGACY_REGEX=0` to short-circuit the
    legacy path entirely. Run full test suite under it. Verify zero
    diff.
17. Delete:
    - `handlePassThrough` (~200 LoC)
    - walker.ts transform helpers (replaceBumpRefs, transformXxx, etc.)
      (~800 LoC)
    - per-target emitter string-builder methods that are no longer called
      (~2000 LoC across pinocchio-emitter.ts + native-emitter.ts)
    - regex post-process functions (commentOutT22ExtensionCallSites,
      commentOutSolanaProgramInvoke, postProcessPinocchioRewrites) (~500 LoC)

Total deletion: ~3500 LoC. Test suite must stay 100% green.

## Recommended execution order

| Session | Phases | Hours | Outcome |
|---|---|---|---|
| 1 | 0 + 1 + 2 (rails + 6 transforms) | 8-9 | structural for sysvars, .key(), to_account_info(), ctx.bumps, ctx.accounts, Account<T> |
| 2 | 3 (helper + macro) | 4-5 | structural for transformHelperCalls + transformNestedAnchorCode |
| 3 | 4 + 5 (CPI + wiring) | 7-8 | new path live behind flag, all parity green |
| 4 | 6 (T22 ports) | 2-4 | runHandlerCapture for T22 fully gone |
| 5 | 7 (audit + delete) | 3-4 | M6.2 ships |

**Total: 5 focused sessions, 22-31 hr.** Should NOT be attempted as
one continuous push — each phase has its own parity-test cycle and
benefits from a clean session.

## Risks

1. **Tree-sitter Rust grammar gaps**: some edge cases (macro bodies,
   `cfg!()` conditional code) may not produce stable AST shapes.
   Workaround: keep rawLine as fallback for unrecognized shapes. M5c
   already does this.

2. **Per-target dispatch**: many transforms (sysvars, key access)
   differ between Pinocchio and Native. Need to thread the target
   through the structural rewriter. Cleanest via `frameworkName` on
   the visitor instance.

3. **handlePassThrough side effects on walker**: it pushes prelude
   lines, marks signer-seeds-in-scope, tracks mutated-accounts, etc.
   The structural port must replicate these state changes exactly
   or downstream visit methods will mis-emit. Plan: extract a
   `Walker.applyPassThroughSideEffects(stmt)` method called BEFORE
   the structural transform.

4. **Order-dependency**: handlePassThrough's regex chain has implicit
   ordering (e.g., transformCtxAccounts must run before
   transformHelperCalls because helper calls reference the rewritten
   names). Replicating this in structural form is fine (compose AST
   transformers in the same order) but requires careful per-phase
   testing.

5. **Snapshot churn**: each phase will likely require 1-3 fixture
   re-baselines as edge cases surface. Budget time for review.

## Definition of "M5d-proper done"

- `handlePassThrough` deleted from the codebase
- walker.ts is ≤ 400 LoC (today: 1500+ LoC)
- per-target string-builder methods (`emitXxx*` on PinocchioEmitter /
  NativeEmitter) deleted; emitters are pure validators / scaffold
  helpers
- 117/117 ast-visitor + binary-parity tests still pass
- All ~30 differential fixtures still byte-equal
- `bun api/scripts/em1-visitor-metric.ts` reports 0 raw_lines (or
  near-zero — only intentional rawLine escape hatches remain)
- ANVIL_AST_EMIT flag flipped to default-on; legacy path guarded
  behind `ANVIL_AST_EMIT=0`
- ~3500 LoC removed from the codebase

## What's NOT in this plan

- New IR kinds (zero-copy, Pyth/Switchboard, Metaplex catalog) — those
  are Tier 2.2 grant work
- Walker AST rewrite (grant M4) — effectively done via M5d
- AI-under-differential gate — already shipped per memory

## When to start

After P-C remaining (next session, ~3-5 hr). M5d-proper is the
follow-on. Don't start until:
- Demo recording is done (don't risk breaking things mid-demo prep)
- A clear 5-session block is available (~30 hr across 1-2 weeks)
- WSL stays stable (the structural transform doesn't need heavy
  builds, but the parity gate runs all 30+ differentials which DO
  need anchor build + LiteSVM)

## Pitch line for sponsors / users

"Anvil's transpiler is built around a typed IR + a structural emitter.
The legacy text-transform layer was incremental scaffolding; M5d
retires it. After M5d ships, Anvil is ~3500 LoC smaller, every emit
is structurally generated, and adding a new target is a ~500 LoC
subclass instead of a parallel regex implementation."

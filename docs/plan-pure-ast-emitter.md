# Plan: pure-AST emitter migration

**Status (2026-05-06, end of long-form session):**

- Phase 0 (binary-parity gate + 5 regex-pattern fixtures): DONE
- Phase 1 (AST scaffold + 3 IR kind structural ports): DONE
- Phase 2 increment (all 23 IR kinds dispatched via named visit methods): DONE
- **Phase 2 structural** (visitor produces structural AST instead of
  runHandlerCapture): IN PROGRESS — **6 of 23 kinds fully structural**:
    - `state_read` (LHS structural, body via emitter helper)
    - `state_field_assign` (LHS structural, RHS rawExpr)
    - `bumps_access` (let-stmt for alias)
    - `return_err` (pure structural)
    - `return_ok` (Ok line structural, prelude raw)
    - `msg` (Pinocchio shapes 1+3 structural; Native macro_call structural)
    - `sysvar_clock`, `sysvar_rent` (pure structural — let + tryPostfix)
  
  Wait that's 8 kinds. Plus the named-method dispatch shims for the
  other 15 (require, emit, pda_signer_seeds, pass_through, 11 cpi_*).
- Phase 3 (feature flag switchover): NOT STARTED
- Phase 4 (retire regex post-process layer): NOT STARTED

The current regex post-process layer remains the production emit path;
the visitor exists alongside it under `api/src/emitter/ast-visitor/`
and is exercised only by `tests/ast-visitor-byte-identical.test.ts`.

**AST node coverage:** RustStmt union covers let/assign/expr_stmt/
return/block/comment/const_decl/raw_line. RustExpr union covers
ident/lit/field/method_call/call/ref/deref/try/path/macro_call/
array/struct_literal/raw. Foundation for the remaining structural
ports is in place; each port is now a self-contained edit at the
visit site.

## What we have today

The emitter does AST-driven emit + a per-target regex post-process
layer. Concretely, `pinocchio-emitter.ts` (~2k LoC) and
`native-emitter.ts` (~1.3k LoC) each have:

- An `emit*` method per IR statement kind that returns target-specific
  Rust source as a string.
- A `postProcessPinocchioRewrites` (or Native equivalent) regex pass
  that transforms patterns the per-statement emit can't easily handle:
  - `solana_program::pubkey::Pubkey::find_program_address` →
    `pinocchio::pubkey::find_program_address`
  - `solana_program::program::set_return_data` →
    `pinocchio::program::set_return_data`
  - `solana_program::program::invoke{,_signed}` direct calls → comment-out
  - `*X.key` deref strip in comparison contexts
  - `.to_account_info()` strip universally
  - Anchor wrapper-type unsalvageable-helper commentout
  - Token-2022 extension call site commentout
  - dozens more

The regex layer is shipped, tested, and works. It's also fragile in
specific ways:

- Regression risk: a new regex shape can accidentally match an
  unrelated string in the emit. We've hit this twice this quarter
  (`Pubkey::default()` got swept in the find_program_address rewrite;
  fixed with negative lookbehind).
- Test surface: regex changes can pass unit tests but break a
  real-world fixture. Coverage gaps are real.
- Cognitive load: a contributor adding a new IR kind must understand
  the per-target regex layer's interaction with their emit. Not always
  obvious which rewrites apply post-AST-emit.

## When to migrate

Replatform criteria — both must hold:

1. **5+ real-world byte-equal fixtures green.** "Real-world" = an
   externally-authored Anchor program we cloned for verification, NOT
   a synthetic Anvil-internal fixture. The fixtures lock in the current
   behavior so the migration has a parity gate.
2. **3+ regression bugs in the regex layer in a quarter**, or 1
   correctness-critical regression that would have been impossible in
   pure AST (silently changing emit semantics in the wrong shape).

If both, replatform. Until then, regex stays.

Fixture inventory (2026-05-05):

- 30+ binary differential fixtures total. Most are synthetic / Anvil
  demo programs covering specific IR statement kinds.
- Real-world (externally-authored): anchor-escrow-2025 (1 program, 1
  instruction live + 2 deferred) + coral-events. = **2 real-world
  programs**, satisfying criterion #1 partially. Counter, vault, etc.
  are Anvil-authored demos and don't count.
- Regex regressions in last 90 days: 1 (Pubkey::default() over-match,
  fixed in #58). Below threshold.

Status: still below threshold on (2). On (1), the synthetic-fixture
count is misleading high; the real-world bar is what determines
whether the migration has a real parity gate. The CX1 corpus
expansion plan (`docs/plan-corpus-expansion.md`) targets RW3-RW5 to
push real-world count from 2 → 5, at which point criterion #1 is
satisfied and we re-evaluate.

## Migration plan when we cross the threshold

### Phase 0 — lock in current behavior (LANDED 2026-05-06, ~½ day)

- ✅ `tests/binary-parity-snapshot.test.ts` snapshots `output.files`
  (the multi-file emit, NOT singleFile — singleFile bypasses
  per-file commentOutUnsalvageableCallSites passes that
  `emitInstructionFile` runs). 61 fixture×target combinations
  (26 demos × 2 + 4 regex × 2 + 1 pinocchio-only T22 fixture),
  355 snapshot files under `tests/snapshots/binary-parity/`.
- ✅ Source-level snapshot, not `.so` bytes. `.so` is
  toolchain/host-specific (rustc patch, platform-tools, linker), so a
  committed byte-snapshot would create "passes on my WSL, fails on CI"
  flakiness. Source determines `.so` given a fixed toolchain — text
  snapshot catches every regression a `.so` snapshot would, plus
  produces a readable diff in failure logs and is portable across
  hosts.
- ✅ 5 regex-pattern fixtures under `tests/fixtures/regex-patterns/`,
  each a minimal Anchor program targeting one post-process site:
  - `t22-extension.rs` → `commentOutT22ExtensionCallSites`
    (pinocchio-only — Native auto-imports those types via
    `filteredSourceImports`).
  - `unsalvageable-helper.rs` → `commentOutUnsalvageableCallSites`.
  - `solana-program-invoke.rs` → `commentOutSolanaProgramInvoke`.
  - `deref-strip-comparison.rs` → walker.ts `*X.key` strip in
    comparison context (closure-param + explicit-`&` LHS shapes).
  - `pubkey-pda-rewrite.rs` → pinocchio-emitter.ts:1120
    `Pubkey::find_program_address` → `pinocchio::pubkey::*` rewrite.
    (Swapped in for the originally-planned `&mut Pubkey` deref-strip
    after advisor confirmed `&mut Pubkey` doesn't have a dedicated
    post-process site — the rewrite replaces it with a real one.)
- Manifest tracking: `MANIFEST.txt` per snapshot dir lists emitted
  files. A new file silently appearing or an old one disappearing
  surfaces as a manifest-drift error separate from content-drift.

### Phase 1 — AST visitor scaffold (LANDED 2026-05-06, ~1 day)

- ✅ `api/src/emitter/ast-visitor/` with these modules:
  - `nodes.ts` — minimal Rust-AST: `RustStmt` union (`let`, `assign`,
    `expr_stmt`, `raw_line`) + `RustExpr` union (`ident`, `lit`,
    `field`, `method_call`, `call`, `ref`, `deref`, `try`, `path`,
    `raw`). `raw_line` / `raw` are the explicit Phase-2 escape
    hatches; `countRawNodes` exposes them as a migration-progress
    metric.
  - `printer.ts` — single source of truth for whitespace. `printStmts`
    indents at 4 spaces (matches `BodyWalker.lines` convention).
    Operator/spacing rules documented inline so Phase 2 stays in lock
    step.
  - `visitor-base.ts` — `AstVisitorBase` with `visit(stmt)` dispatch
    over `VISITOR_SUPPORTED_KINDS = { state_read, state_field_assign,
    bumps_access }`. Other kinds throw — production never calls into
    here, so the throw is purely a Phase-2 reminder.
  - `pinocchio-visitor.ts`, `native-visitor.ts` — empty subclasses
    today. Target-specific divergences (regex layer fix-ups) land
    here as overrides in Phase 2.
- ✅ Decision validated by advisor: custom Rust-AST (not syn-style,
  not tree-sitter-in-reverse). Generation only; `raw` keeps Phase 1
  scope tight.
- ✅ `tests/ast-visitor-byte-identical.test.ts` runs the visitor and
  the existing handler chain on counter / vault / escrow × pinocchio
  / native, asserts BodyWalker.lines come out byte-identical for
  every supported-kind statement. 8/8 pass.
- ✅ `PinocchioEmitter` and `NativeEmitter` classes exposed (added
  `export` to the class declarations) so the test can construct a
  `BodyWalker` directly with the production emitter as
  `BodyEmitterCallbacks`. No production-path change.

### Phase 2 — visitor parity (~5 days)

- Goal: visitor produces byte-identical Rust source to the current
  regex post-process output for every fixture.
- One IR statement kind at a time:
  - Port the current regex rewrites for that kind into AST-level
    transformations in the visitor.
  - Run the binary-diff gate from Phase 0. It must pass for every
    fixture before the IR kind is considered done.
- Where the regex pass does something the AST visitor structurally
  can't (e.g. unsalvageable-helper commentout that depends on multiple
  call sites), keep that as a post-process step BUT scope it tightly
  (one specific transformation, well-tested).

### Phase 3 — switchover (~1 day)

- Add a feature flag (`ANVIL_AST_EMIT=1`) that routes emit through the
  visitor instead of the string-builder methods.
- Run the entire test suite + every fixture under the flag. Diff
  must be zero.
- Flip the default. Keep the legacy string-builder code path under
  `ANVIL_AST_EMIT=0` for one release.

### Phase 4 — sunset (~half-day)

- Remove the legacy string-builder methods. Remove the regex
  post-process layer. Update CONTRIBUTING.md (the "AST emit" section
  becomes the only path).

Total estimate: 11-12 days of focused work. Phased so each commit
ships green; the migration is reversible at any phase.

## What this DOESN'T solve

- Parser AST drift: we use tree-sitter for parsing. Tree-sitter's
  grammar is its own thing; the emitter migration is orthogonal.
- IR shape evolution: the IR is already typed via Zod and well-tested.
  No change needed.
- Test toolchain: the differential pipeline + cargo build harness stay
  the same. The migration is internal to the emitter.

## Risks

1. **Migration cost without a clear win** — if real-world fixture
   count stalls at 2-3, the regex layer is fine. Don't replatform
   speculatively. The trigger is real production pain, not aesthetic
   preference.
2. **Subtle whitespace drift** — string-builder emit produces `\n\n`
   in places that an AST printer might render differently. Binary diff
   gate catches it but expect a long tail of "fix this whitespace"
   commits during Phase 2.
3. **Performance** — AST emit + print is slower than direct string
   building (probably 2-3× cold; warm via caching is fine). Acceptable
   given the correctness gain, but profile during Phase 3.

## Session results (2026-05-06) — Phase 0 + Phase 1

**Visitor coverage today (3 / 23 IR kinds):**

✅ Ported: `state_read`, `state_field_assign`, `bumps_access`.

🚫 Pending Phase 2 (20 kinds, ranked by frequency in differential
fixtures so the high-leverage ports come first):

- `pass_through` (every demo — biggest single port, most regex
  fragility lives here through `simplifyPassThroughCode` + the
  walker's body-text rewrites).
- `cpi_spl_transfer`, `cpi_system_transfer`, `cpi_spl_mint_to`,
  `cpi_spl_burn`, `cpi_spl_close_account`, `cpi_spl_set_authority`,
  `cpi_ata_create`, `cpi_memo`, `cpi_custom`,
  `cpi_mpl_create_metadata_v3`, `cpi_mpl_create_master_edition_v3`
  (the CPI catalog — 11 kinds, target-specific shapes, where the
  emitter-base abstract interface already isolates per-target
  divergence).
- `require`, `msg`, `emit`, `return_ok`, `return_err` (control flow
  + macros, structurally simple).
- `sysvar_clock`, `sysvar_rent` (small, target-specific call shapes).
- `pda_signer_seeds` (the `&[Signer]` const-size dance is the
  pinocchio-specific shape that requires the most subclass override).

**Notable structural calls remaining beyond the 23-kind dispatch:**

- The walker's terminal regex post-process at lines 224-252 (collapse
  `**X.key`, strip `*X.key` in comparison contexts, closure-param
  shapes). These don't fire per-statement — they sweep the JOINED
  output. Phase 2 candidate: replace the sweeps with structured
  field/key access nodes that emit the right shape from the start.
- `pinocchio-emitter.ts:postProcessPinocchioRewrites` (lines
  1112-1192). Block-level rewrites: `Pubkey::find_program_address`,
  set/get_return_data, `solana_program::program::invoke` commentout,
  T22 extension commentout, system create_account → pinocchio
  `CreateAccount` struct conversion. Most of these become
  unnecessary once the per-IR-kind visitor emits the target shape
  directly (e.g. CPI custom emits pinocchio CPI shapes natively
  rather than emitting Anchor's invoke + post-rewriting).
- `commentOutUnsalvageableCallSites` (`emitter-base-utils.ts:47`):
  cross-statement helper-set computation. This stays as a tightly-
  scoped post-process step in Phase 2 — the AST visitor structurally
  CAN'T do it (depends on multiple call sites being matched against
  a global helper set), but the implementation can shrink to one
  pass on AST nodes instead of text.

**Trigger conditions when this doc was written:**
- Real-world byte-equal fixtures: 2 (anchor-escrow-2025/make_offer +
  coral-events). CX1 expansion plan still aims for 5+ but probes of
  Squads v4, Marinade, Marginfi, Drift, etc. surfaced harder
  blockers than expected (see CX1 plan + 2026-05-05 reports).
- Regex-layer regressions in the last 90 days: 5+ (T22 brace edge
  cases × 3 in Squads probe, sourceErrorEnumName metachar crash,
  G1-G5 RW-emit gap fixes). The regex-fragility threshold is
  satisfied even though the real-world-fixture threshold is not.

The decision to start Phase 0 + 1 anyway: empirical regression cost
of the regex layer outweighs the "more fixtures first" hygiene rule.
Phase 2 (the actual risky work) still gates on the real-world-fixture
threshold to provide a parity gate broad enough to catch silent
semantic divergence.

## Long-form completion plan (multi-session)

User committed to multi-session continuous execution to fully complete
EM1 + Pinocchio formatted msg!() support. Plan below tracks the
remaining ~50-70 hours across ~7 future sessions.

### Session 1 (LANDED 2026-05-06)
- M1: visit methods for require/emit/sysvar_clock/sysvar_rent/pda_signer_seeds.
  Two fully structural (sysvar_*); three named-method shims pending
  full structural ports.
- M2: dispatch shim — all 11 CPI catalog kinds get named visit
  methods (no structural change yet, just reorganization).
- M2.1: AST node infrastructure — block / comment / const_decl /
  array / struct_literal nodes + printer rules. Lands as dead code.
- 4 commits: 30cb15b (M1), 6a54eec (M2 dispatch shim), 9345f05 (M2.1
  AST infra), [docs commit pending].

### Sessions 2-3 (Tier B-1 + B-2): CPI catalog structural ports (~12-15 hrs)
Per-kind ~2-3 hrs because of multi-line whitespace-policy matching
between AST printer and existing emit shape. Order:
- 2a: cpi_memo, cpi_system_transfer, cpi_ata_create (simpler shapes)
- 2b: cpi_spl_transfer, cpi_spl_mint_to, cpi_spl_burn (token CPI shape)
- 3a: cpi_spl_close_account, cpi_spl_set_authority (authority dance)
- 3b: cpi_custom (passes through arbitrary Rust — limited structural
  win without IR-level expression model; same blocker as pass_through)
- 3c: cpi_mpl_create_metadata_v3, cpi_mpl_create_master_edition_v3
  (Metaplex stubs — emit comment block; structural is mostly cosmetic)

Per-kind cost includes: write the structural emit, decide multi-line
printer rule (inline/multi-arg), verify byte-identical via
ast-visitor-byte-identical test, run binary-parity-snapshot.

### Session 4 (Tier B-3 + simple kind structural completions): ~6-8 hrs
- Full structural ports for require + emit + pda_signer_seeds (need
  block-level AST + slice-ref policies).
- Audit pass: run countRawNodes on full demo corpus; document any
  remaining raw_line per kind.

### Sessions 5-7 (M5 — pass_through structural): ~15-20 hrs over 2-3 sessions
The big one. The regex post-process layer's biggest surface lives
inside pass_through transforms. Structural port requires:
- 5a: IR extension — Rust expression sub-types in SolanaIR (Zod
  schema growth). Decide schema for: account-ref ident, ctx.bumps
  field-ref, helper call, Vec/method dispatch, generic Rust expr.
- 5b: Parser — extract structured expression IR using existing
  tree-sitter Rust output (don't re-parse). Migrate
  body-classifier.ts.
- 5c: Visitor — consume new IR + emit structural AST. Replaces
  simplifyPassThroughCode + transformCtxAccountsReferences +
  replaceBumpRefs + transformHelperCalls + the walker terminal
  regex sweeps for pass_through-derived expressions.
- 5d: Migration — every byte-equal differential fixture must hold.
  Re-run full corpus; revert + diagnose any divergence.

### Session 8 (M7 — Pinocchio formatted msg!() proper support): ~16-20 hrs (~2-3 days)
- 8a: int → ASCII decimal helper (~50 LoC const-time, no alloc dep,
  stack-allocated buffer). Verify against test vectors.
- 8b: Pubkey → ASCII base58 helper (~80 LoC with leading-zero
  handling). Verify against bs58 crate output.
- 8c: Format-arg detection in emitter, template parsing, buffer-
  builder splice in handler prologue, sol_log on the result.
- 8d: Vesting demo fixture exercising compareMsgLogs with formatted
  msg!() — byte-equal verify on Pinocchio.

### Session 9 (M6.1 — Phase 3 switchover): ~6-8 hrs
- Add `ANVIL_AST_EMIT=1` feature flag routing through visitor
  instead of string-builder methods.
- Run ENTIRE test suite + binary-parity-snapshot under both flag
  values. Diff must be zero.
- Flip default. Keep legacy under env=0 for one release.

### Session 10 (M6.2 — Phase 4 sunset): ~3-4 hrs
- Delete legacy string-builder methods (~3500 LoC removed).
- Delete regex post-process layer (commentOutT22ExtensionCallSites,
  commentOutSolanaProgramInvoke, walker terminal regex sweeps,
  postProcessPinocchioRewrites).
- Update CONTRIBUTING.md so AST emit is the only documented path.

## Total realistic cost

~55-70 hours of focused work. ~10 sessions if each runs 4-7 hrs.

## What you get when ALL of this lands

**Engineering payoff:**
- ~3,500+ LoC of regex post-process layer DELETED. The "fragility
  lever" the EM1 plan was created to address — gone.
- Adding a new target = implementing visitor methods, not forking
  the emitter. Today adding a 4th target means duplicating ~2k LoC
  of regex transforms; post-EM1 it's a ~500 LoC subclass.
- Adding a new IR kind = ~30 min (vs ~2-3 hrs today since regex
  layer also needs a corresponding rewrite).
- countRawNodes hits 0 — every emit is structurally generated, no
  pass-through text.

**Correctness payoff:**
- Per-IR-kind correctness proofs become tractable — formal-
  verification milestone from the deck (Long-term: "Formal
  verification of emitter") gets unblocked.
- Pinocchio formatted msg!() byte-equality lands — programs using
  msg!("X: {}", val) byte-equal on user-emitted log lines. Closes
  a known hard gap.
- Zero regex regression risk for new emit features. Today every
  regex change risks accidentally matching unrelated strings.

**Marketing payoff:**
- Pitch can claim "first AST-driven Solana emitter, with byte-equal
  verification across N programs."
- Roadmap slide credibility: long-term goals become near-term
  unlocks.

## What to do next session

If EM1 Phase 2 is the priority:

1. Pick one IR kind to port — start with `pass_through` (highest
   frequency + biggest regex surface).
2. Wire visitor output into the production emit path under a feature
   flag (`ANVIL_AST_EMIT=1`). The flag is OFF by default; CI runs
   `tests/binary-parity-snapshot.test.ts` with the flag both ON and
   OFF and asserts `output.files` is byte-identical.
3. Drop the `pass_through` handler's regex transforms one at a time,
   replacing each with a structured AST emission. Re-run binary
   parity after each replacement.

If EM1 takes a back seat:

- `tests/ast-visitor-byte-identical.test.ts` is the canary. As long
  as it stays green when the regex layer evolves, the visitor's
  3-kind contract is intact. When it goes red, either a regex change
  affected a visitor-supported kind (and the visitor needs the same
  port) OR a kind got accidentally widened in the visitor without
  the test catching the divergence.

The threshold to push Phase 2 is now: 5+ real-world byte-equal
fixtures (CX1 progress) AND a 4th distinct regex regression. Both
must hold.

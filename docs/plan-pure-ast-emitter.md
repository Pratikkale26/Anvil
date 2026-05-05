# Plan: pure-AST emitter migration

**Status:** plan-only. No code changes until this is reviewed + approved
explicitly. The current regex post-process layer is intentional for
iteration speed; this document captures when + how to retire it.

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

### Phase 0 — lock in current behavior (~2 days)

- Snapshot every byte-equal fixture's `~/.anvil-diff-cache/<fixture>/anvil.so`.
- Add a "binary diff" gate: parse a fixture, emit, build, compare the
  resulting `.so` byte-by-byte against the snapshot. Any drift is a
  parity break. This catches regressions during the migration without
  needing to re-run differential.
- Add ~5 more fixtures targeting the regex post-process patterns
  specifically (each rewrite has a fixture that exercises it). Without
  these, we won't know if a missing rewrite breaks user code.

### Phase 1 — AST visitor scaffold (~3 days)

- Add `api/src/emitter/ast-visitor/` directory.
- One visitor class per target (`PinocchioAstVisitor`, `NativeAstVisitor`).
- Each visitor walks an IR statement and emits an AST node tree (using
  a small Rust-AST representation — not tree-sitter, since we're
  generating, not parsing). Existing string-builder methods become
  visitor methods that return AST nodes.
- An AST printer renders nodes back to Rust source. The printer is the
  one place where "where do I put whitespace" lives.
- Don't ship yet. Visitor lands as dead code, exercised only by unit
  tests.

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

## What to do next session if EM1 is greenlit

Re-validate the trigger conditions:
- Count real-world byte-equal fixtures (currently 2).
- Count regex-layer regressions in the last 90 days.

If still below threshold: tag this doc with a date + the current
counts and let it sit. Revisit when corpus expansion (CX1) lands more
real-world fixtures.

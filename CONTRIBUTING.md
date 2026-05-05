# Contributing to Anvil

This document is for contributors changing Anvil's code. If you just want
to use Anvil, see [README.md](README.md).

Three things you'll want to know up-front:

1. **The byte-equal differential pipeline is the load-bearing correctness
   signal.** Cargo green is necessary but not sufficient. Every
   transformation that ships should ideally have a fixture that proves
   the emit is byte-identical to the Anchor reference for at least one
   real scenario.
2. **Atomic commits per logical change.** Don't bundle. Commit message
   bodies explain the *why*; the diff explains the *what*.
3. **No `Co-Authored-By: Claude` lines** in commit messages. Don't worry
   about it; just write the commit yourself.

---

## Architecture in one paragraph

`Anchor source → tree-sitter AST → SolanaIR (Zod) → emitter (Pinocchio
or Native target) → output validator → cargo build (verify) → optional
LiteSVM differential vs Anchor reference (byte-equal verify)`. The IR
is the contract between parser and emitter; both sides treat it as
versioned. Emitter is not pure-AST — it does AST emit + a regex
post-process layer; this is intentional for iteration speed and is
documented honestly. See `api/src/emitter/N1-DEDUP-DESIGN-NOTE.md`
for the per-target vocab pattern.

---

## Common contribution shapes

### Adding a differential fixture

A differential fixture builds two `.so` files (Anchor reference + Anvil
emit) for a single program, runs the same instruction sequence against
both in LiteSVM, and asserts byte-equal account state.

Pick the simplest case from a real or demo program:

1. Source lives at `api/src/demo-programs/<name>.rs` (for hand-written
   demos) or `/tmp/<repo>/...` (for real-world public programs auto-
   cloned at first run).
2. Test file: `api/tests/differential-<name>.test.ts`.
3. Use `defineDifferential` from
   `api/tests/differential-harness.ts`:

```typescript
defineDifferential({
  fixtureName: "your-fixture",
  programIdBase58: "Valid44CharsBase58Pubkey...",
  anchorSource: readFileSync(SRC, "utf-8"),       // single-file
  // OR for multi-file Anchor:
  anchorReferenceCrateDir: "/path/to/upstream/crate",
  anchorPackageName: "your_fixture_anchor_diff",  // unique cargo name
  setup: async () => ({ keypairs, pdas, ... }),
  callScript: async (svm, ctx, programId) => { /* tx send */ },
  accountsToCompare: (ctx) => [{ pubkey: ctx.somePda, label: "..." }],
  // optional opt-in compare surfaces:
  compareEventLogs: true,
  compareReturnData: true,
  compareMsgLogs: true,
});
```

Templates to copy from:
- `differential-counter.test.ts` — simplest, no SPL, no clock
- `differential-anchor-escrow-2025.test.ts` — real Anchor 0.31, multi-file
- `differential-coral-events.test.ts` — event-log comparison
- `differential-msg-logs.test.ts` — msg!() comparison
- `differential-return-data.test.ts` — set_return_data comparison

For real-world programs, **clones go to `/tmp/`** — never anywhere
under the repo root (WSL hates it). The repo also stays small.

### Adding a `cpi_spl_*` IR kind

When Anvil needs to recognize a new SPL CPI shape (e.g.
`cpi_spl_freeze_account`):

1. **IR schema** — add the discriminated union variant in
   `api/src/ir/schema.ts` under `BodyStatementSchema`. Carry the fields
   the emitter will need (account names, signer seeds, token program
   tag, etc).
2. **Parser body classifier** — add a `case "freeze_account":` arm in
   `api/src/parser/cpi-detector.ts` that pattern-matches the
   `CpiContext::new(prog, FreezeAccount{...})` shape and emits the new
   IR kind.
3. **Body-emitter handler** — add `handleCpiSplFreezeAccount` in
   `api/src/emitter/body-emitter/handlers/cpi.ts` that calls the
   target-specific `emitter.emitSplFreezeAccount(...)`.
4. **Per-target emit** — implement `emitSplFreezeAccount` on
   `pinocchio-emitter.ts` and `native-emitter.ts`. Pinocchio: hand-roll
   the CPI against the SPL Token program ID (instruction discriminator
   + accounts list). Native: `spl_token::instruction::freeze_account(...)`
   + `solana_program::program::invoke{,_signed}`.
5. **Add a fixture** — `differential-spl-freeze.test.ts` that proves
   byte-equal of the frozen account's state.

### Adding a sanity warning

Sanity warnings defuse silent-pass failure modes (the verdict reads
green when it shouldn't). Each gets its own kind:

1. `api/src/build/scenario-runner.ts` — extend the
   `SanityWarning.kind` union with the new variant.
2. Detection logic — add the check inside `compareScenarioRuns()` near
   the existing `sanityWarnings.push` sites.
3. Frontend type — mirror the union in `web/lib/constants.ts`.
4. UI rendering — the existing yellow-bar in
   `web/components/workbench/differential-verdict.tsx` handles new
   kinds via the generic `.message` field; only add kind-specific
   styling if the warning needs unique iconography.

Existing kinds for reference:
- `all_steps_reverted` — every step reverted in both targets
- `zero_mutation` — compared accounts are empty post-scenario
- `no_compare_targets` — scenario has no compare.accounts + no
  assertions + no log compares
- `partial_compare_scope` — BYTE_EQUAL holds but scenario only
  compared a subset of touched accounts
- `discriminator_mismatch` — IR expects an Anchor disc but the bytes
  don't carry it

### Working with the parser

Tree-sitter AST entry: `api/src/parser/anchor-parser.ts`. The parser
applies source rewrites (`err!()` / `error!()` → explicit `Err(...)`)
BEFORE tree-sitter parses, so the IR is rewritten-shape consistent.
The body classifier in `api/src/parser/body-classifier.ts` is where
most emit-relevant decisions are made — adding a new statement
recognizer (e.g. set_inner expansion, helper-CPI inlining) usually
lives there.

### Working with the emitter

The emitter has a base class (`api/src/emitter/emitter-base.ts`) that
walks the IR and dispatches to per-target subclasses
(`pinocchio-emitter.ts`, `native-emitter.ts`). The body-emitter
subdirectory has the per-statement-kind handlers.

After AST emit, the per-target emitter runs a regex post-process step
that handles target-specific rewrites (e.g. `Pubkey::find_program_address`
→ `pinocchio::pubkey::find_program_address`,
`solana_program::program::set_return_data` → `pinocchio::program::set_return_data`).
This layer is intentional for iteration speed; the long-term plan is
to replace it with a pure-AST emitter once we have ~5+ real-world
fixtures locking in the current behavior.

---

## Testing your change

Three test layers, in order of speed:

1. **Fast unit tests** (~1-2s):
   ```
   bun test tests/parser-snapshots.test.ts \
            tests/scenario-schema.test.ts \
            tests/scenario-runner-discriminator.test.ts \
            tests/scenario-runner-deserialize.test.ts \
            tests/auto-scenario.test.ts \
            tests/parser-set-inner.test.ts \
            tests/parser-helper-cpi-catalog.test.ts \
            tests/api.test.ts \
            tests/emitter-validation.test.ts \
            tests/passthrough-audit.test.ts
   ```

2. **Cargo build tests** (~30-60s cold, ~5s warm):
   ```
   bun test tests/cargo-build.test.ts tests/realworld-cargo.test.ts
   ```

3. **Differential fixtures** (~30-60s cold per fixture):
   ```
   bun test tests/differential-counter.test.ts \
            tests/differential-coral-events.test.ts \
            tests/differential-anchor-escrow-2025.test.ts
   ```

Always run layer 1 + the specific test for what you changed. Run
layer 2 + 3 before pushing.

The `~/.anvil-diff-cache/` directory caches built `.so` files. After
parser/emitter changes the cache is auto-invalidated via
ANVIL_CODE_VERSION (a hash of `src/parser` + `src/emitter` +
`src/ir/schema.ts`). If you ever need to clear it manually:
`rm -rf ~/.anvil-diff-cache/`.

---

## Commit message conventions

Look at recent commits with `git log --oneline` for the shape. The
conventions:

- Subject line ≤ 70 chars, prefixed by area: `feat(parser):`,
  `fix(emitter):`, `test(differential):`, `chore(target):`,
  `docs(security):`, etc.
- Body explains the *why*. Reference the IR statement kind, target,
  or specific commit/issue number when relevant. Multi-paragraph is
  fine for non-trivial changes.
- No `Co-Authored-By: Claude` or similar attribution lines.
- For atomic commits in a series, label them with `(A1)` / `(M3)` /
  `(N1)` / `(B5)` short codes when they're part of a coordinated
  push.

---

## Sandbox + security model

`POST /build` and `POST /build/differential` execute cargo against
attacker-controlled source. Every cargo invocation runs inside the
strongest available sandbox (`firejail` > `bwrap` > `unshare` >
`none`), with env-strip + prlimit caps. See
[SECURITY.md](SECURITY.md) for the full threat model.

If your change touches the build path, the AI repair path, or any
HTTP-facing route, **read SECURITY.md before reviewing your own
diff**.

---

## What NOT to do

- Don't add `Co-Authored-By: Claude` in commits.
- Don't bundle multiple logical changes in one commit.
- Don't skip the differential fixture for new emit transformations
  — cargo green doesn't prove correctness.
- Don't clone real-world programs into the repo. `/tmp/` only.
- Don't bypass the sandbox. If you need to, document why in
  SECURITY.md.
- Don't push code that breaks the workbench `/parse` → `/emit` →
  `/build` roundtrip — there's a JSON serialization layer between
  steps and any `optional()` Zod field can become null after
  roundtrip; use `nullish()` instead.
- Don't change `BuildTarget` away from `"pinocchio" | "native"`. If
  you want to add Quasar back when it ships stable, that's a
  coordinated change across `BuildTarget`, the IR's
  `metadata.sourceFramework`, the emit + validator + scaffold layers,
  and the workbench picker.

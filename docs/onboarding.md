# Onboarding — how Anvil hangs together, and how to change it without breaking it

This is the bus-factor document: what you need to know to make a change to the
transpiler and trust it. It complements [architecture.md](architecture.md)
(component map) — this file is about *where the danger is* and *how to work safely*.

## The pipeline, with file pointers

```
Anchor .rs ──► parser ──► SolanaIR (Zod) ──► emitters ──► output validator ──► differential gate
```

| Stage | Entry point | What it does |
|---|---|---|
| Pre-parse rewrites | `api/src/parser/anchor-parser.ts` (`parseAnchor`) | Anchor macro rewrites (`err!`, `require!`) on raw text before tree-sitter |
| Multi-file flatten | `api/src/parser/project-source.ts` | Resolves `mod x;` file graphs into one source, renames colliding consts |
| Parse | `api/src/parser/` (tree-sitter via `ts-init.ts`) | Syntax tree → structured items; `instruction-parser.ts`, `account-parser.ts`, `body-classifier.ts` |
| IR | `api/src/ir/schema.ts` | The single typed contract (`SolanaIRSchema`). Everything downstream consumes ONLY this |
| Emit | `api/src/emitter/emitter-base.ts` + `pinocchio-emitter.ts` / `native-emitter.ts` | IR → Rust project files |
| Validate | `api/src/emitter/output-validator.ts` | IR-aware semantic re-check of the EMITTED text (did has_one/close/init/signer-seeds survive?), refuses stub-bearing output |
| Prove | `api/tests/differential-harness.ts`, `api/src/build/differential-build.ts`, scenario-runner | Build both `.so`, run identical scenarios in LiteSVM, byte-compare `data + lamports + owner` + per-step revert parity |

The CLI (`cli/anvil.ts`) is a front-end over the same modules — `prepack`
copies `api/src` into the published package as `src/api-src/`.

## The god files (and why they're still god files)

- `api/src/emitter/emitter-base.ts` (~6k lines) — shared emit logic, carried-code
  transforms, known-name collection. Partially decomposed into
  `emitter-base-utils.ts` (pure helpers). Further decomposition is welcome but
  ONLY as mechanical, byte-neutral extractions validated by the snapshot recipe below.
- `api/src/emitter/ast-visitor/visitor-base.ts` + `walker.ts` — instruction-body
  emit. Two parallel resolution pipelines live here (see fault line below).
- `api/src/parser/body-classifier.ts` — classifies statement shapes (CPI patterns,
  transfers, state ops) from body text.
- `cli/anvil.ts` — all CLI commands in one file.

## The architectural fault line: text rewrites vs AST

Historically most emit transforms were REGEX over Rust text. The known silent-
miscompile classes almost all lived there. The Phase-6 hardening (2026-07)
measured each suspected class and fixed the four that were live; the residue is
guarded by fixture-first regression tests:

- `collapseModulePaths` (anchor-transforms.ts) — collapses flattened user-submodule
  paths onto top-level names. Root-gated by `ir.userModuleRoots` (every `mod`
  declared in source) so external-crate paths can never collapse onto colliding
  user symbols (the id/authority-swap class). Tests: `collapse-module-paths-external-id.test.ts`.
- CPI dispatch (`cpi-detector.ts`) — exact/namespace-scoped matching (`isExtCall`,
  `isSplTokenCall`), never bare `.includes()`. Tests: `parser-cpi-dispatch-precedence.test.ts`.
- Let-bound transfer folding (`body-classifier.ts`) — bails when any argument is
  reassigned between binding and invoke. Tests: `parser-system-transfer-mutation-guard.test.ts`.
- `rewriteSelfReferences` (anchor-transforms.ts) — marinade-style `self.<field>`
  Deref chains; ambiguous suffix → loud `__anvil_unported_self__` placeholder,
  never a guess. Tests: `rewrite-self-references-ambiguous-suffix.test.ts`.

The AST-first pipeline (`expr-transform.ts`, `resolveToAst`/`resolveToText` in
visitor-base) shadows the regex pipeline with a parity-compare harness. Lesson
from the reverted Inc-1 migration (`6e82835`): the AST pipeline mishandled a
`.to_account_info().key` FIELD-chain that only appeared in the realworld
fixtures — migrating callers from regex to AST is NOT automatically safe.
Migrate only with the full snapshot recipe below.

## The safety discipline (non-negotiable)

1. **Fixture first.** Before fixing a suspected miscompile, write the failing
   test (unit + an e2e through `parseAnchor` → `emitPinocchioFull`). If you
   can't make it fail, it may not be live — measure before investing (see
   `memory`/audit notes: the static plan overstated live bugs ~4:1).
2. **Byte-neutrality proof.** Any emitter/parser change that isn't MEANT to
   change output must be proven byte-neutral:
   ```bash
   # hash the full pinocchio+native emit of every corpus program
   bun <snapshot-script> api/src/demo-programs        > before-demos.json
   bun <snapshot-script> api/tests/fixtures/realworld > before-realworld.json
   # ...make the change...
   # re-run and diff. ANY changed hash = investigate before commit.
   ```
   The script is ~30 lines: for each `.rs`, `parseAnchor` → `emitPinocchioFull(ir)`
   + `emitNativeFull(ir)` → sha256 over sorted `path\0content`. (Emitters return
   `{files: [{path, content}]}`, not a string.) **Check BOTH corpora** — the
   73-demo set alone missed a realworld regression once already.
3. **Loud beats silent, always.** If a transform can't be certain, emit
   `unimplemented!()` / a marker the validator refuses (`markers.ts` ↔
   `output-validator` linkage is itself tested). A compile error costs the user
   minutes; a silent wrong-byte costs them mainnet funds.
4. **Full suite needs the toolchain.** `bun test api/tests/` requires
   `cargo-build-sbf` (Agave) + `anchor` and hours of wall-clock + tens of GB of
   scratch. Per-push CI runs typecheck only; run the corpus before releases.
   Env recipe: `export TMPDIR=<big-disk>` (SBF builds fill small tmpfs), bun ≥ 1.3.

## Release checklist (CLI)

1. Bump `cli/package.json` AND the `VERSION` const in `cli/anvil.ts`
   (prepack hard-fails on drift).
2. `cd cli && npm pack`, install the tarball in a scratch dir with **npm + plain
   Node, bun OFF PATH**, and run: `--version`, `compile --no-cargo-check`,
   `parse --json`, `advise`. The 0.4.0 tarball shipped broken precisely because
   nobody executed the *installed* shape (prepack-check only diffs trees).
3. Update CHANGELOG.md; `npm publish` runs prepack automatically.

## Glossary

- **G-numbers** (`G31`, `G68`, …) — emit-bug findings from corpus sweeps; comments
  reference them at fix sites. Grep the number to find the cluster.
- **Markers** — `⚠️ Anvil TODO` / `__anvil_unported_self__` / `unimplemented!()`
  stubs: the loud-refuse channel. `cli/stub-markers.ts` mirrors
  `api/src/emitter/markers.ts` (kept in sync by `stub-marker-linkage.test.ts`).
- **needsReview** — parser-level "I matched this but can't guarantee fields";
  surfaces as a validator warning, gates strict mode.
- **Carried code** — helper fns / impl items copied (transformed) from source
  into the emit rather than generated from IR. Transforms in `anchor-transforms.ts`.
- **MUST_PASS** — the cargo-build regression ledger (fixture must compile on
  both targets); **tracking ceilings** — fixtures allowed ≤ N errors, ratcheted down.
- **Vacuous-green defusal** — a differential run where every step reverted or
  nothing was compared FAILS (`SCENARIO_FAILED`), and `runtimeVerified` demands
  strict `BYTE_EQUAL`. Don't reintroduce a path around this.

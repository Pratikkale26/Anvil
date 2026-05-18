# Architecture

## Overview

Anvil is a small compiler that turns Anchor Rust into one of two target
backends — Pinocchio (production) or Native (reference, raw `solana_program`)
— via a typed, schema-validated IR.

```text
Anchor-like Rust
  ├─► tree-sitter parse
  ├─► structural classification (instructions, accounts, constraints, body stmts)
  ├─► SolanaIR (Zod-validated, 60+ body-statement kinds)
  ├─► target emitter (Pinocchio | Native)
  ├─► output validator (structural)
  └─► generated Rust + CU metadata
                │
                └─► (optional) byte-equal differential gate vs Anchor reference .so in LiteSVM
```

Two apps:

- `api/` — Bun + Express HTTP server hosting the parse/emit/build/refine pipeline
- `web/` — Next.js workbench: paste source, pick target, see emitted code, verify with cargo, optionally repair with AI

## Pipeline Layers

### Parser

`api/src/parser/` — tree-sitter-driven AST walker. Extracts:

- instructions and their args
- account contexts with full constraint normalization (16 kinds: `init`, `mut`, `seeds`, `bump`, `has_one`, `close`, `init_if_needed`, `payer`, `space`, `token::*`, `associated_token::*`, freeform `constraint = …`, etc.)
- custom errors
- helper / inherent-impl methods (now flow-preserved into emit)
- body statements classified into 60+ IR kinds (`state_read`, `state_field_assign`, `bumps_access`, `pass_through`, `require`, `msg`, `emit`, `return_ok`, `return_err`, `sysvar_clock`, `sysvar_rent`, `pda_signer_seeds`, `cpi_spl_*` family (transfer / mint_to / burn / close_account / set_authority), `cpi_ata_create`, `cpi_memo`, `cpi_custom`, `cpi_system_transfer`, the 12-slot `cpi_mpl_*` Metaplex Token Metadata catalog, the 25-slot `cpi_t22_*` Token-2022 extension family, `zero_copy_load*`). Full list lives in `BodyStatementSchema` (api/src/ir/schema.ts).

Project ingestion supports raw source, single `.rs` file, project directory, or git repo URL with `programs/*/src/lib.rs` auto-detection.

Key files:
- [`api/src/parser/anchor-parser.ts`](api/src/parser/anchor-parser.ts) — entry
- [`api/src/parser/body-classifier.ts`](api/src/parser/body-classifier.ts) — body-statement → IR-kind dispatch
- [`api/src/parser/cpi-detector.ts`](api/src/parser/cpi-detector.ts) — pattern-matches Anchor CPI shapes
- [`api/src/parser/constraint-parser.ts`](api/src/parser/constraint-parser.ts) — `splitConstraintTokens` distinguishes `<=` / `>=` from generics
- [`api/src/parser/project-source.ts`](api/src/parser/project-source.ts) — multi-file resolution
- [`api/src/parser/ts-init.ts`](api/src/parser/ts-init.ts) — tree-sitter parser bootstrap (process-once cache)

### IR

[`api/src/ir/schema.ts`](api/src/ir/schema.ts) — Zod schema. Discriminated unions for body statements; structural validation at every emit boundary so the emitter never sees malformed IR. IR is **compiler-oriented**, distinct from Anchor IDL (which is interface-oriented).

### Emitters

- [`api/src/emitter/pinocchio-emitter.ts`](../api/src/emitter/pinocchio-emitter.ts) — primary target. Hand-rolled CPI for SPL Token / Token-2022 / ATA / Memo. PDA signer-seed expansion. Const-size `[Seed; N]` allocation patterns for `no_std`-compat signers.
- [`api/src/emitter/native-emitter.ts`](../api/src/emitter/native-emitter.ts) — `solana_program` reference. Auto-imports SPL crates only when CPI body needs them; auto-injects `Mint::unpack` prelude when `<account>.decimals` is referenced.
- [`api/src/emitter/ast-visitor/`](../api/src/emitter/ast-visitor/) — pure-AST emitter. Per-IR-kind visitor emits Rust-AST nodes (vs the legacy string-builder + regex post-process). **PRODUCTION default** since H1 Session F (commit `937060f`, 2026-05-13); the legacy per-kind handler chain + `ANVIL_LEGACY_WALKER=1` escape hatch retired in Session G (commit `aac2240`). Every IR statement kind dispatches through `visit()`. Structural coverage by kind: pure-structural builds `RustStmt[]` directly (`cpi_ata_create`, `cpi_memo`, `cpi_spl_transfer`, `cpi_system_transfer`, `state_field_assign`, etc.); others build a `string[]` routed through `applyStructuralize` (tree-sitter-aware multi-line lift to AST, rawLine fallback). The deferred work is absorbing `walker.ts`'s helper regex methods (`transformAccountReferences` et al.) into `RustStmt[]`-passes — multi-week; see [`reports/h1-collapse-shipped-2026-05-13.md`](../reports/h1-collapse-shipped-2026-05-13.md).
- [`api/src/emitter/output-validator.ts`](../api/src/emitter/output-validator.ts) — structural checks on emitted file set (no orphan refs, balanced braces, required imports present).
- [`api/src/emitter/cu-analyzer.ts`](../api/src/emitter/cu-analyzer.ts) — heuristic CU comparison (constants table, NOT measured; `scripts/measure-cu.ts` uses LiteSVM for real numbers).

### Build + Sandbox

`POST /build` (with optional SSE streaming) compiles emitted output via `cargo check` inside a layered sandbox detected at boot:

- **firejail** (default) — DigitalOcean App Platform compat
- **bwrap** — local Linux fallback
- **unshare + prlimit** — minimal fallback (used by realworld-cargo.test)
- **none** — explicit dev opt-out

Sandbox contract enforces: 2 GiB AS / 60s CPU / 256 MiB fsize / 128 nproc, env allowlist (no `ANTHROPIC_API_KEY` leak), separate cwd / network namespace where possible. See [`api/src/build/sandbox.ts`](api/src/build/sandbox.ts).

Per-target cargo scratch lives at `$HOME/.anvil-build/<target>/`; per-target promise queue serializes builds for the same target; `safeRelativePath` rejects path-traversal in user-supplied file lists.

### AI Refine Loop

`POST /build/auto-fix` orchestrates a bounded repair loop on cargo failures:

1. Run cargo, capture rustc errors.
2. Send focused prompt (only error-bearing files + rustc-error → fix-shape table) to Sonnet 4.6.
3. Validate response: tree-sitter parse pre-check + cross-file accept gate (each patch validated against the running file set, not just its own file).
4. **Revert on regression** — if patches strictly increase error count vs the pre-iteration baseline, discard.
5. Cap: `max_iterations=3`, `max_cost_usd=$0.50`, `previousAttempts` fed back so retries don't repeat the same wrong fix.

Per-IP daily $ cap on top ([`api/src/ai/spend-tracker.ts`](api/src/ai/spend-tracker.ts)) — UTC-midnight reset, file-mirrored, IP-masked in `/metrics`.

See [`api/src/ai/refine.ts`](api/src/ai/refine.ts).

## Test Layers

| Layer | Tests | What it gates |
|------|-------|---------------|
| Unit (parser / emitter / validator / API / spend-tracker) | ~150 | Code correctness |
| Binary-parity snapshot ([api/tests/binary-parity-snapshot.test.ts](../api/tests/binary-parity-snapshot.test.ts)) | 117 fixture×target snapshots | Locks `output.files` against on-disk snapshots; any visitor / post-emit change surfaces as a single-file diff. Replaced the retired `ast-visitor-byte-identical.test.ts` (premise dissolved when H1 Session G deleted handlers) — snapshot diffs are the ongoing structural-emit gate. |
| Cargo MUST_PASS (program-examples + escrow2025 + coral cohort + t22-transfer-fee) | 50+ fixtures × {pinocchio,native} | Emitted code compiles |
| Cargo tracking ceilings (coral-swap, t22-transfer-hook, …) | ~9 fixtures | Emitted code regression-guard (errors ≤ ceiling) |
| **Differential — demos** ([api/tests/differential-*.test.ts](../api/tests/)) | ~30+ byte-equal fixtures | **Anchor ↔ Anvil-Pinocchio runtime equality (LiteSVM byte-equal: data + lamports + owner)** |
| **Differential — real-world** | 6+ externally-authored Anchor programs (anchor-escrow-2025, coral-events, favorites, account-data, pda-rent-payer, page-visits) | Same gate, applied to programs Anvil didn't author |

The differential layer is the load-bearing correctness signal — cargo-green is necessary but not sufficient. `differential-harness.ts` provides a per-fixture API: caller supplies setup + callScript + accountsToCompare, the harness handles building, running both .so files in LiteSVM with the same keypairs, and byte-comparing post-scenario state + lamports.

## Frontend

[`web/app/`](web/app/) — Next.js. Workbench panels:

- **Input panel** — demo / source / file / folder / repo modes; target picker (Pinocchio + Native)
- **Output panel** — emitted file tree, single-file view, diff view (Anchor ↔ emit), compare-targets side-by-side, CU panel, lint panel
- **Verify build** — runs `POST /build`, shows cargo errors inline
- **Auto-fix** — runs `POST /build/auto-fix`, surfaces per-patch accept/reject reasons
- **AI-patched audit banner** — persistent yellow warning when AI patches are present in the active output (cargo-green ≠ runtime-equal). When `/build/auto-fix?with_differential=1` is used, the auto-fix card additionally shows a "✓ byte-equal verified" green badge or "⚠ diverged" yellow badge based on the differential verdict.

## Design Choices

### IR-mediated, not source-to-source
Each target emitter consumes the same Zod-validated IR. Adding a target is a single-file emitter, not a fork of the parser.

### cargo is the ground truth
Heuristic structural validation is fast feedback, but cargo error count is the only accept gate that matters. The auto-fix loop reverts on cargo regression — never trusts the model's claim that a patch helps.

### Differential testing > snapshot testing
Snapshot tests confirm "the emitter still emits the same string." Differential tests confirm "the emitted program produces the same on-chain effects as the Anchor original." When they conflict, differential wins.

## Known Gaps (current)

- **Quasar emit deleted from production path** on 2026-05-05 (`quasar-lang` hadn't shipped a stable 1.0). The vendored CLI copy at `cli/src/api-src/emitter/quasar-*.ts` is preserved but no longer maintained.
- **Workspace ingestion** (multi-program Anchor repos) requires explicit `sourcePath` per program.
- **CU heuristic table** doesn't auto-update; real numbers come from `scripts/measure-cu.ts`.
- **Token-2022 extension surfaces** (transfer-hook, transfer-fee, confidential-transfer) have ceilings, not green builds, on Pinocchio. Tracked-ceiling layer in `realworld-tracking.test.ts`.
- **Metaplex Token Metadata CPI** — 12 slots typed + hand-rolled emitted (M3 deliverable closed 2026-05-18). **Pyth + Switchboard CPIs** — imports preserved on Native, body code passes through; pinocchio rejects via the lint-analyzer "blocker" verdict. M2 deliverable (typed IR + byte-parse Pinocchio emit) is the active follow-up.
- **Pinocchio formatted msg!()** can't byte-equal Anchor's `alloc::format!()` runtime substitution (Pinocchio is no_std). Static literal msg!() byte-equals; format-arg msg!() collapses to a static literal with a comment-tagged warning.

## Recommended next milestones

1. **Expand real-world byte-equal corpus** beyond 6 (target: 10-15 externally-authored Anchor programs gated; adoption-tracking deliverable per the SF grant's A1).
2. **Pyth + Switchboard CPIs** (grant M2 — Pyth detection done via lint, typed IR + Pinocchio byte-parse emit pending): new IR kinds + emit + 2 byte-equal fixtures.
3. ~~**Metaplex Token Metadata + Core CPIs**~~ **CLOSED 2026-05-18** — full 12-slot Metaplex Token Metadata catalog typed + hand-rolled emitted on both targets; Metaplex Core pending as separate scope.
4. **EM1 Phase 3-4 — visitor is production + handlers retired** (DONE, 2026-05-13). Session F flipped the default; Session G deleted the entire `handlers/` directory + the legacy switch + the `ANVIL_LEGACY_WALKER` escape hatch. Total LoC delta ~-1500 across the emit stack. **Phase 5 remaining**: convert `walker.ts` helper regex methods (`transformAccountReferences`, `transformCtxAccountsReferences`, `transformNestedAnchorCode`, `normalizeKeyValueUsages`, `replaceBumpRefs`) from text-in/text-out to `RustStmt[]`-passes. Multi-week; details in [`reports/h1-collapse-shipped-2026-05-13.md`](../reports/h1-collapse-shipped-2026-05-13.md).
5. **Workspace ingestion** (programs/*/Cargo.toml driven).
6. **CU measurement automation** (replace heuristic table with measured numbers per fixture).

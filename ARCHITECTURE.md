# Architecture

## Overview

Anvil is a small compiler that turns Anchor Rust into one of three target
backends — Pinocchio, Native (raw `solana_program`), or Quasar — via a typed,
schema-validated IR.

```text
Anchor-like Rust
  ├─► tree-sitter parse
  ├─► structural classification (instructions, accounts, constraints, body stmts)
  ├─► SolanaIR (Zod-validated)
  ├─► target emitter (Pinocchio | Native | Quasar)
  ├─► output validator (structural)
  └─► generated Rust + CU metadata
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
- body statements classified into 17 IR kinds (`account_field_assign`, `cpi_spl_transfer`, `cpi_spl_set_authority`, `cpi_ata_create`, `cpi_memo`, `state_field_op`, `pass_through`, …)

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

- [`api/src/emitter/pinocchio-emitter.ts`](api/src/emitter/pinocchio-emitter.ts) — primary target. Hand-rolled CPI for SPL Token / Token-2022 / ATA / Memo. PDA signer-seed expansion. Const-size `[Seed; N]` allocation patterns for `no_std`-compat signers.
- [`api/src/emitter/native-emitter.ts`](api/src/emitter/native-emitter.ts) — `solana_program` reference. Auto-imports SPL crates only when CPI body needs them; auto-injects `Mint::unpack` prelude when `<account>.decimals` is referenced.
- [`api/src/emitter/quasar-emitter.ts`](api/src/emitter/quasar-emitter.ts) — experimental. Validator passes; not cargo-build-gated.
- [`api/src/emitter/output-validator.ts`](api/src/emitter/output-validator.ts) — structural checks on emitted file set (no orphan refs, balanced braces, required imports present).
- [`api/src/emitter/cu-analyzer.ts`](api/src/emitter/cu-analyzer.ts) — heuristic CU comparison (constants table, NOT measured; `scripts/measure-cu.ts` uses LiteSVM for real numbers).

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
| Unit (parser / emitter / validator / API / spend-tracker) | 142 | Code correctness |
| Cargo MUST_PASS (program-examples + escrow2025 + coral cohort + t22-transfer-fee) | 43 fixtures × {pinocchio,native} | Emitted code compiles |
| Cargo tracking ceilings (coral-swap, t22-transfer-hook, …) | 6 fixtures | Emitted code regression-guard (errors ≤ ceiling) |
| **Differential** ([api/tests/differential-*.test.ts](api/tests/)) | counter, vault | **Anchor ↔ Anvil-Pinocchio runtime equality (LiteSVM byte-equal)** |

The differential layer is the load-bearing correctness signal — cargo-green is necessary but not sufficient. `differential-harness.ts` provides a per-fixture API: caller supplies setup + callScript + accountsToCompare, the harness handles building, running both .so files in LiteSVM with the same keypairs, and byte-comparing post-scenario state + lamports.

## Frontend

[`web/app/`](web/app/) — Next.js. Workbench panels:

- **Input panel** — demo / source / file / folder / repo modes; target picker (Quasar disabled in UI pending differential coverage)
- **Output panel** — emitted file tree, single-file view, diff view (Anchor ↔ emit), compare-targets side-by-side, CU panel, lint panel
- **Verify build** — runs `POST /build`, shows cargo errors inline
- **Auto-fix** — runs `POST /build/auto-fix`, surfaces per-patch accept/reject reasons
- **AI-patched audit banner** — persistent yellow warning when AI patches are present in the active output (cargo-green ≠ runtime-equal)

## Design Choices

### IR-mediated, not source-to-source
Each target emitter consumes the same Zod-validated IR. Adding a target is a single-file emitter, not a fork of the parser.

### cargo is the ground truth
Heuristic structural validation is fast feedback, but cargo error count is the only accept gate that matters. The auto-fix loop reverts on cargo regression — never trusts the model's claim that a patch helps.

### Differential testing > snapshot testing
Snapshot tests confirm "the emitter still emits the same string." Differential tests confirm "the emitted program produces the same on-chain effects as the Anchor original." When they conflict, differential wins.

## Known Gaps (current)

- Differential corpus is 2 fixtures (counter, vault). Escrow + staking are tracked but not yet differential-gated.
- Quasar target is emitter-clean but has no cargo coverage and no runtime test.
- Workspace ingestion (multi-program Anchor repos) requires explicit `sourcePath` per program.
- CU heuristic table doesn't auto-update; real numbers come from `scripts/measure-cu.ts`.
- Token-2022 extension surfaces (transfer-hook, transfer-fee) have ceilings, not green builds, on Pinocchio.

## Recommended next milestones

1. Expand differential corpus (escrow → staking → real-world fixtures).
2. Workspace ingestion (programs/*/Cargo.toml driven).
3. Token-2022 extension parity on Pinocchio.
4. CU measurement automation (replace heuristic table with measured numbers per fixture).

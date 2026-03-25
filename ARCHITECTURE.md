# Architecture

## Overview

Anvil is structured as a small compiler pipeline with a web demo on top.

High-level flow:

```text
Anchor-like Rust
  -> parser
  -> Solana IR
  -> target emitter
  -> generated Rust output
  -> CU comparison metadata
```

The system is split into two main apps:

- `api/`: Bun + Express backend for parsing, emitting, and demo fixtures
- `web/`: Next.js frontend for landing-page messaging and the live playground

## Backend

Backend entrypoint:

- [api/src/index.ts](/home/pk/Anvil/api/src/index.ts)

Main responsibilities:

- expose HTTP routes
- parse Anchor-like source into IR
- emit target Rust code from IR
- serve preloaded demo fixtures

### Routes

- [api/src/routes/parse.ts](/home/pk/Anvil/api/src/routes/parse.ts)
  - accepts Anchor-like Rust source
  - returns normalized IR

- [api/src/routes/emit.ts](/home/pk/Anvil/api/src/routes/emit.ts)
  - accepts IR + target
  - returns generated code and CU data

- [api/src/routes/demo.ts](/home/pk/Anvil/api/src/routes/demo.ts)
  - returns preloaded IR fixtures
  - current public demo scope is `counter` and `vault`

## Parser Layer

Relevant files:

- [api/src/parser/anchor-parser.ts](/home/pk/Anvil/api/src/parser/anchor-parser.ts)
- [api/src/parser/account-parser.ts](/home/pk/Anvil/api/src/parser/account-parser.ts)
- [api/src/parser/instruction-parser.ts](/home/pk/Anvil/api/src/parser/instruction-parser.ts)
- [api/src/parser/constraint-parser.ts](/home/pk/Anvil/api/src/parser/constraint-parser.ts)
- [api/src/parser/error-parser.ts](/home/pk/Anvil/api/src/parser/error-parser.ts)

The parser extracts:

- instructions
- accounts
- args
- constraints
- custom errors

This information is normalized into a typed IR so emitters do not need to depend on source-text quirks.

## IR

IR schema:

- [api/src/ir/schema.ts](/home/pk/Anvil/api/src/ir/schema.ts)

Fixtures:

- [api/src/ir/fixtures/counter.json](/home/pk/Anvil/api/src/ir/fixtures/counter.json)
- [api/src/ir/fixtures/vault.json](/home/pk/Anvil/api/src/ir/fixtures/vault.json)
- [api/src/ir/fixtures/escrow.json](/home/pk/Anvil/api/src/ir/fixtures/escrow.json)
- [api/src/ir/fixtures/staking.json](/home/pk/Anvil/api/src/ir/fixtures/staking.json)

### IR vs IDL

Anvil’s IR is not the same thing as an Anchor IDL.

IDL is interface-oriented:

- what instructions exist
- what accounts and args they take
- what types are exposed publicly

IR is compiler-oriented:

- normalized constraints
- emitter-friendly account metadata
- derived seed information
- lower-level details useful for transformation and code generation

IDL can be one source of truth for interface shape, but IR is the internal format used to transform programs.

## Emitters

Relevant files:

- [api/src/emitter/pinocchio-emitter.ts](/home/pk/Anvil/api/src/emitter/pinocchio-emitter.ts)
- [api/src/emitter/quasar-emitter.ts](/home/pk/Anvil/api/src/emitter/quasar-emitter.ts)
- [api/src/emitter/native-emitter.ts](/home/pk/Anvil/api/src/emitter/native-emitter.ts)
- [api/src/emitter/cu-analyzer.ts](/home/pk/Anvil/api/src/emitter/cu-analyzer.ts)

### Pinocchio emitter

Current strengths:

- working counter path
- working vault path
- real discriminators
- signer/owner/PDA validation in generated code
- manual account byte encoding to avoid layout/alignment pitfalls

### Quasar emitter

Current strengths:

- working counter path
- working vault path
- avoids returning references from short-lived borrow guards
- manual value read/write strategy for account data

### Native emitter

This exists as a roadmap target, but it is not yet at the same completeness level as Pinocchio and Quasar.

## Frontend

Frontend entrypoint:

- [web/app/page.tsx](/home/pk/Anvil/web/app/page.tsx)

Main responsibilities:

- present Anvil as a product
- explain the compiler pipeline
- expose the live demo for the supported contracts
- visualize generated output and CU comparisons

The frontend currently shows:

- selectable live demos: `counter`, `vault`
- visible but disabled roadmap demos: `escrow`, `staking`
- selectable live targets: `pinocchio`, `quasar`
- visible but disabled roadmap target: `native`

## Design Choices

### Why use IR?

IR keeps the system modular.

Without IR, each target emitter would need to understand Anchor source directly. With IR:

- parsing is centralized
- emitters stay simpler
- new targets can be added more cleanly
- future sources like IDL or repo ingestion become easier to support

### Why keep the live demo narrow?

The goal right now is credibility, not breadth theater.

It is better to have:

- a clean `counter` path
- a meaningful `vault` path
- clear roadmap labels

than to claim broad contract support before token-heavy flows are correct.

## Known Gaps

The biggest remaining technical gaps are:

- generic SPL-token CPI generation
- ATA creation and `init_if_needed` support
- native target parity
- richer fixture/source parity for `escrow` and `staking`
- direct repo/local-file ingestion in the frontend

## Next Milestones

Recommended order:

1. repo/local-file ingestion
2. stronger output validation and integration tests
3. escrow support
4. staking support
5. native target completion

That ordering keeps the public product story strong while expanding backend depth in a controlled way.

# Project Summary

## What Anvil Is

Anvil is a compiler-style transpiler for Solana programs.

It takes Anchor-style Rust as input, parses it into a typed Solana IR, and emits alternative Rust backends such as Pinocchio, Quasar, and a native Solana target.

The goal is to separate:

- source ergonomics
- normalized contract understanding
- backend-specific code generation

That separation makes it easier to experiment with leaner runtimes without coupling every emitter to raw Anchor source parsing.

## Current Pipeline

```text
Anchor-style Rust
  -> tree-sitter parser
  -> Solana IR
  -> target emitter
  -> generated Rust
  -> CU analysis metadata
```

## Main Parts Of The Repo

### `api/`

The backend handles parsing, IR generation, emission, and demo/testing routes.

Important areas:

- `api/src/parser/`
- `api/src/ir/`
- `api/src/emitter/`
- `api/src/routes/`
- `api/src/demo-programs/`

### `web/`

The frontend is a Next.js app used for product presentation and the live playground.

## Current Status

### Strongest paths

- `counter`
- `vault`

### Useful local validation paths

- `escrow`
- `staking`

### Important recent generic improvements

- exact PDA seed preservation from Anchor account constraints
- better handling of deserialized state vs raw `AccountInfo`
- generic save emission for mutated state accounts
- better signer-seed handling for PDA-owned CPIs
- improved Pinocchio helper generation for signed system/token transfers

## What Still Needs Manual Review

Anvil is not a promise that every emitted contract is deploy-ready.

The main places to review on advanced contracts are:

- constraint semantics like `has_one`, `close`, and `init_if_needed`
- ATA/account lifecycle behavior
- escrow completion / cleanup flows
- emitted backend imports and helper compatibility
- contract-specific auth semantics that Anchor enforced structurally

## How To Test Locally

Start the API:

```bash
cd api
bun install
bun run dev
```

In another terminal, emit bundled fixtures:

```bash
cd api
bun test-run.ts counter pinocchio
bun test-run.ts vault pinocchio
bun test-run.ts escrow pinocchio
bun test-run.ts staking pinocchio
```

Try other targets:

```bash
cd api
bun test-run.ts vault quasar
bun test-run.ts vault native
```

Parse a source file directly:

```bash
curl -s http://localhost:8080/parse \
  -H 'Content-Type: application/json' \
  --data-binary @<(jq -Rs '{source: .}' api/src/demo-programs/vault.rs)
```

## Practical Rule Of Thumb

Use Anvil today as:

- a parser and IR workbench
- a contract-translation prototype
- a generator you can inspect and iterate on

Do not treat it yet as:

- a fully verified replacement for Anchor
- a zero-review contract migration tool

## Good Next Steps

1. Add fixture-based regression tests for generated outputs
2. Add compile checks for emitted backends
3. Expand constraint validation in the emitter layer
4. Add local/repo file ingestion for arbitrary contracts

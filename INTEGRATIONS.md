# Integrations

Third-party tools, frameworks, and CI pipelines that consume Anvil's emit or
IR. Public record so users can find existing integrations and adopters can see
where Anvil is wired into the broader Solana toolchain.

## Format

Each entry: `<integration> · <type> · <link> · <one-line description>`.

`type` is one of:
- **CLI / SDK** — calls Anvil from another tool
- **CI / GitHub Action** — runs Anvil in a pipeline
- **Editor / IDE** — surfaces Anvil output in an editor
- **Audit / Verification** — uses the differential harness or strict-validate

## Integrations

- **MagicBlock Ephemeral Rollups** · CLI / SDK · <https://docs.magicblock.gg> · Anchor programs built on `ephemeral-rollups-sdk` (0.16.2) transpile to Pinocchio/Native: `#[ephemeral]`/`#[delegate]`/`#[commit]` expansions, delegate/commit/undelegate CPIs, and the `process_undelegation` callback (wire-compatible discriminator). See the MagicBlock rows in [docs/feature-matrix.md](docs/feature-matrix.md).

| Integration | Type | Link | Notes |
|---|---|---|---|

## How to add yours

Open a PR appending a row above. Include the source link and a one-line
description of what your tool does with Anvil's output. We don't review for
quality — anything that calls `anvil-sol compile` or imports from the
`anvil-sol` package counts.

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

_(no entries yet — will populate as users build on Anvil)_

| Integration | Type | Link | Notes |
|---|---|---|---|

## How to add yours

Open a PR appending a row above. Include the source link and a one-line
description of what your tool does with Anvil's output. We don't review for
quality — anything that calls `anvil-sol compile` or imports from the
`anvil-sol` package counts.

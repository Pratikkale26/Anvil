# `anvil migrate` examples

Three layout fixtures that demonstrate the safety classifier:

- **`v1.json`** — baseline. Three-field UserAccount.
- **`v2.json`** — append-at-end of two new fields (`score`, `tier`). **Safe** — `anvil migrate codegen` emits a deterministic lossless body.
- **`v2-unsafe.json`** — same baseline, but with a renamed field (`authority` → `owner`) AND a retyped field (`balance: u64 → u128`). **Unsafe** — codegen emits a TODO-marked skeleton with each unsafe change explained inline.

## Try it

```bash
# Safe diff — exit 0
anvil migrate diff cli/migrate/examples/v1.json cli/migrate/examples/v2.json

# Unsafe diff — exit 2
anvil migrate diff cli/migrate/examples/v1.json cli/migrate/examples/v2-unsafe.json

# Generate the .migrate() body
anvil migrate codegen cli/migrate/examples/v1.json cli/migrate/examples/v2.json --output /tmp/migration.rs
cat /tmp/migration.rs
```

## Why this matters

Anchor v1.0 (PR #4060, Jan 2026) shipped `Migration<'info, From, To>` — a runtime container that auto-detects whether an account is in the old or new format and forces `.migrate()` before exit. The runtime is upstream; **the body of `.migrate()` is hand-written today** and is the most common source of layout-migration bugs (Ottersec, Neodyme, Sec3 audits all routinely flag these).

`anvil migrate codegen` produces the body deterministically for safe cases and forces a TODO + reason explanation for unsafe ones. Moves migration safety from "expensive auditor review" to "machine-verified at compile time."

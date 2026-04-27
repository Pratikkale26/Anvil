# anvil-sol

Anchor → Pinocchio / Native / Quasar transpiler. Pipe Anchor source through `anvil` and get a cargo-buildable project in three target Rust dialects, all from a single typed IR.

- **Live workbench:** [anvilsol.xyz](https://anvilsol.xyz)
- **Repo:** [github.com/Pratikkale26/Anvil](https://github.com/Pratikkale26/Anvil)
- **API:** `https://anvil-api-65aj4.ondigitalocean.app/`

## Install

Requires [Bun](https://bun.sh) ≥ 1.0:

```bash
# One-liner install for bun (skip if already installed)
curl -fsSL https://bun.sh/install | bash

# Install anvil-sol globally
bun install -g anvil-sol
```

Or run without installing:

```bash
bunx anvil-sol compile program.rs --target pinocchio
```

## Quickstart

```bash
# Transpile an Anchor file to a cargo-buildable Pinocchio project
anvil compile program.rs --target pinocchio --output ./out
cd ./out && cargo build

# Or to native solana-program
anvil compile program.rs --target native --output ./out

# Inspect the IR
anvil parse program.rs --json

# Portability scorecard against a target
anvil lint program.rs --target pinocchio
```

## Commands

```
anvil compile    parse → emit → validate → write project scaffold
anvil parse      Anchor source → IR (pretty or --json)
anvil validate   parse → emit → surface validator issues
anvil lint       portability scorecard (ready / review / blocker)
anvil bench      per-instruction CU comparison
anvil snapshot   capture/compare CU snapshots for CI
anvil diff       diff two IRs / programs
anvil migrate    Anchor v1.0 Migration<From, To> codegen + safety analysis
```

### `anvil migrate` (NEW in 0.3)

```bash
# Compare two account layouts and emit a safety verdict
# (exit 0 = safe / exit 2 = unsafe; CI-friendly)
anvil migrate diff old-layout.json new-layout.json

# Generate the .migrate() body — lossless deterministic Rust for safe
# diffs, TODO-marked skeleton for unsafe ones with each unsafe change
# explained inline.
anvil migrate codegen old-layout.json new-layout.json --output migration.rs
```

See `cli/migrate/examples/README.md` for the layout-file format and three demo fixtures (safe + unsafe).

Each command supports `--help`.

## Targets

| Target | Status |
|---|---|
| `pinocchio` | Hero target. 21+ MUST_PASS cargo-build regression gates. |
| `native` (`solana-program`) | Production-ready reference. 21+ MUST_PASS gates. |
| `quasar` | **Experimental**. No cargo-build coverage; some CPIs emit TODO stubs. |

## Why

Anchor brought framework velocity to launching Solana programs. The 95% of a program's lifetime AFTER launch — CU optimization, account migrations, performance regressions — has no cohesive tooling. Anvil targets the post-launch lifecycle: `compile` (Anchor → leaner runtimes), with `bench` and `migrate` shipping next.

## License

Apache-2.0

# anvil-sol

Anchor → Pinocchio / Native transpiler with a byte-equal proof gate. Pipe Anchor source through `anvil` and get a cargo-buildable project — then *prove* the transpile behaves identically to Anchor by running both binaries in a real SVM and byte-comparing the resulting on-chain state.

- **Repo:** [github.com/Pratikkale26/Anvil](https://github.com/Pratikkale26/Anvil)
- **Trust model (what the gate proves, what it doesn't):** [docs/audit-trust-model.md](https://github.com/Pratikkale26/Anvil/blob/main/docs/audit-trust-model.md)

The CLI is fully local — no account, no API, nothing leaves your machine.

## Install

Runs on **Node ≥ 20.19** (or ≥ 22.12) — no Bun required:

```bash
# Install anvil-sol globally
npm install -g anvil-sol
```

Or run without installing:

```bash
npx anvil-sol compile program.rs --target pinocchio
```

Bun works too, if you prefer it (`bun install -g anvil-sol` / `bunx anvil-sol`).

## Prerequisites by command

| You want to | You need |
|---|---|
| `compile` / `parse` / `validate` / `lint` / `advise` | Node only. (`compile`'s cargo accept gate additionally wants `cargo` — it tells you how to skip it if you don't have Rust.) |
| `verify` / `differential` / `bench` | The Solana build toolchain on PATH: `cargo-build-sbf` (Agave — `sh -c "$(curl -sSfL https://release.anza.xyz/stable/install)"`) and the `anchor` CLI for the reference build. First build of a program is slow (cargo cold cache); repeats are cached. |

## Quickstart

```bash
# Transpile an Anchor file to a cargo-buildable Pinocchio project
anvil compile program.rs --target pinocchio --output ./out
cd ./out && cargo build

# Or to native solana-program
anvil compile program.rs --target native --output ./out

# Prove it: build BOTH the Anchor reference and the Anvil output as real .so,
# synthesize a scenario from the program's IR (happy path + unauthorized-caller
# + missing-signer probes), run both under LiteSVM, and byte-compare account
# data + lamports + owner. Exit code = the verdict.
anvil verify program.rs

# Inspect the IR
anvil parse program.rs --json

# Portability scorecard against a target
anvil lint program.rs --target pinocchio
```

## Commands

```
anvil compile    parse → emit → validate → write project scaffold
anvil verify     prove byte-equal vs Anchor (build both + auto-scenario + compare)
anvil parse      Anchor source → IR (pretty or --json)
anvil validate   parse → emit → surface validator issues
anvil advise     recommend a transpile target (Pinocchio vs Native)
anvil refine     AI-patch validator errors (your ANTHROPIC_API_KEY, one call, re-validated)
anvil lint       portability scorecard (ready / review / blocker)
anvil bench      per-instruction CU comparison
anvil snapshot   capture/compare CU snapshots for CI
anvil diff       storage layout diff between two program versions
anvil migrate    Anchor v1.0 Migration<From, To> codegen + safety analysis
anvil completion shell completion (bash | zsh | fish)
anvil upgrade    update anvil-sol via npm
```

Each command supports `--help`. `verify`/`differential` also accept hand-written
JSON scenarios (`--scenario`) and fuzzing (`--fuzz N`, full-range ints) — see
`anvil verify --help` for the verdict/exit-code contract.

### Safe by default

`compile` refuses to declare success if the validator finds errors, the emit
carries `TODO(manual)` stub markers, or (when `cargo` is available) `cargo check`
rejects the output. `--permissive` / `--no-cargo-check` are the explicit opt-outs.
Unsupported constructs emit loud `unimplemented!()` stubs — never silently wrong code.

### `anvil migrate`

```bash
# Compare two account layouts and emit a safety verdict
# (exit 0 = safe / exit 2 = unsafe; CI-friendly)
anvil migrate diff old-layout.json new-layout.json

# Generate the .migrate() body — lossless deterministic Rust for safe
# diffs, TODO-marked skeleton for unsafe ones with each unsafe change
# explained inline.
anvil migrate codegen old-layout.json new-layout.json --output migration.rs
```

See `cli/migrate/examples/README.md` for the layout-file format and demo fixtures.

## Targets

| Target | Status |
|---|---|
| `pinocchio` | Hero target — byte-equal-gated + cargo-build regression-gated. |
| `native` (`solana-program`) | Reference target, gated alongside Pinocchio. |

## Why

Anchor brought framework velocity to launching Solana programs. The 95% of a program's lifetime AFTER launch — CU optimization, account migrations, performance regressions — has no cohesive tooling. Anvil targets the post-launch lifecycle: `compile` (Anchor → leaner runtimes), `verify` (prove the port), `bench` (measure the win), `migrate` (evolve the state safely).

## License

Apache-2.0

# Migrating an Anchor program to Pinocchio with Anvil

This guide walks through the practical path: take an existing Anchor program, run it through Anvil, validate the output is byte-equal to the original, and deploy the result.

## TL;DR

```bash
# 1. Install
npm install -g anvil-sol

# 2. Transpile
anvil-sol compile ./my-anchor-program --target pinocchio --output ./my-pinocchio-program

# 3. Verify byte-equal (write a scenario.json — see docs/differential-testing.md)
anvil-sol differential ./my-anchor-program --scenario scenario.json

# 4. Deploy from ./my-pinocchio-program/ — it's a normal cargo project
cd my-pinocchio-program && cargo-build-sbf
solana program deploy target/deploy/my_program.so
```

The headline correctness signal is step 3. Cargo green is necessary but not sufficient — runtime byte-equal is the actual gate.

## What gets transpiled cleanly

Most Anchor programs compile through cleanly today if they use:

- `#[program]` instruction handlers with primitive args (uN/iN/bool/Pubkey).
- `#[derive(Accounts)]` with `init`, `init_if_needed`, `mut`, `has_one`, `close`, `seeds`, `bump`, `realloc`.
- PDA derivations + signer seeds.
- `require_*!`, `msg!`, `emit!`.
- System program `transfer`.
- SPL Token: `transfer`, `mint_to`, `burn`, `close_account`, `set_authority`, ATA `create`, Memo, Token-2022 `_checked` variants.

See the [feature matrix](feature-matrix.md) for the per-target detail.

## What needs hand-tuning

Anvil emits explicit `// TODO(manual): <reason>` markers when it can't safely transform a section. The output validator hard-rejects these on `--strict`, so a deploy-gated build won't ship them silently.

You'll see a TODO marker for:

- **External CPIs to programs Anvil doesn't have an IR kind for** (Pyth, Switchboard, Metaplex Token Metadata, custom DeFi protocols). The original `CpiContext::new(...)` call is commented out with a marker; you write the equivalent `pinocchio::cpi::invoke` by hand or wait for the corresponding IR kind to land.
- **Zero-copy accounts (`#[account(zero_copy)]`)** — not yet supported.
- **Vec/struct args on instructions** — Anvil's discriminator + arg-decode prelude only handles primitives. You'd hand-write the Borsh deserialize.
- **Impl methods called as `ctx.accounts.foo()`** — partial support; some shapes need manual inlining.

When you hit these, the workflow is:

1. Run `anvil-sol compile ... --strict` — it refuses to write output with TODO markers.
2. Drop `--strict`, get the output, find the markers (validator surfaces them in the workbench / CLI output).
3. Hand-port those sections.
4. **Run the differential gate against your hand-port**: write a `scenario.json` covering the shapes that hit the markers, run `anvil-sol differential` — byte-equal is the proof your hand-port matches the Anchor original.

This last step is the core idea: even if Anvil can't auto-port everything, the byte-equal harness is reusable as a sanity gate on your hand-porting work.

## Step-by-step example

### Pre-flight checks

```bash
# Toolchain
cargo --version           # any recent Rust
cargo-build-sbf --version # platform-tools v1.52+ recommended
anchor --version          # 0.31+ recommended
```

### 1. Transpile

```bash
anvil-sol compile ./my-anchor-program --target pinocchio --output ./my-pinocchio-program
```

This emits a complete Cargo project under `./my-pinocchio-program/`:

```
my-pinocchio-program/
├── Cargo.toml             # pinocchio + pinocchio-system + pinocchio-token deps
├── README.md              # generated, links back to Anvil
├── rust-toolchain.toml
├── src/
│   ├── lib.rs             # entrypoint + dispatcher
│   ├── state.rs           # #[repr(C, packed)] structs + manual Borsh
│   ├── errors.rs
│   ├── instructions/
│   │   ├── mod.rs
│   │   ├── initialize.rs
│   │   └── ...
│   └── helpers.rs
└── scripts/
    └── deploy.sh
```

### 2. Verify it compiles

```bash
cd my-pinocchio-program
cargo-build-sbf
```

If this fails, check for:

- **Validator errors** in the generated output — `// ⚠️ Anvil` markers indicate sections the emitter explicitly couldn't transform.
- **External CPI imports** that Anvil preserved but the target framework doesn't have. The portability lint (`anvil-sol lint`) flags these per-target.
- **AI Refine** — if you have an `ANTHROPIC_API_KEY` set, the workbench's "Verify + Auto-fix with AI" button feeds rustc errors to Sonnet 4.6 and applies patches with revert-on-regression. The CLI doesn't have this loop today; use the workbench at `anvilsol.xyz` if you want it.

### 3. Verify it's byte-equal

This is the step most migrations skip — and the step that catches subtle divergences (wrong CPI account order, off-by-one Borsh layout, missing `bump`).

Write a `scenario.json` that exercises the instructions you care about. See [Differential testing](differential-testing.md) for the format.

```bash
anvil-sol differential ./my-anchor-program --scenario scenario.json
```

If byte-equal across all compared accounts: you're good. The migration is verifiably correct on the patterns your scenario covers.

If divergent: the CLI prints the offset of the first differing byte. Common causes:

- **Account order mismatch**: your scenario's `accounts[]` is positional against the IR's parsed order. If Anchor's `#[derive(Accounts)]` declares `[counter, authority, system_program]`, the scenario must list them in that order.
- **Args mismatch**: Anchor 0.31's `start_value: u64` deserializes as 8 LE bytes after the discriminator. The scenario runner does this from the IR; if a divergence is in the args, the IR didn't pick up the type correctly — file an issue with the source.
- **Real emit divergence**: file an issue with the diff details. The harness's job is to fail loudly when this happens.

### 4. Deploy

```bash
cd my-pinocchio-program
cargo-build-sbf
solana program deploy target/deploy/my_program.so
```

Standard Solana deploy. Generated programs use the same `declare_id!()` as the Anchor source so program IDs are preserved.

## After migration

- **Re-run the differential gate periodically.** Bump Anvil version, re-emit, re-run scenario, confirm still byte-equal. Catches Anvil regressions that affect your specific program shape.
- **Wire the gate into your CI.** Cache `~/.anvil-diff-cache/` between runs (source-hash-keyed, so unchanged source hits cache instantly). A green PR badge that means "every byte of generated state matches the Anchor original" is one workflow file away.
- **Monitor CU savings.** Run `bun scripts/measure-cu.ts` (in the Anvil repo) against your deployed Pinocchio program vs the original Anchor reference. Expect 60–95% reduction depending on the workload (see [feature matrix](feature-matrix.md) for benchmark numbers).

## When to NOT migrate

- **Heavy zero-copy account use** (Drift / Mango shape) — wait for that emit path.
- **Heavy Pyth / Switchboard / Metaplex Token Metadata external CPIs** — wait for those IR kinds, or accept the hand-port load.
- **Programs with deeply custom Borsh shapes on instruction args** — JSON scenarios refuse, hand-written fixtures work but the manual port is correspondingly larger.

## Reporting issues

- Parser/emit divergence: open an issue with a minimal reproduction (single Anchor file + the divergent scenario).
- Differential gate output mismatch: include the byte offset and your scenario.json.
- Workbench / API hiccups: `https://anvil-prod-api-wff8f.ondigitalocean.app/health` returns the running release SHA + sandbox kind; include that in the issue.

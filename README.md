# Anvil

> **Anchor → Pinocchio, with proof.** Paste an Anchor program in, get a cargo-buildable Pinocchio project out — verified byte-equal to the original by running both inside a real VM.

[anvilsol.xyz](https://anvilsol.xyz) · [npm](https://www.npmjs.com/package/anvil-sol) · [docs](docs/) · [security](SECURITY.md)

---

The reason most Anchor programs stay on Anchor isn't that anyone prefers it for production — it's that hand-rewriting 2,000–10,000 lines of Rust to a leaner runtime carries unacceptable correctness risk. Anvil removes that risk:

```bash
# 1. Migrate
anvil-sol compile ./my-anchor-program --target pinocchio -o ./my-pinocchio

# 2. Prove it
anvil-sol differential ./my-anchor-program --scenario scenario.json
#   ✓ BYTE-EQUAL — all N compared account(s) match.
```

Step 2 is the part nobody else ships. It builds your Anchor source AND the Anvil-emitted Pinocchio version into separate `.so` files, runs the same instruction sequence against both inside [LiteSVM](https://github.com/litesvm/litesvm), and asserts every byte of every account matches at the end. Anything else — wrong CPI account order, missing bump, off-by-one Borsh layout — fails the gate loudly.

Cargo green is necessary but not sufficient. This is the actual correctness signal.

---

## What's verified today

**9 byte-equal differential fixtures** lock these emit shapes against the Anchor reference on every commit:

| Fixture | Surface |
|---|---|
| `counter` | Account init + state mutation |
| `vault` | PDA-as-vault + signer-seeded `system_program::transfer` |
| `has-one` | Runtime constraint enforcement (`has_one = X`) |
| `ata-mint` | ATA create + SPL `mint_to` CPI |
| `spl-transfer` | `token::transfer` CPI |
| `spl-burn` | `token::burn` CPI |
| `t22-transfer` | Token-2022 `transfer_checked` (mint decimals extraction) |
| `close-account` | `close = receiver` rent refund + reap |
| `set-authority` | Hand-rolled raw SPL `set_authority` on Pinocchio |

`bun test api/tests/differential-*.test.ts` runs all 9 + the AI-under-differential framework smoke. Plus 36+ deterministic real-world cargo-build regression gates from `solana-developers/program-examples`.

### Measured CU savings on bundled demos

Built both as Anchor original and Anvil-emitted Pinocchio, deployed to `solana-test-validator`, run side-by-side. Best-case across 5 trials per side (controls for `find_program_address` bump-iteration variance).

| Instruction | Anchor CU | Anvil-Pinocchio CU | Saved |
|---|---:|---:|---:|
| `counter::initialize(start_value=10)` | 6,074 | 3,268 | **46%** |
| `counter::increment(amount=5)` | 2,753 | 1,801 | **35%** |
| `escrow::create_escrow(seed=42, amount=250000)` | 43,720 | 31,413 | **28%** |

For SPL-heavy workloads (transfers, mints, burns), the savings are larger — Helius's hand-written p-token Pinocchio implementations measure 97-98% CU reduction vs SPL-Token-via-Anchor on those primitives, and Anvil's `cpi_spl_*` emit uses the same `pinocchio_token` builders. See [docs/feature-matrix.md](docs/feature-matrix.md#cu-savings) for the full breakdown.

Reproduce: `solana-test-validator --reset --quiet &` in one terminal, then `bun scripts/measure-cu.ts` in another.

What we **don't** claim:

- AI-patched output is **not** under the differential corpus. The workbench surfaces a persistent yellow banner whenever AI patches are present; audit before deploy.
- The CU table in the workbench is a heuristic estimator (constant-table per-construct sum). The measurement script above is the source of truth for absolute numbers.
- Quasar is emitter-clean but has no cargo coverage. Disabled in the workbench picker; available via `anvil-sol compile --target quasar` for inspection.

---

## Try it in 30 seconds

```bash
git clone https://github.com/Pratikkale26/Anvil && cd Anvil
bun install && cd cli && bun install && cd ..

# Transpile a bundled demo and cargo-build it
bun cli/anvil.ts compile api/src/demo-programs/counter.rs --target native -o /tmp/counter-native
cd /tmp/counter-native && cargo build
```

Or use the public workbench: paste source at [anvilsol.xyz](https://anvilsol.xyz), pick a target, download the bundle.

## Anchor in, native out

A handler from `counter.rs`:

```rust
pub fn increment(ctx: Context<Update>, amount: u64) -> Result<()> {
    let counter = &mut ctx.accounts.counter;
    counter.count = counter.count.checked_add(amount).ok_or(CounterError::Overflow)?;
    Ok(())
}
```

What Anvil emits for `--target native` (abbreviated):

```rust
pub fn increment(program_id: &Pubkey, accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {
    if accounts.len() < 2 { return Err(ProgramError::NotEnoughAccountKeys); }
    let counter = &accounts[0];
    let authority = &accounts[1];

    if !authority.is_signer { return Err(ProgramError::MissingRequiredSignature); }
    if !counter.is_writable { return Err(ProgramError::InvalidAccountData); }
    if counter.owner != program_id { return Err(ProgramError::IncorrectProgramId); }

    let amount = u64::from_le_bytes(data[..8].try_into()
        .map_err(|_| ProgramError::InvalidInstructionData)?);

    let (expected, _bump) = Pubkey::find_program_address(
        &[b"counter", authority.key.as_ref()], program_id);
    if expected != *counter.key { return Err(ProgramError::InvalidSeeds); }

    let mut state = CounterAccount::read(&counter.data.borrow())?;
    if state.authority != *authority.key {
        return Err(ProgramError::InvalidAccountData);
    }
    state.count = state.count.checked_add(amount).ok_or(CounterError::Overflow)?;
    CounterAccount::write(&mut counter.data.borrow_mut(), &state)?;
    Ok(())
}
```

Discriminator routing, signer / writable / owner checks, args decoding, PDA derivation, manual Borsh — all generated.

For the equivalent Pinocchio output and side-by-side comparison, see the workbench's "Compare targets" view.

---

## Pipeline

```
Anchor source → tree-sitter → Solana IR (Zod, 17 body kinds) → {Pinocchio, Native, Quasar} emit → Validator
                                                  │
                                                  └──► Differential harness (LiteSVM byte-equal)
```

Same IR feeds the emitters, the lint / bench / snapshot / diff CLI commands, the workbench's compare-targets view, and the AI refine validator. No pass duplicates parsing.

For detail: [docs/architecture.md](docs/architecture.md).

---

## What works (per target)

Pinocchio is the production target. Native is the reference. Quasar is experimental.

Quick read: parser at 100% on 27 real-world programs; SPL Token + Token-2022 + ATA + Memo + System CPIs all green; account constraints (`init`, `init_if_needed`, `mut`, `has_one`, `close`, `seeds`, `bump`, `realloc`) all green.

Full matrix and known gaps: [docs/feature-matrix.md](docs/feature-matrix.md).

---

## CLI

```
anvil-sol compile <input> --target <pinocchio|native|quasar> [-o <dir>] [--strict]
anvil-sol differential <input> [--scenario s.json] [--anchor-so path.so]
anvil-sol parse <input> [--json]
anvil-sol validate <input> --target <target> [--json]
anvil-sol lint <input> --target <target> [--markdown]
anvil-sol bench <input> [--markdown]
anvil-sol snapshot <input> --save | --check
anvil-sol diff <before> <after> [--markdown]
```

`--strict` on `compile` refuses to write output when the validator finds errors or the emit contains `TODO(manual)` markers — gate this before deploy.

`differential --scenario` runs the byte-equal correctness gate against your own program. See [docs/differential-testing.md](docs/differential-testing.md) for the JSON format.

---

## Workbench

The web playground at [anvilsol.xyz](https://anvilsol.xyz):

- Paste / file / folder / GitHub repo ingestion.
- Live emit + CU heuristic per instruction.
- AI refine with revert-on-regression (Sonnet 4.6, $0.50 per-request cap, $2/IP/day cap).
- **Verify Build** — segmented Check / Build / Deploy:
  - **Check** (`cargo check`, ~3s, runs automatically on every emit).
  - **Build** (`cargo build`, ~10–15s, catches linker + codegen).
  - **Deploy** (`cargo build-sbf`, ~30s–2min, produces a deployable `.so`).
  - SSE-streamed cargo output, cancel-on-disconnect.
- Project-bundle download (full Cargo project as `.tar`).

---

## Public API

`/parse` `/emit` `/lint` `/build` `/build/auto-fix` `/ai/refine` `/demo` `/health` `/metrics`. Every cargo invocation runs inside firejail / bwrap / unshare with prlimit caps and a stripped env (no `ANTHROPIC_API_KEY`-class secrets reach user code). Per-IP daily AI spend cap, per-IP build-sbf concurrency cap, per-minute rate limit.

Threat model: [SECURITY.md](SECURITY.md). Production deploy reqs are listed at the bottom.

`/health` returns release SHA + sandbox kind + prompt version + toolchain availability; `/metrics` returns refine cache hit rate, accept-rate per prompt version, build success/failure, p50/p95/p99 build latency, per-IP spend snapshot.

---

## Project layout

```
api/    Bun + Express service: parse, emit, validate, build, AI refine, sandbox
cli/    anvil-sol — npm CLI, ships api/src bundled via prepack
web/    Next.js workbench
docs/   Architecture, differential testing, feature matrix, migration guide
```

---

## Status

v0.3.4. **Live at [anvilsol.xyz](https://anvilsol.xyz)**, public API at [`anvil-prod-api-wff8f.ondigitalocean.app`](https://anvil-prod-api-wff8f.ondigitalocean.app). 118+ tests passing, 9 byte-equal differential fixtures, 36+ real-world cargo regressions, hardened sandbox.

Working notes for grant + migration: [docs/migration-guide.md](docs/migration-guide.md).

## License

Apache 2.0. See [LICENSE](LICENSE).

## Contributing

Issues + PRs welcome. Areas where help is most useful: new differential fixtures (the harness is designed for ~30-line additions — see [docs/differential-testing.md](docs/differential-testing.md)), Pyth / Switchboard / Metaplex IR kinds, real-world Anchor programs that fail to transpile (file the source + the divergence).

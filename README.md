# Anvil

> **Anchor → Pinocchio, with proof.** Paste an Anchor program in, get a cargo-buildable Pinocchio project out — verified byte-equal on `data + lamports + owner` against the Anchor original by running both inside a real VM.

[anvilsol.xyz](https://anvilsol.xyz) · [npm](https://www.npmjs.com/package/anvil-sol) · [docs](docs/) · [security](SECURITY.md) · [audit trust model](docs/audit-trust-model.md)

---

The reason most Anchor programs stay on Anchor isn't that anyone prefers it for production — it's that hand-rewriting 2,000–10,000 lines of Rust to a leaner runtime carries unacceptable correctness risk. Anvil removes that risk:

```bash
# 1. Migrate
anvil-sol compile ./my-anchor-program --target pinocchio -o ./my-pinocchio

# 2. Prove it
anvil-sol differential ./my-anchor-program --scenario scenario.json
#   ✓ BYTE-EQUAL — all N compared account(s) match.
```

Step 2 is the part nobody else ships. It builds your Anchor source AND the Anvil-emitted Pinocchio version into separate `.so` files, runs the same instruction sequence against both inside [LiteSVM](https://github.com/litesvm/litesvm), and asserts every account's `data`, `lamports`, AND `owner` byte-equal at the end. Anything else — wrong CPI account order, missing bump, off-by-one Borsh layout, account left assigned to the wrong program — fails the gate loudly. Event log payloads (`emit!`) are NOT compared today; the CLI refuses to run on `emit!()`-using sources unless you pass `--ignore-events` to acknowledge the gap. See [docs/audit-trust-model.md](docs/audit-trust-model.md).

Cargo green is necessary but not sufficient. This is the actual correctness signal.

---

## What's verified today

**73 byte-equal differential fixtures** lock these emit shapes against the Anchor reference on every commit. **Data + lamports + owner all byte-compared in a real VM** — not just `cargo build` green, not just IDL match. The MPL Token Metadata + Pyth Receiver `.so` are bundled as test fixtures and loaded into LiteSVM via `svm.addProgram` so CPI shape correctness is also verified end-to-end. **MPL byte-equal coverage 11/12** as of 2026-05-19: `create_metadata_v3` (with full DataV2 support — creators, collection, uses), `create_master_edition_v3`, `update_metadata_accounts_v2`, `set_and_verify_collection`, `freeze_delegated`, `thaw_delegated`, `approve_collection_authority`, `revoke_collection_authority`, `mint_new_edition_from_master_edition`, `sign_metadata`, `verify_collection`. **Composite `#[derive(Accounts)]` flatten** shipped end-to-end with BYTE_EQUAL on real `:8899` validator for Anchor org composite example — Drift v2 / Mango v4 / Squads v4 coverage unblocked.

### 6 real-world Anchor programs verified byte-equal

These are externally-authored programs cloned verbatim from public repos. Anvil's emit produces post-scenario state byte-identical to the Anchor reference under the same scenario:

| Program | Source | Surface |
|---|---|---|
| `anchor-escrow-2025` | mikemaccana/anchor-escrow-2025 | PDA + non-ATA token init + `token::transfer` |
| `coral-events` | coral-xyz/anchor test corpus | `emit!()` event log + multi-field borsh payload |
| `favorites` | solana-developers/program-examples | `init_if_needed` + `String` + `Vec<String>` (max_len) |
| `account-data` | solana-developers/program-examples | 3× `String` fields under `#[max_len(50)]` |
| `pda-rent-payer` | solana-developers/program-examples | Signer-seeded `system_program::create_account` |
| `page-visits` | solana-developers/program-examples | Smallest possible PDA-init (5-byte struct) |

### 37 demo byte-equal fixtures (representative subset)

| Fixture | Surface |
|---|---|
| `counter` | Account init + state mutation |
| `vault` | PDA-as-vault + signer-seeded `system_program::transfer` |
| `has-one` | Runtime constraint enforcement (`has_one = X`) |
| `ata-mint` | ATA create + SPL `mint_to` CPI |
| `spl-transfer` | `token::transfer` CPI |
| `spl-burn` | `token::burn` CPI |
| `t22-transfer` | Token-2022 `transfer_checked` (mint decimals extraction) |
| `close` | `close = receiver` rent refund + reap |
| `set-authority` | Hand-rolled raw SPL `set_authority` on Pinocchio |
| `escrow` | PDA init + non-ATA token init (`init token::*` vault) + canonical vault PDA `[b"vault", escrow]` (substitution-attack-proof) + `token::transfer` |
| `marketplace` | NFT marketplace state shape (admin + fee_bps + treasury) |
| `event-emit` | `emit!()` discriminator + borsh payload via `sol_log_data` |
| `staking` | Full SPL pool init — canonical `stake_vault` + `reward_vault` PDAs, `address = pool.reward_mint` constraint, snapshotted reward rate per stake |
| `simple-staking` | SOL-only stake/claim with clock-pinned + `emit!` + msg/return-data triple parity |
| `amm` | Constant-product pool with LP mint + protocol-fee accumulator (post-audit shape) |
| `multisig` | m-of-n signer enforcement, executor-must-be-owner check |
| `realloc` / `realloc-grow` | Vec resize with rent-delta accounting |
| `vesting` | Schedule + cliff + claim math + close-with-empty-vault precondition |

Plus 22 more covering `bumps_access`, `init_if_needed`, `cpi_custom`, `cpi_memo`, sysvars, return data/err, msg logs, T22 extension family (NonTransferable, ImmutableOwner, DefaultAccountState, InterestBearingMint, TokenMetadata, TransferFee), MPL Token Metadata (`create_metadata_v3` + `create_master_edition_v3` + `update_metadata_accounts_v2` byte-equal under a chained scenario via the staged `mpl_token_metadata.so` loaded into LiteSVM), and others. `bun test api/tests/differential-*.test.ts` runs the full set.

Plus 50+ deterministic real-world cargo-build regression gates from `solana-developers/program-examples` and the `coral-xyz/anchor` test corpus.

### Measured CU savings on bundled demos

Built both as Anchor original and Anvil-emitted Pinocchio, deployed to `solana-test-validator`, run side-by-side. Best-case across 5 trials per side (controls for `find_program_address` bump-iteration variance).

| Instruction | Anchor CU | Anvil-Pinocchio CU | Saved |
|---|---:|---:|---:|
| `counter::initialize(start_value=10)` | 6,074 | 3,268 | **46%** |
| `counter::increment(amount=5)` | 2,753 | 1,801 | **35%** |
| `vault::initialize` | 9,384 | 4,893 | **48%** |
| `vault::deposit(amount=1_000_000_000)` | 6,726 | 4,674 | **31%** |
| `vault::withdraw(amount=500_000_000)` | 6,758 | 4,716 | **30%** |
| `escrow::create_escrow(seed=42, deposit=250000, receive=500000)` | 26,614 | 16,133 | **39%** |

For SPL-heavy workloads (transfers, mints, burns), the savings are larger — Helius's hand-written p-token Pinocchio implementations measure 97-98% CU reduction vs SPL-Token-via-Anchor on those primitives, and Anvil's `cpi_spl_*` emit uses the same `pinocchio_token` builders. See [docs/feature-matrix.md](docs/feature-matrix.md#cu-savings) for the full breakdown.

Reproduce: `solana-test-validator --reset --quiet &` in one terminal, then `bun scripts/measure-cu.ts` in another.

What we **don't** claim:

- **AI patches now have a default-on differential gate.** `/build/auto-fix` runs the byte-equal compare after each cargo-green iteration whenever the request body carries `differential: { anchorSource, scenario, ... }`; patches that compile but diverge at runtime are flagged and fed back to the next refine call. The workbench's auto-fix card shows a green "✓ byte-equal verified" badge when the gate passes vs a yellow "⚠ diverged" badge when it doesn't. Pass `?with_differential=0` to skip the gate without restructuring the body. When the request omits the `differential` body entirely (no Anchor reference available), the workbench's persistent yellow banner reminds you to audit before deploy.
- The CU table in the workbench is a heuristic estimator (constant-table per-construct sum). The measurement script above is the source of truth for absolute numbers.
- Quasar emit was deleted from the production path on 2026-05-05 (Blueshift hadn't shipped a stable 1.0). Pinocchio + Native are the supported targets.

---

## Try it in 30 seconds

**Requires [Bun](https://bun.sh) ≥ 1.0.0** as the runtime. The CLI is published as `anvil-sol` and runs under Bun (not Node) — `bun add -g anvil-sol` or invoke with `bunx anvil-sol …`. The full repo also runs under Bun for tests + the dev server.

```bash
git clone https://github.com/Pratikkale26/Anvil && cd Anvil
bun install && cd cli && bun install && cd ..

# Transpile a bundled demo and cargo-build it. (v0.4+ writes the project
# only when the safe-by-default gate passes; pass --permissive to write
# stub-bearing emit anyway — explore mode only.)
bun cli/anvil.ts compile api/src/demo-programs/counter.rs --target native -o /tmp/counter-native
cd /tmp/counter-native && cargo build

# Or run the differential gate against a bundled scenario:
bun cli/anvil.ts differential api/src/demo-programs/counter.rs \
    --scenario examples/differential/counter.json --fuzz 100
# → 100/100 byte-equal on randomized scalar args
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
Anchor source → tree-sitter → Solana IR (Zod, 23 body kinds) → {Pinocchio, Native} emit → Validator
                                                  │
                                                  └──► Differential harness (LiteSVM byte-equal: data + lamports + owner)
```

Same IR feeds the emitters, the lint / bench / snapshot / diff CLI commands, the workbench's compare-targets view, and the AI refine validator. No pass duplicates parsing.

For detail: [docs/architecture.md](docs/architecture.md).

---

## What works (per target)

Pinocchio is the production target. Native is the reference.

Quick read: parser at 100% on 27 real-world programs; SPL Token + Token-2022 + ATA + Memo + System CPIs all green; full 12-slot Metaplex Token Metadata catalog emits real CPIs (no stubs); Pyth oracle reads (both legacy `pyth_sdk_solana` and modern `pyth_solana_receiver_sdk` PriceUpdateV2 paths) transpile to hand-rolled byte deserialization with magic-header + feed-id cross-check; account constraints (`init`, `init_if_needed`, `mut`, `has_one`, `close`, `seeds`, `bump`, `realloc`) all green; `#[derive(InitSpace)]` + `#[max_len]` honored.

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

`/parse` `/emit` `/lint` `/build` `/build/auto-fix` `/build/differential` `/build/differential/auto-scenario` `/ai/refine` `/ai/diagnose-differential` `/evidence` `/demo` `/health` `/metrics`. Every cargo invocation runs inside firejail / bwrap / unshare with prlimit caps and a stripped env (no `ANTHROPIC_API_KEY`-class secrets reach user code). Per-IP daily AI spend cap, per-IP build-sbf concurrency cap, per-minute rate limit.

`/build/auto-fix` accepts an additional `differential` body field with `anchorSource` + `scenario`. When that field is present, the byte-equal compare runs after each cargo-green iteration (default-on; pass `?with_differential=0` to skip). On `DIVERGED`, synthetic `differential_diverge` ValidationIssues feed back into the next refine call so patches converge toward both compile-AND-byte-equal. `finalPayload.differentialVerdict` carries the terminal verdict for badge consumption.

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

v0.4.0 — **safe-by-default** (`--strict` is the new CLI default; `--permissive` is the opt-out). See [CHANGELOG.md](CHANGELOG.md) for the BREAKING-change migration notes. Full Metaplex Token Metadata CPI catalog (12/12 slots) + Token-2022 extension space cross-check + ⚠ marker linkage shipped 2026-05-18. **Live at [anvilsol.xyz](https://anvilsol.xyz)**, public API at [`anvil-prod-api-wff8f.ondigitalocean.app`](https://anvil-prod-api-wff8f.ondigitalocean.app). **1417 passing tests across 123 fast-suite files** (excluding env-gated differential + SBF-toolchain suites): 73 byte-equal differential fixtures (T22 family + MPL Token Metadata 12-IR-kind catalog + Pyth oracle + 14 real-world Anchor programs via diff-arc Phase B/C) + 77 realworld cargo regressions + parser / emitter / validator / sandbox / AI suites + marker-validator linkage + IR roundtrip sweep. Source of truth: `bun scripts/count-tests.ts`.

Working notes for grant + migration: [docs/migration-guide.md](docs/migration-guide.md).

## License

Apache 2.0. See [LICENSE](LICENSE).

## Contributing

Issues + PRs welcome. Areas where help is most useful: new differential fixtures (the harness is designed for ~30-line additions — see [docs/differential-testing.md](docs/differential-testing.md)), Switchboard oracle IR kinds (Pyth legacy + modern both supported as of M2/N5b — see api/src/demo-programs/pyth-read-{legacy,modern}.rs), Metaplex differential-against-real-bytecode fixtures, real-world Anchor programs that fail to transpile (file the source + the divergence).

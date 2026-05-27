# Differential testing — byte-equal correctness

The differential layer is Anvil's correctness spine. It compares your Anvil-emitted Pinocchio program against the original Anchor source by running both inside LiteSVM with identical inputs and asserting byte-equal account state after every instruction.

This document covers two ways to use it:

1. **`anvil-sol differential <program> --scenario s.json`** — one-command CLI you run on your own Anchor program before / after migrating.
2. **`api/tests/differential-harness.ts`** — TypeScript fixtures used internally to gate Anvil's emitter on every commit.

Most users want option 1. Option 2 is for cases where the JSON scenario can't express your inputs (Vec/struct args, custom multi-step state machines).

---

## What it actually does

```
┌─────────────────────────────────────────────────────────────────┐
│  setup() — one keypair set + one PDA derivation, shared by both │
└──────────────────────┬──────────────────────────────────────────┘
                       │
        ┌──────────────┴──────────────┐
        ▼                             ▼
┌────────────────┐            ┌────────────────┐
│ Anchor scenario│            │ Anvil scenario │
│   (anchor.so)  │            │   (anvil.so)   │
│                │            │                │
│  for each ix:  │            │  for each ix:  │
│    sendTx ──►  │            │    sendTx ──►  │
└──────┬─────────┘            └────────┬───────┘
       │ post-state                    │ post-state
       ▼                               ▼
   account snapshots              account snapshots
       │                               │
       └───────────┬───────────────────┘
                   ▼
       byte-compare data + lamports
```

Identical setup + identical inputs + identical instruction sequence → identical post-state, byte for byte. Any divergence in the emit (wrong CPI account order, missing bump, off-by-one Borsh layout) fails the compare loudly.

The clock and slot are pinned across both scenarios (default `1_700_000_000` / slot `1`) so any program reading `Clock::get()` sees identical values.

---

## Option 1 — JSON-scenario CLI

### Install

```bash
npm install -g anvil-sol
# Optional peer deps for the differential subcommand (lazy-loaded; only needed
# if you pass --scenario):
npm install -g litesvm @solana/web3.js @noble/hashes
```

### Write a scenario

A scenario is a small JSON file describing the instructions to run and the accounts to compare:

```json
{
  "programId": "Counter111111111111111111111111111111111111",
  "signers": [
    { "name": "authority", "airdrop": 1000000000 }
  ],
  "pdas": [
    { "name": "counter_pda", "seeds": ["counter", "$authority.pubkey"] }
  ],
  "instructions": [
    {
      "ix": "initialize",
      "args": { "start_value": 10 },
      "accounts": ["counter_pda", "authority", "system_program"]
    },
    {
      "ix": "increment",
      "args": { "amount": 5 },
      "accounts": ["counter_pda", "authority"]
    }
  ],
  "compare": [
    { "name": "counter_pda" }
  ]
}
```

A runnable copy of this scenario lives at [`examples/differential/counter.json`](../examples/differential/counter.json) — drop it into your project as a starting template and adapt to your own program.

### Run

```bash
anvil-sol differential ./my-program --scenario scenario.json
```

If your program imports `anchor-spl`, `mpl-core`, `pyth-sdk-solana`, or any
crate beyond `anchor-lang`, the Anchor reference build needs them in scope.
Pass them with `--anchor-extra-deps`:

```bash
anvil-sol differential ./my-program --scenario s.json \
  --anchor-extra-deps 'anchor-spl = "0.31"' \
  --anchor-extra-deps 'spl-token = "7.0"'
```

Or use a file (cleaner when there are several):

```bash
cat > extra-deps.toml <<EOF
anchor-spl = "0.31"
spl-token = "7.0"
EOF
anvil-sol differential ./my-program --scenario s.json --anchor-extra-deps-file extra-deps.toml
```

Without these, programs using non-`anchor-lang` crates fail at the reference
build with `error[E0432]: unresolved import`. The CLI surfaces an actionable
hint pointing here when the build fails and no extra-deps were provided.

The CLI:

1. Parses your Anchor source → Solana IR.
2. Builds Anvil-Pinocchio `.so` via `cargo-build-sbf`.
3. Builds an Anchor reference `.so` from the same source (or skips with `--anchor-so path.so`).
4. Generates deterministic keypairs (sha256(programId || signer.name)) so re-runs use identical addresses.
5. Derives PDAs from `seeds` with `$<signer>.pubkey` substitution.
6. Encodes each instruction's data: 8-byte Anchor discriminator + Borsh-packed args from IR types.
7. Runs the sequence in two LiteSVM instances (one per `.so`).
8. Byte-compares each `compare` account's data + lamports.
9. Exit 0 (green) or 2 (divergence with offset details).

Caches built `.so` files under `~/.anvil-diff-cache/<fixture>-<source-hash>/` so subsequent runs skip the rebuild step.

### Scenario reference

| Field | Type | Meaning |
|---|---|---|
| `programId` | base58 string | Program ID. The same ID is loaded into both LiteSVM instances. |
| `signers[].name` | string | Friendly name. Used in `pdas[].seeds` substitution and `instructions[].accounts`. |
| `signers[].airdrop` | number | Lamports to airdrop in setup. Default 1 SOL. |
| `pdas[].name` | string | Friendly name. Referenced in `instructions[].accounts` and `compare[].name`. |
| `pdas[].seeds` | string[] | Seed list. `"literal"` → UTF-8 bytes; `"$signer.pubkey"` → that signer's pubkey bytes. |
| `instructions[].ix` | string | Instruction name as in the parsed IR (matches `pub fn <name>` in the Anchor source). |
| `instructions[].args` | object | Map arg-name → value. Only primitive types: u8/u16/u32/u64/u128, i8…i128, bool, Pubkey. |
| `instructions[].accounts` | string[] | Account list, **positional** against the IR's parsed account struct. Names resolve via `signers` / `pdas` / built-ins. |
| `compare[].name` | string | Account to byte-compare post-scenario. |
| `compare[].stripDiscriminator` | bool | Default `true`. Strips the 8-byte Anchor discriminator before compare; set `false` for raw SPL Token accounts. |
| `compare[].compareLamports` | bool | Default `true`. |
| `pinClockTimestamp` | number | Override the pinned clock (default `1_700_000_000` Unix). |
| `pinClockSlot` | number | Override the pinned slot (default `1`). |

Built-in account names (no need to declare in `signers` or `pdas`):
`system_program`, `token_program`, `token_2022_program`, `associated_token_program`, `rent`, `clock`.

### Supported and unsupported arg types

Supported: `u8` `u16` `u32` `u64` `u128` `i8`–`i128` `bool` `Pubkey`.

Refused (by design): `String`, `Vec<T>`, `Option<T>`, custom structs / enums. Silently wrong Borsh would defeat the gate's purpose. For these, hand-write a fixture using `differential-harness.ts` (option 2 below).

### Exit codes

| Code | Meaning |
|---|---|
| 0 | All compared accounts byte-equal across runs (or build-only mode if `--scenario` omitted). |
| 1 | Build / parse / scenario-load failure. |
| 2 | Byte-equal compare failed — diff details printed. |

---

## Option 2 — Hand-written TypeScript fixtures

When the JSON scenario can't express your inputs, write a TypeScript fixture against the harness directly. The bundled fixtures in `api/tests/differential-*.test.ts` are the templates.

```ts
import { defineDifferential, anchorIxDiscriminator, encodeU64LE,
         concatBytes, Keypair, PublicKey, LiteSVM } from "./differential-harness.ts";

defineDifferential({
  fixtureName: "my-program",
  programIdBase58: "...",
  anchorSource: readFileSync(SRC, "utf-8"),
  anchorPackageName: "my_program_anchor_diff",

  setup: async () => {
    const authority = Keypair.generate();
    const programId = new PublicKey("...");
    const [pda] = PublicKey.findProgramAddressSync(/* seeds */, programId);
    return { authority, pda };
  },

  callScript: async (svm, ctx, programId) => {
    svm.airdrop(ctx.authority.publicKey, BigInt(2_000_000_000));
    // build TransactionInstruction(s) with whatever shape you need —
    // Vec<u8>, custom structs, multi-step state machines, etc.
    // ...
  },

  accountsToCompare: (ctx) => [
    { pubkey: ctx.pda, label: "my_state" },
  ],
});
```

The harness handles the rest: build Anchor + Anvil `.so`, run scenarios in lockstep, byte-compare, fail on divergence with the offset.

Per-fixture features beyond the JSON shape:

- `anchorExtraDeps` — additional `[dependencies]` for the Anchor reference build (e.g. `anchor-spl = "0.31"`).
- `ignoreRanges` — per-account byte ranges to mask before compare (use sparingly; every mask is correctness lost).
- `compareLamports: false` — skip lamport compare for accounts where lamports are expected to vary (e.g. fee-payer with arbitrary residuals).
- `stripDiscriminator: false` — for raw SPL Token accounts that don't carry the Anchor discriminator.

---

## Fixtures locked under this gate today (May 2026)

`bun test api/tests/differential-*.test.ts` runs **141 differential test files**. Representative categories:

| Category | Count | Examples |
|---|---|---|
| Core (init, state, close, realloc) | ~15 | counter, vault, close, realloc, realloc-grow, bumps-access, init-if-needed |
| SPL Token CPIs | ~10 | spl-transfer, spl-burn, ata-mint, set-authority, t22-transfer |
| Token-2022 extensions | ~15 | t22-default-account-state, t22-transfer-fee-init, t22-transfer-hook, t22-token-metadata, t22-immutable-owner, t22-non-transferable, t22-interest-bearing, t22-group-pointer, t22-metadata-pointer, t22-permanent-delegate, t22-mint-close-authority |
| Metaplex Token Metadata | ~10 | mpl-create-metadata, mpl-freeze-thaw, mpl-approve-revoke, mpl-mint-new-edition, mpl-sign-metadata, mpl-verify-collection-direct, mpl-collection-verify |
| MPL Core | ~6 | mpl-core-create-v2, mpl-core-update-v2, mpl-core-transfer-v1, mpl-core-burn-v1, mpl-core-create-collection-v2, mpl-core-plugin-family |
| Coral (real-world Anchor test corpus) | ~15 | coral-multisig, coral-events, coral-composite, coral-realloc, coral-escrow, coral-duplicate-mutable, coral-pda-derivation, coral-init-if-needed, coral-overflow-checks |
| Program-examples (Solana Foundation) | ~25 | counter, escrow, favorites, nft-minter, token-swap, transfer-sol, cpi-lever, pda-mint-authority, t22-basics, t22-group, token-fundraiser |
| Complex demos | ~10 | amm, marketplace, staking, vesting, escrow, multisig, perp-funding |
| Oracles | ~2 | oracle-pyth |
| Other (auto-scenario, misc) | ~30+ | auto-scenario variants, program-config, optional-state, return-data, msg-logs, event-emit |

---

## How this relates to the other correctness layers

| Layer | What it proves | Where |
|---|---|---|
| Output validator | structure / no anti-patterns / no silent corruption | `api/src/emitter/output-validator.ts` |
| `cargo build` | type, linker, codegen | `api/src/build/build-runner.ts` (Verify Build button) |
| `cargo build-sbf` | deployable `.so` | Verify Deploy button (slow, opt-in) |
| **Differential** | **runtime semantics byte-equal** | **this doc** |

Cargo green is necessary but not sufficient. A wrong CPI account order, a missing `bump`, an off-by-one Borsh layout all compile and ship divergent. The differential gate is what catches them.

## Caching

Built `.so` files cache by source hash under `$ANVIL_DIFF_CACHE` (default `~/.anvil-diff-cache/`). Identical source → no rebuild. Touch the source, change the cache key.

```bash
anvil-sol differential ./my-program --scenario s.json --skip-cache  # force rebuild
ANVIL_DIFF_CACHE=/tmp/my-cache anvil-sol differential ./my-program --scenario s.json
```

## Toolchain requirements

- `cargo-build-sbf` (Anza CLI 3.x; `platform-tools` v1.52+ — needs rustc 1.85+ for modern Anchor's deps).
- `anchor` CLI for the Anchor reference build.
- `bun` for running the harness from source. CLI consumers don't need bun if installed via npm.

# Anvil On-Chain Byte-Equal Demo

**7 Anchor programs, transpiled to Pinocchio by Anvil, deployed to a local Solana validator, with on-chain state byte-compared against the original Anchor compilation.**

| Program | Reduction | What it proves |
|---|---|---|
| `counter` | 86.7% smaller | PDA-bound state struct |
| `vault` | 85.7% smaller | PDA-as-vault + signer-seeded `system_program::transfer` |
| `t22-non-transferable` | 96.4% smaller | Token-2022 `non_transferable_mint_initialize` CPI |
| `amm` | 83.1% smaller | LP-token AMM: init pool, add liquidity, swap |
| `spl-token-minter` | 77.6% smaller | SPL Token mint + Metaplex `create_metadata_accounts_v3` CPI |
| `nft-minter` | 77.5% smaller | Full Metaplex NFT mint + master edition CPIs |
| `escrow2025` | 87.5% smaller | Full DeFi escrow (`make_offer`/`take_offer`) — PDA vault, signer-seeded SPL transfers |

**Total: 1777 KB → 281 KB (84.2% smaller across all 7 binaries)**

Every program is built twice with identical Anchor source: once via `anchor build` (the reference) and once via Anvil's transpile-then-compile (`anvil.so`). Both are deployed to the same local validator under distinct program IDs, the same instruction sequence runs against each, and the resulting on-chain account state is byte-compared. The `test-*.ts` files document exactly which byte ranges are compared and which are excluded (e.g. PDA bumps and freshly-generated keypair pubkeys naturally differ because the programs have different IDs).

## Reproducing the demo yourself

### Prerequisites
- `solana` CLI ≥ 3.1, `solana-test-validator` available
- `bun` ≥ 1.3 (or Node ≥ 22 with tsx)
- The Anvil repo (this file lives at `demo/on-chain/` inside it)
- `cargo-build-sbf` (ships with `solana` CLI)
- ~5 GB free disk for cached cargo dependencies + 14 `.so` files

### 1. Start the validator with Metaplex preloaded

The `nft-minter` and `spl-token-minter` demos CPI into Metaplex Token Metadata. The local test validator doesn't ship that program — clone it from mainnet:

```bash
solana-test-validator --reset \
  --clone-upgradeable-program metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s \
  --url mainnet-beta
```

Leave it running.

### 2. Clone real-world fixture sources

`spl-token-minter`, `nft-minter`, and `escrow2025` source live outside this repo. Clone them once:

```bash
mkdir -p ~/.anvil-realworld-cache
git clone --depth 1 https://github.com/solana-developers/program-examples \
  ~/.anvil-realworld-cache/solana-developers__program-examples
git clone --depth 1 https://github.com/mikemaccana/anchor-escrow-2025 \
  /tmp/anchor-escrow-2025
```

The other 4 fixtures (`counter`, `vault`, `t22-non-transferable`, `amm`) live in `api/src/demo-programs/` in this repo — no extra clone needed.

### 3. Install deps + build all 14 `.so` files

```bash
cd demo/on-chain
bun install
bun build.ts
```

`build.ts` generates fresh keypairs (per fixture × {anchor, anvil}) if they don't already exist, then invokes Anvil's `buildBothSos` with each keypair's pubkey baked into `declare_id!`. Output: `build/<fixture>_<anchor|anvil>.so` + `<fixture>-<anchor|anvil>.json`.

First build: ~15 minutes wall (sequential `cargo-build-sbf` calls). Subsequent runs are cached — only fixtures whose `.so` is missing get rebuilt.

### 4. Run the demos

```bash
bun test.ts
```

For each fixture: deploys both `.so`s (skips if already deployed), runs the program's instruction sequence on both, byte-compares state, prints a tweet-ready panel.

Final aggregate:
```
  7/7 byte-equal verified (instruction tx + on-chain state byte-comparison)
  total binary size:  Anchor 1777KB  →  Anvil 281KB  (84.2% smaller overall)
```

Each per-fixture panel includes the program IDs + transaction signatures + the exact byte ranges compared. Verify any of them yourself:

```bash
solana program show <programId> --url http://127.0.0.1:8899
solana account <stateAccount> --url http://127.0.0.1:8899
```

A machine-readable artifact is saved to `test-results.json`.

## What's compared, what isn't

Each test compares the **logical state slice** of the accounts the program writes. Fields that legitimately differ between the two compilations (because the two programs have distinct on-chain IDs) are skipped from the comparison and called out in the panel:

- **PDA bumps**: each program's PDA derivations use its own program ID, so canonical bumps differ. Skipped.
- **Pubkey-of-fresh-keypair fields**: e.g. `Mint::mint_authority`, `Metadata::mint`, ATA `mint` — fresh keypairs generated per program iteration. Skipped via byte-offset slicing.
- **PDA-derived pubkeys**: e.g. `Mint::freeze_authority` is the master_edition PDA which is mint-derived which is fresh per iteration. Skipped.
- **Metaplex `edition_nonce`**: canonical bump for the master_edition PDA against the fresh mint. Skipped.

What IS compared:
- Anchor account discriminators (8-byte sha256 prefix) — identical because both programs derive from the same Anchor source.
- All numeric state fields (counters, balances, supplies, fees, reserves).
- User-provided strings (token names, symbols, URIs).
- Token account balances after `mint_to` + `transfer` CPIs.
- Metaplex metadata user-provided fields.

## File map

```
demo/on-chain/
├── README.md                       (this file)
├── package.json                    bun + @solana/web3.js + @solana/spl-token
├── paths.ts                        env-var-overridable path resolution
├── build.ts                        builds 14 .so files via Anvil's pipeline
├── test.ts                         top-level orchestrator (runs all 7 demos)
├── test-counter.ts                 PDA state demo
├── test-vault.ts                   PDA-as-vault demo
├── test-t22-non-transferable.ts    Token-2022 extension demo
├── test-amm.ts                     LP-token AMM demo
├── test-spl-token-minter.ts        SPL Token + Metaplex metadata demo
├── test-nft-minter.ts              Metaplex NFT demo
├── test-escrow2025.ts              Full DeFi escrow demo
├── build/                          14 .so files (gitignored, regenerated by build.ts)
├── *-anchor.json / *-anvil.json    program keypairs (gitignored, per-machine)
└── test-results.json               last-run artifact (gitignored)
```

## Why this matters

The H1 emitter-path collapse milestone delivered ANVIL_AST_EMIT=1 byte-equality across 117 source snapshots + 94 realworld-cargo cases — but those are LiteSVM-level checks. This demo lifts the same byte-equality claim to **actual on-chain state**, observed on the standard Agave validator with the standard BPF loader.

The reduction in binary size compounds across a real-world program portfolio — 84% smaller binaries means faster deploys, lower rent costs, and tighter compute budgets per CPI. The transpilation produces programs that are functionally indistinguishable from their Anchor source compilation, byte-for-byte, on chain.

## Environment overrides

Each path can be overridden by env var:

| Var | Default | Purpose |
|---|---|---|
| `ANVIL_DEMO_RPC` | `http://127.0.0.1:8899` | Local validator endpoint |
| `ANVIL_DEMO_PAYER` | `~/.config/solana/id.json` | Funding keypair (needs ~2 SOL per fresh test run) |
| `ANVIL_DEMO_BUILD_DIR` | `./build` | Where `build.ts` writes the .so files |
| `ANVIL_DEMO_KEYPAIR_DIR` | `.` (this dir) | Where program keypairs are stored |
| `ANVIL_PROGRAM_EXAMPLES` | `~/.anvil-realworld-cache/solana-developers__program-examples` | Path to cloned program-examples repo |
| `ANVIL_ESCROW2025` | `/tmp/anchor-escrow-2025` | Path to cloned anchor-escrow-2025 repo |

## Caveats

- The validator must be reset (`--reset` flag) between runs because programs can't be redeployed under the same keypair to an already-occupied program account. Each test generates a fresh session-payer where PDAs would otherwise collide, so partial re-runs against an existing chain work for most demos but not all.
- Builds use the toolchain Anvil bundles (`anchor-cli 0.31`, `cargo-build-sbf` from your installed `solana` CLI). Toolchain version drift may produce slightly different `.so` bytes but the on-chain behavior stays equivalent.
- This is a *local* demo — devnet/mainnet deployment would need additional setup (more SOL, public RPC, retry logic for confirmation flakiness).

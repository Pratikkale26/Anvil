# Feature matrix — what works per target

`Y` = supported and exercised in the demo or real-world cargo-build suites.
`partial` = lands but has known gaps documented below.
`lint` = emit passes through, the portability lint flags it for manual review.
`—` = not supported.

| Feature | Pinocchio | Native |
|---|---|---|
| Parser (Anchor source → IR) | Y (shared) | Y (shared) |
| Instruction handlers + router | Y | Y |
| Account constraints (`init`, `init_if_needed`, `mut`, `has_one`, `close`, `seeds`, `bump`, `realloc`) | Y | Y |
| `#[derive(InitSpace)]` + `#[max_len]` | Y | Y |
| PDA derivation + signer seeds | Y | Y |
| `require_*!` / `msg!` / `emit!` | Y | Y |
| System-program `transfer` | Y | Y |
| System-program `create_account` (with arbitrary owner) | Y | Y |
| SPL Token: `transfer` / `mint_to` / `burn` / `close_account` | Y | Y |
| SPL Token: `set_authority` | Y (hand-rolled raw CPI) | Y (`spl_token::instruction::set_authority`) |
| Associated Token Account `create` | Y (hand-rolled vs SPL ATA program ID) | Y (`spl_associated_token_account::instruction::create`) |
| SPL Memo CPI | Y (hand-rolled vs MEMO program ID) | Y (`spl_memo`) |
| Token-2022 `_checked` variants | Y (runtime pass-through via `pinocchio_token`) | Y (`spl_token_2022::*_checked`) |
| Token-2022 extensions (TransferFee, TransferHook, GroupPointer, TokenMetadata, …) | Y on all 12 non-confidential extensions; Confidential family is `lint` — see [token-2022-extensions.md](token-2022-extensions.md) | Y on all 12 non-confidential extensions; Confidential family is `lint` — see [token-2022-extensions.md](token-2022-extensions.md) |
| AI Refine (validator-driven) | Y (shared) | Y (shared) |
| AI under byte-equal differential gate (`/build/auto-fix?with_differential=1`) | Y (shared) | Y (shared) |
| Verify Build + Auto-fix loop | Y (shared) | Y (shared) |
| AST visitor (Phase 2 — dead code, structural emit incrementally retiring regex layer) | Y (shared, scaffold + 4 IR kinds structurally ported) | Y (shared) |
| Zero-copy account layouts (`#[account(zero_copy)]`) | Y (`#[repr(C)]` + bytemuck `Pod`/`Zeroable`, byte-equal verified 2026-05-08) | Y |
| Metaplex Token Metadata CPIs (create_metadata_v3, master_edition_v3, verify/sign collection, freeze/thaw, mint_new_edition, approve/revoke collection authority) | Y (12 IR kinds, 11/12 slots byte-equal differential-gated) | Y |
| Pyth price feed reads (legacy `PriceAccountV2` + modern `PriceUpdateV2`) | Y (byte-equal differential against Pyth Receiver `.so`) | Y |
| Switchboard On-Demand PullFeed reads (`PullFeedAccountData::parse(...)` + `.value()` / `.value_with_max_staleness(N)`) | Y (parser + hand-rolled byte read; byte-equal differential pending fixture) | Y |
| MPL Core asset lifecycle + collection (CreateV2 / UpdateV2 / TransferV1 / BurnV1 / CreateCollectionV2) | Y (byte-equal differential against real mpl_core.so loaded into LiteSVM) | Y |
| MPL Core plugin family (AddPluginV1 / RemovePluginV1 / UpdatePluginV1 / Approve / Revoke) | Y on 8 simple Plugin variants (statically-sized payloads), byte-equal differential-gated; complex variants (Royalties, Attributes, UpdateDelegate, Edition, MasterEdition, VerifiedCreators, Autograph, BubblegumV2, FreezeExecute) fall back to `lint` | Y (same scope) |
| Confidential T22 init slots (ConfidentialTransfer + ConfidentialTransferFee + ConfidentialMintBurn `initialize_mint`) | Y (parser + emit + cargo-check; no zk-proofs at init time — fixed-size Pod payloads) | Y |
| Confidential T22 Configure/Deposit/Withdraw/Transfer operations | lint (requires zk-program companion CPI — separate research arc) | lint |
| Impl-method inlining (`ctx.accounts.foo()`) | partial | partial |
| Composite `#[derive(Accounts)]` flatten (`pub foo: Inner<'info>`) | Y (3-layer parser+classifier+emitter port, 2026-05-19; BYTE_EQUAL verified on real :8899 validator for Anchor org composite example) | Y |

## Locked under byte-equal differential gate

These run on every Anvil release; any emit divergence fails the gate.

**82 byte-equal differential fixtures** — covering SPL Token, Token-2022 (all 12 non-confidential extensions), Metaplex Token Metadata (12 IR kinds), MPL Core (9 IR kinds), Pyth (legacy + modern), composite Accounts, and a slate of real-world programs.

### Real-world programs (cloned verbatim)

| Program | Source | Surface |
|---|---|---|
| `anchor-escrow-2025` | mikemaccana/anchor-escrow-2025 | PDA + non-ATA token init + `token::transfer` |
| `coral-events` | coral-xyz/anchor test corpus | `emit!()` event log + multi-field borsh payload |
| `favorites` | solana-developers/program-examples | `init_if_needed` + `String` + `Vec<String>` (max_len) |
| `account-data` | solana-developers/program-examples | 3× `String` fields under `#[max_len(50)]` |
| `pda-rent-payer` | solana-developers/program-examples | Signer-seeded `system_program::create_account` |
| `page-visits` | solana-developers/program-examples | Smallest possible PDA-init (5-byte struct) |

### Demo fixtures (representative subset; 28 total)

| Fixture | Surface |
|---|---|
| `counter` | account init + state mutation |
| `vault` | PDA-as-vault + signer-seeded `system_program::transfer` |
| `has-one` | runtime constraint enforcement |
| `ata-mint` | ATA create + SPL `mint_to` |
| `spl-transfer` | `token::transfer` |
| `spl-burn` | `token::burn` |
| `t22-transfer` | Token-2022 `transfer_checked` (decimals extraction) |
| `close` | `close = receiver` rent refund + reap |
| `set-authority` | hand-rolled raw SPL `set_authority` on Pinocchio |
| `escrow` | PDA init + non-ATA token init (`init token::*` vault) + `token::transfer` |
| `marketplace` | NFT marketplace state shape (admin + fee_bps + treasury) |
| `staking` | Clock-pinned + `emit!` + msg/return-data triple parity |
| `realloc` / `realloc-grow` | Vec resize with rent-delta accounting |
| `multisig` | m-of-n signer enforcement |
| `event-emit` | `emit!()` discriminator + borsh payload via `sol_log_data` |
| `vesting` | Schedule + cliff + claim math |

Plus 12 more covering bumps_access, init_if_needed, cpi_custom, cpi_memo, sysvars, return data/err, msg logs, optional-state, program-config, tip-jar, sysvar-rent. `bun test api/tests/differential-*.test.ts` runs the full set.

## Real-world cargo-build coverage

`api/tests/realworld-cargo.test.ts` regression-gates 50+ fixtures from the [`solana-developers/program-examples`](https://github.com/solana-developers/program-examples) corpus + [`coral-xyz/anchor`](https://github.com/coral-xyz/anchor) test programs, across both targets. Auto-clones to `/tmp/program-examples` and `/tmp/coral-anchor` on first run; set `ANVIL_NO_CLONE=1` to opt out. Each MUST_PASS case carries a `maintainer` + `lastPassedDate` so a regression has a clear contact + recency signal. Promoted cases include: counter, checking-accounts, processing-instructions, cpi-lever, create-account, close-account, realloc, program-derived-addresses, transfer-tokens, spl-token-minter, create-token, token-2022-basics, t22-transfer-fee, transfer-sol, rent, pda-rent-payer, carnival, pda-mint-authority, cpi-hand, favorites, hello-solana, account-data, escrow2025, coral-escrow, coral-multisig, coral-sysvars. Tracking layer (`realworld-tracking.test.ts`) holds ~9 cases with non-blocking ceilings for fixtures still on emit follow-ups (coral-swap, t22-transfer-hook, coral-events, favorites/native).

## Quasar status

Quasar emit was deleted from the production path on 2026-05-05 (`quasar-lang` hadn't shipped a stable 1.0). Pinocchio and Native are the supported, byte-equal-gated targets. The vendored CLI copy at `cli/src/api-src/emitter/quasar-*.ts` is preserved but no longer maintained.

## Known gaps

- **MPL Core** (the newer Metaplex format, separate from Token Metadata). **10 IR kinds shipped — asset lifecycle + collection + plugin family**: CreateV2 / UpdateV2 / TransferV1 / BurnV1 / CreateCollectionV2 (the asset/collection set, fully byte-encoded; v1 scope keeps plugins/external_plugin_adapters/new_update_authority/compression_proof at None), and AddPluginV1 / RemovePluginV1 / UpdatePluginV1 / ApprovePluginAuthorityV1 / RevokePluginAuthorityV1 (the plugin family, with 8 statically-sized Plugin variants supported: FreezeDelegate, BurnDelegate, TransferDelegate, PermanentFreezeDelegate, PermanentTransferDelegate, PermanentBurnDelegate, AddBlocker, ImmutableMetadata). Complex Plugin variants (Royalties, Attributes, UpdateDelegate, Edition, MasterEdition, VerifiedCreators, Autograph, BubblegumV2, FreezeExecute) and the Address(_) PluginAuthority variant fall back to lint — they have variable-sized nested Borsh payloads that need additional parser work. Token Metadata IS also fully supported (12 IR kinds, byte-equal differential-gated).
- **Switchboard oracle CPIs.** Two-line `PullFeedAccountData::parse(...)` + `.value() / .value_with_max_staleness(N)` legacy reader idiom is fully supported (parser + hand-rolled byte deserialization at offset 200 i128 / offset 296 u64, dropping the `switchboard-on-demand` crate dep). Byte-equal differential gate pending a `switchboard-on-demand.so` fixture; until then, a byte-offset regression test independently re-implements the offset reads against a synthetic buffer (mirrors the Pyth M2 pattern).
- **Confidential T22 family** (`ConfidentialTransferMint`, `ConfidentialTransferFee`, `ConfidentialMintBurn`). **Init slots fully supported** (3 IR kinds: cpi_t22_confidential_transfer_initialize_mint, cpi_t22_confidential_transfer_fee_init, cpi_t22_confidential_mint_burn_initialize_mint — discriminators 27/37/42 with inner=0, fixed-size Pod payloads 67/66/70 bytes). Cargo-check across both Pinocchio + Native scaffolds. Byte-equal differential deferred (needs T22 mint-with-extension setup harness work). Configure/Deposit/Withdraw/Transfer operations remain lint-only — they require zk-proof prelude (Groth16 verification via a companion ProofInstruction CPI), a separate multi-week research arc.
- **Impl-method inlining for `ctx.accounts.foo()`.** Partial: the flattener preserves impl-scoped names, but inlining method bodies into instruction handlers interacts with the CPI-consolidation regex. Affects some escrow-style programs. Tracked-ceiling in `realworld-tracking.test.ts`.
- **Jupiter aggregator + other sibling-program CPIs.** Routed through `cpi_custom` with a manual TODO marker; user must hand-roll the CPI against the target program ID since the sibling program's instruction layout isn't accessible from the consumer's IDL.

## CU savings

### First-party measured (`scripts/measure-cu.ts` against `solana-test-validator`)

Anvil's bundled demos, deployed both as Anchor original and Anvil-emitted Pinocchio, run side-by-side. Best-case across 5 trials per side (controls for `find_program_address` bump-iteration variance).

| Instruction | Anchor CU | Anvil-Pinocchio CU | Saved |
|---|---:|---:|---:|
| `counter::initialize(start_value=10)` | 6,074 | 3,268 | **46%** |
| `counter::increment(amount=5)` | 2,753 | 1,801 | **35%** |
| `escrow::create_escrow(seed=42, deposit=250000, receive=500000)` | 26,614 | 16,133 | **39%** |

Reproduce: `solana-test-validator --reset --quiet &` in one terminal, then `bun scripts/measure-cu.ts` in another. Set `ANVIL_CU_FIXTURES=counter` (or `escrow`) to run a single fixture. The script generates fresh program keypairs each run, patches `declare_id!()` to match, deploys both `.so` binaries, runs the scenario via `getTransaction(...).meta.logMessages`, and parses the `consumed N of M compute units` line.

What this tells you: state-only programs (counter) save ~35-46% from leaner account validation + manual Borsh skipping Anchor's macro-emitted runtime checks. SPL-CPI programs (escrow: PDA init + non-ATA token init + token::transfer) save 39% — Anchor's `init token::*` macro adds substantial validation/wrapper overhead on top of the system::create_account + initialize_account3 CPIs. Anvil emits the same on-chain CPIs but skips the surrounding Anchor runtime checks.

### External SPL primitives ([Helius p-token](https://github.com/helius-labs/p-token))

Hand-written Pinocchio implementations of SPL Token primitives, measured by Helius:

| Operation | Anchor / SPL Token CU | Pinocchio CU | Saved |
|---|---:|---:|---:|
| SPL `transfer` | 4,645 | 79 | 98% |
| SPL `mint_to` | 4,538 | 123 | 97% |
| SPL `burn` | 4,753 | 133 | 97% |

These are not Anvil-emitted, but Anvil's `cpi_spl_*` IR kinds emit Pinocchio code that uses the same `pinocchio_token` builders Helius uses. Programs that lean on SPL CPIs (transfers, mints, burns, ATA creates) will see savings closer to this row than the counter row.

### Workbench heuristic

The CU table in the workbench (`api/src/emitter/cu-analyzer.ts`) is a constant-table estimator that adds up per-construct costs. Useful for relative ranking between targets ("is Pinocchio cheaper than Native here?") but **not** an exact prediction. The measurement script is the source of truth for absolute numbers.

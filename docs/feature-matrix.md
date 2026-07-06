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
| `emit_cpi!` | Y (compiles) — see Known gaps: event semantics not preserved | Y (compiles) |
| System-program `transfer` | Y | Y |
| System-program `create_account` (with arbitrary owner) | Y | Y |
| SPL Token: `transfer` / `mint_to` / `burn` / `close_account` / `approve` / `revoke` | Y | Y |
| SPL Token: `set_authority` | Y (hand-rolled raw CPI) | Y (`spl_token::instruction::set_authority`) |
| Associated Token Account `create` | Y (hand-rolled vs SPL ATA program ID) | Y (`spl_associated_token_account::instruction::create`) |
| SPL Memo CPI | Y (hand-rolled vs MEMO program ID) | Y (`spl_memo`) |
| Token-2022 `_checked` variants | Y (runtime pass-through via `pinocchio_token`) | Y (`spl_token_2022::*_checked`) |
| Token-2022 extensions (TransferFee, TransferHook, GroupPointer, TokenMetadata, RequiredMemoTransfers, …) | Y on all 13 non-confidential extensions; Confidential family is `lint` — see [token-2022-extensions.md](token-2022-extensions.md) | Y on all 13 non-confidential extensions; Confidential family is `lint` — see [token-2022-extensions.md](token-2022-extensions.md) |
| AI Refine (validator-driven) | Y (shared) | Y (shared) |
| AI under byte-equal differential gate (`/build/auto-fix?with_differential=1`) | Y (shared) | Y (shared) |
| Verify Build + Auto-fix loop | Y (shared) | Y (shared) |
| AST visitor (production default — regex walker being absorbed) | Y (shared, production default since 2026-05-13) | Y (shared) |
| Zero-copy account layouts (`#[account(zero_copy)]`) | Y (`#[repr(C)]` + bytemuck `Pod`/`Zeroable`, byte-equal verified 2026-05-08) | Y |
| Metaplex Token Metadata CPIs (create_metadata_v3, master_edition_v3, verify/sign collection, freeze/thaw, mint_new_edition, approve/revoke collection authority) | Y (12 IR kinds, 11/12 slots byte-equal differential-gated) | Y |
| Pyth price feed reads (legacy `PriceAccountV2` + modern `PriceUpdateV2`) | Y (byte-equal differential against Pyth Receiver `.so`) | Y |
| Switchboard On-Demand PullFeed reads (`PullFeedAccountData::parse(...)` + `.value()` / `.value_with_max_staleness(N)`) | Y (parser + hand-rolled byte read; byte-equal differential pending fixture) | Y |
| MPL Core asset lifecycle + collection (CreateV2 / UpdateV2 / TransferV1 / BurnV1 / CreateCollectionV2) | Y (byte-equal differential against real mpl_core.so loaded into LiteSVM) | Y |
| MPL Core plugin family (AddPluginV1 / RemovePluginV1 / UpdatePluginV1 / Approve / Revoke) | Y on 8 simple Plugin variants (statically-sized payloads), byte-equal differential-gated; complex variants (Royalties, Attributes, UpdateDelegate, Edition, MasterEdition, VerifiedCreators, Autograph, BubblegumV2, FreezeExecute) fall back to `lint` | Y (same scope) |
| Confidential T22 init slots (ConfidentialTransfer + ConfidentialTransferFee + ConfidentialMintBurn `initialize_mint`) | Y (parser + emit + cargo-check; no zk-proofs at init time — fixed-size Pod payloads) | Y |
| Confidential T22 Configure/Deposit/Withdraw/Transfer operations | lint (requires zk-program companion CPI — separate research arc) | lint |
| `declare_program!` cross-program CPI (`<crate>::cpi::<fn>(CpiContext::new[_with_signer](prog, Accounts{…}), args)`) | Y — aliased (`use X::cpi::fn`) + qualified (`X::cpi::fn`) call forms; `invoke` AND `invoke_signed` (PDA-signed via `CpiContext::new_with_signer`); **every realistic arg type**: String / fixed-width int / bool / pubkey / bytes (Vec<u8>) / Option<supported> / Vec<supported> / [T; N] / defined-struct / defined-enum (external struct & enum defs are generated from the IDL `types` so the caller can deserialize them; enums Borsh-encode as a u8 variant discriminant + the matched variant's fields via a `match`); metas driven from the CpiContext struct + the IDL's account flags/order/discriminator. composite-account params (a nested `#[derive(Accounts)]` struct as a field, recursively flattened on both the IDL leaves and the caller's nested CpiContext struct). Byte-equal differential-gated (hand→lever, external::update u32, config bool+pubkey, vault PDA-signed invoke_signed, composite update_composite, blob bytes, option Some(u64), collections Vec&lt;u64&gt;+[u8;4], defined-struct, array [u64;3], enum Mode::Level(42)). IDL collected from the project `idls/` dir on all /parse paths. Fail-closed (loud-refuse) only when an external type can't be generated (e.g. a type the IDL omits, transitively). | Y (same) |
| Impl-method inlining (`ctx.accounts.foo()`) | partial | partial |
| Composite `#[derive(Accounts)]` flatten (`pub foo: Inner<'info>`) | Y (3-layer parser+classifier+emitter port, 2026-05-19; BYTE_EQUAL verified on real :8899 validator for Anchor org composite example) | Y |

## Locked under byte-equal differential gate

These run on every Anvil release; any emit divergence fails the gate.

**199 byte-equal differential test files** — covering SPL Token (incl. `approve`/`revoke`), Token-2022 (all 13 non-confidential extensions, incl. RequiredMemoTransfers), Metaplex Token Metadata (12 IR kinds), MPL Core (10 IR kinds), Pyth (legacy + modern), Switchboard, composite Accounts, nested variable-length account state, 14+ real-world externally-authored Anchor programs, 25+ Solana Foundation program-examples, and 64 demo programs. `bun test api/tests/differential-*.test.ts` runs the full set. See [differential-testing.md](differential-testing.md) for the complete breakdown.

## Real-world cargo-build coverage

`api/tests/realworld-cargo.test.ts` regression-gates **181 MUST_PASS fixtures** from the [`solana-developers/program-examples`](https://github.com/solana-developers/program-examples) corpus + [`coral-xyz/anchor`](https://github.com/coral-xyz/anchor) test programs, across both targets. Auto-clones to `/tmp/program-examples` and `/tmp/coral-anchor` on first run; set `ANVIL_NO_CLONE=1` to opt out. Each MUST_PASS case carries a `maintainer` + `lastPassedDate` so a regression has a clear contact + recency signal. **Top DeFi cohort**: marginfi-v2 (91 instructions, 1 error), raydium-clmm (34 instructions, 0 errors), klend (63 instructions, 0 errors) — promoted to verification tier via commit `3510f03`.

## Quasar status

Quasar emit was deleted from the production path on 2026-05-05 (`quasar-lang` hadn't shipped a stable 1.0). Pinocchio and Native are the supported, byte-equal-gated targets. The vendored CLI copy at `cli/src/api-src/emitter/quasar-*.ts` is preserved but no longer maintained.

## Known gaps

- **MPL Core** (the newer Metaplex format, separate from Token Metadata). **10 IR kinds shipped — asset lifecycle + collection + plugin family**: CreateV2 / UpdateV2 / TransferV1 / BurnV1 / CreateCollectionV2 (the asset/collection set, fully byte-encoded; v1 scope keeps plugins/external_plugin_adapters/new_update_authority/compression_proof at None), and AddPluginV1 / RemovePluginV1 / UpdatePluginV1 / ApprovePluginAuthorityV1 / RevokePluginAuthorityV1 (the plugin family, with 8 statically-sized Plugin variants supported: FreezeDelegate, BurnDelegate, TransferDelegate, PermanentFreezeDelegate, PermanentTransferDelegate, PermanentBurnDelegate, AddBlocker, ImmutableMetadata). Complex Plugin variants (Royalties, Attributes, UpdateDelegate, Edition, MasterEdition, VerifiedCreators, Autograph, BubblegumV2, FreezeExecute) and the Address(_) PluginAuthority variant fall back to lint — they have variable-sized nested Borsh payloads that need additional parser work. Token Metadata IS also fully supported (12 IR kinds, byte-equal differential-gated).
- **Switchboard oracle CPIs.** Two-line `PullFeedAccountData::parse(...)` + `.value() / .value_with_max_staleness(N)` legacy reader idiom is fully supported (parser + hand-rolled byte deserialization at offset 200 i128 / offset 296 u64, dropping the `switchboard-on-demand` crate dep). Byte-equal differential gate pending a `switchboard-on-demand.so` fixture; until then, a byte-offset regression test independently re-implements the offset reads against a synthetic buffer (mirrors the Pyth M2 pattern).
- **Confidential T22 family** (`ConfidentialTransferMint`, `ConfidentialTransferFee`, `ConfidentialMintBurn`). **Init slots fully supported** (3 IR kinds: cpi_t22_confidential_transfer_initialize_mint, cpi_t22_confidential_transfer_fee_init, cpi_t22_confidential_mint_burn_initialize_mint — discriminators 27/37/42 with inner=0, fixed-size Pod payloads 67/66/70 bytes). Cargo-check across both Pinocchio + Native scaffolds. Byte-equal differential deferred (needs T22 mint-with-extension setup harness work). Configure/Deposit/Withdraw/Transfer operations remain lint-only — they require zk-proof prelude (Groth16 verification via a companion ProofInstruction CPI), a separate multi-week research arc.
- **Impl-method inlining for `ctx.accounts.foo()`.** Partial: the flattener preserves impl-scoped names, but inlining method bodies into instruction handlers interacts with the CPI-consolidation regex. Affects some escrow-style programs. Tracked-ceiling in `realworld-tracking.test.ts`.
- **Jupiter aggregator + other sibling-program CPIs WITHOUT a declare_program! IDL.** Routed through `cpi_custom` with a manual TODO marker; user must hand-roll the CPI against the target program ID since the sibling program's instruction layout isn't accessible. When the program IS declared via `declare_program!(X)` and `idls/X.json` is present, the `X::cpi::*` form is transpiled (see the declare_program! row above) — this gap is only the no-IDL case.
- **`declare_program!` CPI — external types the IDL doesn't carry.** Every realistic arg shape is now supported (see the declare_program! row): String, fixed-width ints, bool, pubkey, bytes/Vec&lt;u8&gt;, Vec&lt;supported&gt;, [T; N] (u8 fast-path + per-element for others), Option&lt;supported&gt;, defined-structs **and defined-enums** (both with external type-def generation), PDA-signed `CpiContext::new_with_signer`, and composite-account params. The only fail-closed (loud-refuse) case is when a referenced external type cannot be generated — e.g. the IDL `types` table omits it, transitively (a generated type references a nested type the IDL didn't include). Type generation is all-or-nothing: if any piece can't be produced, the rewrite is skipped and the original `<crate>::types::<T>` ref survives to loud-refuse rather than emit a wrong encoding.
- **Compressed-NFT / state-compression CPIs** (`mpl_bubblegum`, `spl_account_compression`, `spl_noop`). **Transpilable via the standard `declare_program!` + IDL path** — declaring `declare_program!(spl_account_compression)` / `declare_program!(mpl_bubblegum)` with the crate's `idls/<crate>.json` and calling `<crate>::cpi::<fn>(...)` routes through the same external-CPI machinery that's byte-equal-gated for other declared programs (see the `declare_program!` row above). A **raw-crate CPI with NO IDL** is loud-refused (`cnft_compression_unsupported`, promoted to a validator error, pointing the user at the IDL path) since the target instruction layout is unknown. The compression path is now **byte-equal differential-gated** (`differential-compression-append.test.ts`): a real `spl_account_compression::cpi::append` via `declare_program!` is byte-compared against Anchor's own `declare_program!` output, running the mainnet `spl_account_compression.so` + `spl_noop.so` (committed under `tests/fixtures/programs/`) in LiteSVM with a real concurrent-Merkle-tree mutation. Bubblegum (`mpl_bubblegum`) rides the same declare_program path; its own differential fixture can be added the same way.
- **`emit_cpi!` event semantics.** `emit_cpi!` compiles (it's collapsed to the same direct `sol_log_data` as `emit!`), but the **self-CPI semantics are not preserved**: real Anchor `emit_cpi!` invokes the program itself with an `event_authority` PDA + the program account (so the instruction's account list differs, and it can revert if those accounts are absent), whereas the Anvil emit just logs directly. The event *payload* bytes match `emit!`, but a client that relies on the `event_authority` self-CPI account requirements (or on the CPI-log vs program-data-log channel) will see a behavioral difference. Auto-scenario byte-equal correctly leaves event-log comparison OFF for `emit_cpi!` programs (it would be a false divergence); the differential CLI uses `--ignore-events`. Event payloads are an unverified surface (see `docs/audit-trust-model.md`).

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

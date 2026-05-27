# MPL Core arc — implementation plan

**Status:** SHIPPED (2026-05-19). Full 12/12 catalog: asset lifecycle + collection + plugin family. Plan preserved as historical reference.

**Scope:** 8-10 new IR kinds for the MPL Core program (NOT to be confused
with MPL Token Metadata, which has its own 12-IR-kind catalog already
shipped with byte-equal differentials). MPL Core is the newer Metaplex
format (separate program ID, different instruction discriminators,
different account layout).

## Why MPL Core deserves its own catalog

MPL Token Metadata + Master Edition use the original Metaplex program
(`metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s`). MPL Core uses a new
program (`CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d`) with a
fundamentally different account layout — single "core asset" account
that holds metadata + plugins inline, rather than separate metadata +
master-edition + collection accounts.

Anchor programs porting from Token Metadata to MPL Core are increasingly
common (lower CU cost, simpler account model). Anvil's current
behavior on MPL Core CPIs: emit carries `mpl_core::*` imports verbatim,
lint flags them, cargo fails to resolve the crate. Same TODO-stub
pattern as the original Token Metadata pre-shipping state.

## IR kinds (priority order)

| IR kind | Anchor source pattern | Notes |
|---|---|---|
| `cpi_mpl_core_create_v2` | `mpl_core::CreateV2CpiBuilder::new(...).invoke()?` | Asset minting; highest-priority slot |
| `cpi_mpl_core_update_v2` | `mpl_core::UpdateV2CpiBuilder::new(...).invoke()?` | Metadata field updates |
| `cpi_mpl_core_transfer_v1` | `mpl_core::TransferV1CpiBuilder::new(...).invoke()?` | Asset transfer (auto-handles plugins) |
| `cpi_mpl_core_burn_v1` | `mpl_core::BurnV1CpiBuilder::new(...).invoke()?` | Asset burn + close |
| `cpi_mpl_core_add_plugin_v1` | `mpl_core::AddPluginV1CpiBuilder` | Per-asset plugins (freeze, royalties, etc.) |
| `cpi_mpl_core_remove_plugin_v1` | `mpl_core::RemovePluginV1CpiBuilder` | |
| `cpi_mpl_core_update_plugin_v1` | `mpl_core::UpdatePluginV1CpiBuilder` | |
| `cpi_mpl_core_approve_plugin_authority_v1` | `mpl_core::ApprovePluginAuthorityV1CpiBuilder` | |
| `cpi_mpl_core_revoke_plugin_authority_v1` | `mpl_core::RevokePluginAuthorityV1CpiBuilder` | |
| `cpi_mpl_core_create_collection_v2` | Collection-scoped asset minting | |

The CpiBuilder pattern is distinctive — MPL Core uses Anchor's
fluent-builder style rather than the inline `CpiContext::new(...,
CreateMetadataAccounts { ... })` shape Token Metadata uses. Parser
detection must walk the CpiBuilder chain (`.new(...).field(X).
other_field(Y).invoke()`).

## Per-slot work shape

For each IR kind:

1. **Parser** (`cpi-detector.ts`): match the CpiBuilder shape, extract
   account references + plugin/data args.
2. **Pinocchio emit**: hand-roll the byte assembly for the MPL Core
   instruction discriminator + account-meta list + serialized args. Drop
   the mpl_core crate dep entirely (Pinocchio is no_std anyway).
3. **Native emit**: route to `mpl_core::instructions::<Variant>` with
   the standard CPI shape. Add `mpl-core` to Cargo.toml.
4. **Demo program** in `api/src/demo-programs/mpl-core-<slot>.rs`.
5. **Byte-equal differential** in `api/tests/differential-mpl-core-
   <slot>.test.ts` — needs the `mpl_core.so` fixture bundled (parallel
   to the existing `mpl_token_metadata.so` fixture).

## Effort estimate

Per slot: ~1-1.5 days (parser + emit × 2 targets + demo + differential).
Total for 8 priority slots: ~10-12 days.

## Fixture acquisition

Need a recent `mpl_core.so` deployed to a known test program ID. Steps:
1. Build from `metaplex-foundation/mpl-core` repo, OR
2. `solana program dump CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d
   mpl_core.so --url https://api.devnet.solana.com`

Bundle under `api/tests/fixtures/mpl_core.so` (mirror of the existing
Pyth Receiver fixture pattern).

## Out of scope

- Asset Standard v3+ (when it ships) — separate arc.
- Off-chain JSON metadata generation — user responsibility.
- Royalty enforcement at transfer — handled by the Royalties plugin,
  but Anvil's role is just to forward the plugin data verbatim.

## Adoption signal

MPL Core appears in:
- Metaplex's official examples + `core-candy-machine` programs.
- DeGods 2.0 (post-Token-Metadata migration).
- Newer NFT marketplaces (Tensor, Magic Eden's newer collections).

Closing this arc unblocks differential testing on those families.

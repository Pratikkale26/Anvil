/**
 * program-examples-nft-operations differential — external byte-equal.
 *
 * Source: github.com/solana-developers/program-examples
 *   (tokens/nft-operations/anchor). Multi-file Anchor 1.0.0-rc.5 program
 *   with `mod contexts;` declaring 3 sub-files
 *   (create_collection, mint_nft, verify_collection).
 *
 * Scope: byte-equal on mint + destination ATA + metadata PDA +
 * master_edition PDA after `create_collection`. The instruction
 * exercises the entire NFT-mint pipeline in one shot — init mint
 * (decimals=0), init ATA, mint_to amount=1 (PDA-signed),
 * create_metadata_accounts_v3 (PDA-signed, with verified Creator +
 * CollectionDetails::V1 sized collection), create_master_edition_v3
 * (PDA-signed, max_supply=Some(0)).
 *
 * Why a meaningful byte-equal target:
 *   - First fixture in the portfolio that exercises
 *     CollectionDetails::V1 { size: 0 } on the CreateMetadataAccountV3
 *     borsh payload. Any drift in how Anvil emits the Option<CollectionDetails>
 *     tag or the V1 variant discriminator + size u64 is caught by the
 *     metadata PDA compare.
 *   - PDA-signed mint_to + PDA-signed MPL CPIs in the same instruction
 *     — the seeds = [b"authority", bump] signer_seeds vec must be
 *     identical across all three signed CPIs. Any drift in the seed
 *     bytes or the signer_seeds re-use breaks all 3 downstream account
 *     compares.
 *   - Multi-file project flattening through buildProjectSource.
 *
 * MPL Token Metadata reference .so is loaded into LiteSVM at
 * metaqbxx... via auxiliaryPrograms; both Anchor and Anvil scenarios
 * invoke the same MPL ix with the same accounts and same data, so any
 * surviving divergence is purely in the Anvil emit path.
 *
 * Counts toward grant A1 (byte-equal external Anchor programs).
 */
import { defineDifferential } from "./differential-harness.ts";
import {
  LIB_RS,
  CRATE_DIR,
  PROGRAM_ID,
  MPL_PROGRAM_ID,
  loadAnchorSource,
  setupCreateCollection,
  callCreateCollection,
  createCollectionAccountsToCompare,
} from "./fixtures/program-examples-nft-operations-fixture.ts";
import { existsSync } from "node:fs";

if (!existsSync(LIB_RS)) {
  console.warn(
    `[differential-program-examples-nft-operations] SKIPPED — ${LIB_RS} missing. ` +
      `Clone github.com/solana-developers/program-examples to /tmp/program-examples first.`,
  );
} else {
  defineDifferential({
    fixtureName: "program-examples-nft-operations",
    programIdBase58: PROGRAM_ID,
    anchorSource: loadAnchorSource(),
    // Unique cargo package name (must not collide with sibling fixtures
    // in the same Bun session).
    anchorPackageName: "pe_nft_operations_diff",
    // Upstream Cargo.toml pins anchor-lang = "1.0.0-rc.5" with
    // anchor-spl = "1.0.0-rc.5" features = ["metadata"] + init-if-needed.
    // Use anchorReferenceCrateDir so the upstream Cargo.toml + 1.0-rc.5
    // pinning is preserved verbatim — a scratch lib.rs build would need
    // to re-encode all the version pins, feature flags, and the
    // workspace-resolved metadata module would still risk drift.
    anchorReferenceCrateDir: CRATE_DIR,
    // create_metadata_accounts_v3 + create_master_edition_v3 both CPI
    // into MPL Token Metadata. Both runs need the real .so loaded at
    // its canonical address — else both sides fail identically and
    // the byte-equal compares trivially-pass.
    auxiliaryPrograms: [
      { programId: MPL_PROGRAM_ID, soFilename: "mpl_token_metadata.so" },
    ],

    setup: setupCreateCollection,
    callScript: callCreateCollection,
    accountsToCompare: createCollectionAccountsToCompare,
    // mint + ATA + metadata PDA + master_edition PDA are SPL/MPL-owned
    // — none of them carry an Anchor 8-byte discriminator. Stripping 8
    // bytes there would silently chop real state.
    stripDiscriminator: false,
  });
}

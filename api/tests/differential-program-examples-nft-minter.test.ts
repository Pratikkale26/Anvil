/**
 * program-examples-nft-minter differential.
 *
 * The most-shape-dense byte-equal fixture in the portfolio. A SINGLE
 * instruction (`mint_nft`) chains the entire NFT-mint pipeline end-to-end:
 *
 *   1. #[account(init, mint::decimals = 0, mint::authority, mint::freeze_authority)]
 *      — system::create_account + spl_token::initialize_mint (decimals=0 NFT pattern).
 *   2. #[account(init_if_needed, associated_token::mint, associated_token::authority)]
 *      — spl_associated_token_account::create CPI. Needs anchor-lang
 *      `init-if-needed` feature flag.
 *   3. token::mint_to CPI (amount=1) — typed IR kind cpi_spl_mint_to.
 *   4. create_metadata_accounts_v3 CPI — cpi_mpl_create_metadata_v3.
 *   5. create_master_edition_v3 CPI — cpi_mpl_create_master_edition_v3,
 *      the only fixture in the portfolio that fires this typed IR kind
 *      end-to-end against the real mpl_token_metadata.so.
 *
 * Byte-equal on 4 accounts:
 *   - mint_account (post-initialize_mint state, mint_to bumps supply to 1)
 *   - associated_token_account (post-ATA-init + post-mint_to balance=1)
 *   - metadata_pda (post-create_metadata_accounts_v3, MPL-allocated)
 *   - edition_pda (post-create_master_edition_v3, MPL-allocated)
 *
 * Source: github.com/solana-developers/program-examples (tokens/nft-minter).
 * Single-file lib.rs. MPL Token Metadata reference .so loaded into LiteSVM
 * via auxiliaryPrograms (canonical metaqbxx... address).
 */
import { defineDifferential } from "./differential-harness.ts";
import {
  LIB_RS,
  PROGRAM_ID,
  MPL_PROGRAM_ID,
  loadAnchorSource,
  setupNftMinter,
  callMintNft,
  nftMinterAccountsToCompare,
} from "./fixtures/program-examples-nft-minter-fixture.ts";
import { existsSync } from "node:fs";

if (!existsSync(LIB_RS)) {
  console.warn(
    `[differential-program-examples-nft-minter] SKIPPED — ${LIB_RS} missing. ` +
      `Clone github.com/solana-developers/program-examples to /tmp/program-examples first.`,
  );
} else {
  defineDifferential({
    fixtureName: "program-examples-nft-minter",
    programIdBase58: PROGRAM_ID,
    anchorSource: loadAnchorSource(),
    anchorPackageName: "nft_minter_external_diff",
    // Need both `token` (mint + ATA + mint_to) AND `metadata` (create_metadata
    // + create_master_edition CPIs). AssociatedToken support is pulled in
    // by the `token` feature in anchor-spl 0.32 — same setting used by the
    // transfer-tokens fixture which also exercises init_if_needed on an ATA.
    anchorExtraDeps:
      'anchor-spl = { version = "0.32", features = ["token", "metadata"] }',
    anchorVersionOverride: "0.32",
    // associated_token_account uses `init_if_needed`. Anchor gates this
    // behind a cargo feature to force opt-in acknowledgement of the
    // re-init-attack mitigation responsibility. Without it the macro
    // refuses to expand the Bumps impl.
    anchorLangFeatures: ["init-if-needed"],
    // mint_nft CPIs into MPL Token Metadata twice (create_metadata_v3 +
    // create_master_edition_v3). The litesvm scenario needs the real
    // MPL .so loaded at its canonical address in BOTH Anchor and Anvil
    // runs — else both sides fail the CPI identically and the test would
    // trivially-pass.
    auxiliaryPrograms: [
      { programId: MPL_PROGRAM_ID, soFilename: "mpl_token_metadata.so" },
    ],

    setup: setupNftMinter,
    callScript: callMintNft,
    accountsToCompare: nftMinterAccountsToCompare,
  });
}

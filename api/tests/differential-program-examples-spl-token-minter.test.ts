/**
 * program-examples-spl-token-minter differential.
 *
 * Sibling to program-examples-create-token: both originate from
 * solana-developers/program-examples and both end up CPI-ing
 * create_metadata_accounts_v3 after a mint init. Different upstream
 * source (different declare_id, different account field ordering in
 * the Accounts struct, no decimals instruction arg) — keeping it as a
 * separate byte-equal fixture regression-catches drift between the
 * two shapes that share the same Anvil emit paths.
 *
 * Byte-equal on:
 *   - mint_account (post-initialize_mint state)
 *   - metadata_pda (post-create_metadata_accounts_v3)
 *
 * Source: github.com/solana-developers/program-examples
 *   (tokens/spl-token-minter). MPL Token Metadata reference program
 * loaded into LiteSVM via auxiliaryPrograms.
 */
import { defineDifferential } from "./differential-harness.ts";
import {
  LIB_RS,
  PROGRAM_ID,
  MPL_PROGRAM_ID,
  loadAnchorSource,
  setupSplTokenMinter,
  callCreateToken,
  splTokenMinterAccountsToCompare,
} from "./fixtures/program-examples-spl-token-minter-fixture.ts";
import { existsSync } from "node:fs";

if (!existsSync(LIB_RS)) {
  console.warn(
    `[differential-program-examples-spl-token-minter] SKIPPED — ${LIB_RS} missing. ` +
      `Clone github.com/solana-developers/program-examples to /tmp/program-examples first.`,
  );
} else {
  defineDifferential({
    fixtureName: "program-examples-spl-token-minter",
    programIdBase58: PROGRAM_ID,
    anchorSource: loadAnchorSource(),
    anchorPackageName: "spl_token_minter_external_diff",
    anchorExtraDeps:
      'anchor-spl = { version = "0.32", features = ["token", "metadata"] }',
    anchorVersionOverride: "0.32",
    // The MintToken struct uses `init_if_needed` on the associated_token_account.
    // Anchor requires opt-in via this cargo feature to acknowledge the
    // re-init-attack mitigation responsibility. Without it the macro
    // doesn't expand and downstream code can't find the Bumps impl.
    anchorLangFeatures: ["init-if-needed"],
    // create_token CPI's into MPL Token Metadata; the litesvm scenario
    // must have the real MPL .so loaded at the canonical address.
    auxiliaryPrograms: [
      { programId: MPL_PROGRAM_ID, soFilename: "mpl_token_metadata.so" },
    ],

    setup: setupSplTokenMinter,
    callScript: callCreateToken,
    accountsToCompare: splTokenMinterAccountsToCompare,
  });
}

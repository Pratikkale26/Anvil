/**
 * program-examples-pda-mint-authority differential.
 *
 * Exercises a "PDA-as-mint" shape: the mint_account itself is a PDA at
 * seeds = [b"mint"], and the same PDA is also the mint/freeze authority.
 * The create_metadata_accounts_v3 CPI is signed by that PDA (PDA is the
 * update authority too).
 *
 * Distinguishing constraints vs. the sibling create-token / spl-token-minter
 * fixtures:
 *   - mint_account is a PDA (not a fresh keypair) — Anchor's
 *     `#[account(init, seeds = ..., bump, mint::*)]` expands to a
 *     system::create_account *with PDA signer seeds* + spl_token::initialize_mint.
 *   - mint authority + freeze authority both reference mint_account.key(),
 *     i.e. the PDA itself. Self-authority pattern.
 *   - PDA signer seeds used for the metadata CPI: ["mint", mint_bump].
 *
 * Byte-equal on:
 *   - mint_account (post-initialize_mint) — verifies the mint header
 *     (decimals=9, mint_authority=PDA, freeze_authority=PDA, supply=0,
 *     is_initialized=1, COption tags) matches Anchor exactly.
 *   - metadata_pda (post-create_metadata_accounts_v3) — verifies the
 *     Borsh metadata layout matches.
 *
 * Source: github.com/solana-developers/program-examples
 *   (tokens/pda-mint-authority). MPL Token Metadata reference program
 * loaded into LiteSVM via auxiliaryPrograms.
 */
import { defineDifferential } from "./differential-harness.ts";
import {
  LIB_RS,
  PROGRAM_ID,
  MPL_PROGRAM_ID,
  loadAnchorSource,
  setupPdaMintAuthority,
  callCreateToken,
  pdaMintAuthorityAccountsToCompare,
} from "./fixtures/program-examples-pda-mint-authority-fixture.ts";
import { existsSync } from "node:fs";

if (!existsSync(LIB_RS)) {
  console.warn(
    `[differential-program-examples-pda-mint-authority] SKIPPED — ${LIB_RS} missing. ` +
      `Clone github.com/solana-developers/program-examples to /tmp/program-examples first.`,
  );
} else {
  defineDifferential({
    fixtureName: "program-examples-pda-mint-authority",
    programIdBase58: PROGRAM_ID,
    anchorSource: loadAnchorSource(),
    anchorPackageName: "token_minter_pda_external_diff",
    anchorExtraDeps:
      'anchor-spl = { version = "0.32", features = ["token", "metadata"] }',
    anchorVersionOverride: "0.32",
    // The MintToken accounts struct uses `init_if_needed` on the
    // associated_token_account. Anchor requires explicit opt-in via this
    // cargo feature to acknowledge re-init-attack responsibility. Without
    // it the macro doesn't expand and the downstream `mint_token` body
    // can't satisfy `Bumps` for the Context. We never call mint_token
    // from the differential, but the reference crate must still compile
    // end-to-end.
    anchorLangFeatures: ["init-if-needed"],
    // create_token CPI's into MPL Token Metadata; the litesvm scenario
    // must have the real MPL .so loaded at its canonical address.
    auxiliaryPrograms: [
      { programId: MPL_PROGRAM_ID, soFilename: "mpl_token_metadata.so" },
    ],

    setup: setupPdaMintAuthority,
    callScript: callCreateToken,
    accountsToCompare: pdaMintAuthorityAccountsToCompare,
  });
}

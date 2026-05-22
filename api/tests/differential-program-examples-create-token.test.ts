/**
 * program-examples-create-token differential.
 *
 * Exercises the most complex shape so far in the byte-equal portfolio:
 *   - #[account(init, mint::decimals, mint::authority)] — Anchor expands
 *     this to system::create_account + spl_token::initialize_mint CPI pair
 *   - seeds::program = token_metadata_program.key() — PDA derived under
 *     MPL, not the calling program
 *   - create_metadata_accounts_v3 CPI — typed IR kind cpi_mpl_create_metadata_v3
 *     emits hand-rolled discriminator + Borsh payload + 6-account meta
 *
 * Byte-equal on BOTH mint_account (post-initialize_mint state) AND
 * metadata_pda (post-create_metadata_accounts_v3) — if any of {spl-token
 * init shape, MPL Borsh layout, PDA seed derivation, account ordering}
 * drifts, this fires.
 *
 * Source: github.com/solana-developers/program-examples (tokens/create-token).
 * MPL Token Metadata + spl-token reference programs loaded into LiteSVM
 * via auxiliaryPrograms.
 */
import { defineDifferential } from "./differential-harness.ts";
import {
  LIB_RS,
  PROGRAM_ID,
  MPL_PROGRAM_ID,
  loadAnchorSource,
  setupCreateToken,
  callCreateTokenMint,
  createTokenAccountsToCompare,
} from "./fixtures/program-examples-create-token-fixture.ts";
import { existsSync } from "node:fs";

if (!existsSync(LIB_RS)) {
  console.warn(
    `[differential-program-examples-create-token] SKIPPED — ${LIB_RS} missing. ` +
      `Clone github.com/solana-developers/program-examples to /tmp/program-examples first.`,
  );
} else {
  defineDifferential({
    fixtureName: "program-examples-create-token",
    programIdBase58: PROGRAM_ID,
    anchorSource: loadAnchorSource(),
    anchorPackageName: "create_token_external_diff",
    anchorExtraDeps:
      'anchor-spl = { version = "0.32", features = ["token", "metadata"] }',
    anchorVersionOverride: "0.32",
    // The create_token_mint instruction CPI's into MPL Token Metadata; the
    // litesvm scenario needs the real MPL .so loaded at its canonical address.
    auxiliaryPrograms: [
      { programId: MPL_PROGRAM_ID, soFilename: "mpl_token_metadata.so" },
    ],

    setup: setupCreateToken,
    callScript: callCreateTokenMint,
    accountsToCompare: createTokenAccountsToCompare,
  });
}

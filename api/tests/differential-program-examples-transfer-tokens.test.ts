/**
 * program-examples-transfer-tokens differential.
 *
 * Sibling to program-examples-create-token / spl-token-minter: all three
 * originate from solana-developers/program-examples (tokens/*). This one
 * exercises the transfer path — token::transfer CPI combined with
 * `init_if_needed` on the recipient ATA.
 *
 * Byte-equal on:
 *   - sender_token_account (post-debit)
 *   - recipient_token_account (post-credit + init_if_needed allocation)
 *
 * The init_if_needed half is the interesting bit: the program-under-test
 * runs the CPI chain that ata-creates the recipient's token account
 * (SystemProgram::create_account + spl_token::initialize_account3 via
 * the ATA program), and the resulting buffer must match byte-for-byte.
 *
 * Source: github.com/solana-developers/program-examples
 *   (tokens/transfer-tokens).
 * No auxiliary programs needed — transfer_tokens does not touch MPL.
 */
import { defineDifferential } from "./differential-harness.ts";
import {
  LIB_RS,
  PROGRAM_ID,
  loadAnchorSource,
  setupTransferTokens,
  callTransferTokens,
  transferTokensAccountsToCompare,
} from "./fixtures/program-examples-transfer-tokens-fixture.ts";
import { existsSync } from "node:fs";

if (!existsSync(LIB_RS)) {
  console.warn(
    `[differential-program-examples-transfer-tokens] SKIPPED — ${LIB_RS} missing. ` +
      `Clone github.com/solana-developers/program-examples to /tmp/program-examples first.`,
  );
} else {
  defineDifferential({
    fixtureName: "program-examples-transfer-tokens",
    programIdBase58: PROGRAM_ID,
    anchorSource: loadAnchorSource(),
    anchorPackageName: "transfer_tokens_external_diff",
    // Need both `token` (transfer_tokens path) AND `metadata` (sibling
    // create.rs imports `anchor_spl::metadata`; the reference crate must
    // compile end-to-end even though our test only invokes transfer_tokens).
    anchorExtraDeps:
      'anchor-spl = { version = "0.32", features = ["token", "metadata"] }',
    anchorVersionOverride: "0.32",
    // recipient_token_account uses `init_if_needed`. Anchor requires
    // opt-in via this cargo feature to acknowledge the re-init-attack
    // mitigation responsibility. Without it the macro doesn't expand
    // and downstream code can't find the Bumps impl.
    anchorLangFeatures: ["init-if-needed"],

    setup: setupTransferTokens,
    callScript: callTransferTokens,
    accountsToCompare: transferTokensAccountsToCompare,
  });
}

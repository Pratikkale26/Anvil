/**
 * program-examples close-account differential — byte-equal on
 * `#[account(..., close = recipient)]` after a create + close pair.
 *
 * The test runs `create_user(name)` to allocate + write a PDA, then
 * `close_user()` whose Accounts struct has `close = user`. The compare
 * set covers both ends of the close routine:
 *   - the closed PDA (data zeroed, 0 lamports, owner = System Program)
 *   - the rent recipient / payer (lamports must match between Anchor
 *     and Anvil .so runs — same airdrop, same tx fees, same refunded rent).
 *
 * Any divergence in Anvil's emit for the close constraint — wrong
 * lamport drain order, missed owner reassign, leftover data bytes,
 * missing CLOSED_ACCOUNT_DISCRIMINATOR write — surfaces here as a
 * per-field diff in the harness output.
 *
 * Source: github.com/solana-developers/program-examples
 *         (basics/close-account/anchor).
 * Counts toward grant A1 (10 byte-equal external Anchor programs).
 */
import { defineDifferential } from "./differential-harness.ts";
import {
  LIB_RS,
  CRATE_DIR,
  PROGRAM_ID,
  ensureRepoCloned,
  loadAnchorSource,
  setupCloseAccount,
  callCloseAccountFlow,
  closeAccountAccountsToCompare,
} from "./fixtures/program-examples-close-account-fixture.ts";
import { existsSync } from "node:fs";

ensureRepoCloned();

if (!existsSync(LIB_RS)) {
  console.warn(
    `[differential-program-examples-close-account] SKIPPED — ${LIB_RS} missing. ensureRepoCloned tried to clone github.com/solana-developers/program-examples.`,
  );
} else {
  defineDifferential({
    fixtureName: "program-examples-close-account",
    programIdBase58: PROGRAM_ID,
    anchorSource: loadAnchorSource(),
    anchorPackageName: "pe_close_account_diff",
    // Build the upstream crate verbatim — multi-file (lib.rs +
    // instructions/{create_user,close_user}.rs + state/user_state.rs)
    // and pinned to anchor-lang 1.0.0 in its own Cargo.toml. Avoids
    // re-deriving a single-file scaffold for the reference build.
    anchorReferenceCrateDir: CRATE_DIR,

    setup: setupCloseAccount,
    callScript: callCloseAccountFlow,
    accountsToCompare: closeAccountAccountsToCompare,
    // Post-close the user_account has empty data — the default 8-byte
    // discriminator strip would either no-op or underflow. Disable so
    // the comparison sees the raw post-close bytes verbatim.
    stripDiscriminator: false,
  });
}

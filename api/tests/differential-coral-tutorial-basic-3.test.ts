/**
 * coral-xyz/anchor `examples/tutorial/basic-3/programs/puppet` byte-equal.
 *
 * Only the `puppet` half of the basic-3 CPI pair — `puppet-master` needs
 * declare_program! + lever.so staging which is a separate concern.
 * Exercises non-PDA init + plain u64 field write via two sequential txs:
 * initialize → set_data(0x1234_5678_9ABC_DEF0).
 *
 * Counts toward grant A1 (10 byte-equal external Anchor programs).
 */
import { defineDifferential } from "./differential-harness.ts";
import {
  LIB_RS,
  CRATE_DIR,
  PROGRAM_ID,
  ensureRepoCloned,
  loadAnchorSource,
  setupPuppet,
  callInitializeThenSetData,
  puppetAccountsToCompare,
} from "./fixtures/coral-tutorial-basic-3-fixture.ts";
import { existsSync } from "node:fs";

ensureRepoCloned();

if (!existsSync(LIB_RS)) {
  console.warn(
    `[differential-coral-tutorial-basic-3] SKIPPED — ${LIB_RS} missing.`,
  );
} else {
  defineDifferential({
    fixtureName: "coral-tutorial-basic-3-puppet",
    programIdBase58: PROGRAM_ID,
    anchorSource: loadAnchorSource(),
    anchorPackageName: "coral_basic_3_puppet_diff",
    anchorReferenceCrateDir: CRATE_DIR,
    setup: setupPuppet,
    callScript: callInitializeThenSetData,
    accountsToCompare: puppetAccountsToCompare,
  });
}

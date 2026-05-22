/**
 * coral-tutorial-basic-2 differential — external real-world byte-equal target.
 *
 * Source: github.com/coral-xyz/anchor — examples/tutorial/basic-2. A
 * Counter program with `has_one = authority` on increment. Exercises a
 * Pubkey arg passed into the init handler that gets stored in the account.
 *
 * Scope: byte-equal on `counter` post-create. The deterministic authority
 * Pubkey + zero count post-create write must match Anchor exactly. Tests
 * Pubkey + u64 Borsh layout in a two-field state.
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
  setupCreate,
  callCreate,
  basic2AccountsToCompare,
} from "./fixtures/coral-tutorial-basic-2-fixture.ts";
import { existsSync } from "node:fs";

ensureRepoCloned();

if (!existsSync(LIB_RS)) {
  console.warn(
    `[differential-coral-tutorial-basic-2] SKIPPED — ${LIB_RS} missing. ensureRepoCloned tried to clone github.com/coral-xyz/anchor.`,
  );
} else {
  defineDifferential({
    fixtureName: "coral-tutorial-basic-2-create",
    programIdBase58: PROGRAM_ID,
    anchorSource: loadAnchorSource(),
    anchorPackageName: "coral_tutorial_basic_2_diff",
    anchorReferenceCrateDir: CRATE_DIR,

    setup: setupCreate,
    callScript: callCreate,
    accountsToCompare: basic2AccountsToCompare,
  });
}

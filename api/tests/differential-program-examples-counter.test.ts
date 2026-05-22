/**
 * program-examples-counter differential — third grant deliverable axis.
 *
 * The `counter_anchor` program from solana-developers/program-examples
 * (basics/counter/anchor). Differs from the in-tree demo counter:
 *   - fresh keypair account, not PDA
 *   - no-arg init + no-arg increment
 *   - upstream `checked_add(1).unwrap()` on a u64 counter field
 *
 * Counts toward grant A1 (10 byte-equal external Anchor programs).
 */
import { defineDifferential } from "./differential-harness.ts";
import {
  LIB_RS,
  PROGRAM_ID,
  ensureRepoCloned,
  loadAnchorSource,
  setupCounter,
  callCounterFlow,
  counterAccountsToCompare,
} from "./fixtures/program-examples-counter-fixture.ts";
import { existsSync } from "node:fs";

ensureRepoCloned();

if (!existsSync(LIB_RS)) {
  console.warn(
    `[differential-program-examples-counter] SKIPPED — ${LIB_RS} missing. ensureRepoCloned tried to clone github.com/solana-developers/program-examples.`,
  );
} else {
  defineDifferential({
    fixtureName: "program-examples-counter",
    programIdBase58: PROGRAM_ID,
    anchorSource: loadAnchorSource(),
    // Unique package name so the scratch dir doesn't collide with the in-tree
    // counter fixture (`counter_anchor_diff`).
    anchorPackageName: "counter_anchor_external_diff",
    anchorVersionOverride: "0.32",

    setup: setupCounter,
    callScript: callCounterFlow,
    accountsToCompare: counterAccountsToCompare,
  });
}

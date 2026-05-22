/**
 * program-examples-transfer-sol differential — grant A1 byte-equal axis.
 *
 * The `transfer_sol` program from solana-developers/program-examples
 * (basics/transfer-sol/anchor). Canonical SOL-transfer-via-CPI shape:
 * Anchor program wraps a `system_program::transfer` CPI in an
 * instruction handler.
 *
 * The byte-equal verdict here is driven by lamport equality on payer +
 * recipient post-transfer. Account data is empty (SystemAccount), so
 * compareLamports (default true) is the load-bearing signal.
 *
 * Counts toward grant A1 (10 byte-equal external Anchor programs).
 */
import { defineDifferential } from "./differential-harness.ts";
import {
  LIB_RS,
  PROGRAM_ID,
  ensureRepoCloned,
  loadAnchorSource,
  setupTransferSol,
  callTransferSolWithCpi,
  transferSolAccountsToCompare,
} from "./fixtures/program-examples-transfer-sol-fixture.ts";
import { existsSync } from "node:fs";

ensureRepoCloned();

if (!existsSync(LIB_RS)) {
  console.warn(
    `[differential-program-examples-transfer-sol] SKIPPED — ${LIB_RS} missing. ensureRepoCloned tried to clone github.com/solana-developers/program-examples.`,
  );
} else {
  defineDifferential({
    fixtureName: "program-examples-transfer-sol",
    programIdBase58: PROGRAM_ID,
    anchorSource: loadAnchorSource(),
    // Unique package name so the scratch dir doesn't collide with any
    // other transfer-sol fixture.
    anchorPackageName: "transfer_sol_external_diff",
    anchorVersionOverride: "0.32",

    setup: setupTransferSol,
    callScript: callTransferSolWithCpi,
    accountsToCompare: transferSolAccountsToCompare,
  });
}

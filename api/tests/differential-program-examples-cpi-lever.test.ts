/**
 * program-examples-cpi-lever differential.
 *
 * The `lever` program from solana-developers/program-examples
 * (basics/cross-program-invocation/anchor/programs/lever). Upstream this
 * is paired with a `hand` program that CPI's into lever's `switch_power`;
 * for byte-equal we drive `switch_power` directly because the on-chain
 * state mutation is identical whether reached via CPI or top-level invoke,
 * and skipping the `hand` .so keeps the harness single-program.
 *
 * Flow: initialize -> switch_power("Chekov"). After the flow:
 *   - power.is_on flips false -> true.
 *
 * Counts toward grant A1 (10 byte-equal external Anchor programs).
 */
import { defineDifferential } from "./differential-harness.ts";
import {
  LIB_RS,
  PROGRAM_ID,
  ensureRepoCloned,
  loadAnchorSource,
  setupLever,
  callLeverFlow,
  leverAccountsToCompare,
} from "./fixtures/program-examples-cpi-lever-fixture.ts";
import { existsSync } from "node:fs";

ensureRepoCloned();

if (!existsSync(LIB_RS)) {
  console.warn(
    `[differential-program-examples-cpi-lever] SKIPPED — ${LIB_RS} missing. ensureRepoCloned tried to clone github.com/solana-developers/program-examples.`,
  );
} else {
  defineDifferential({
    fixtureName: "program-examples-cpi-lever",
    programIdBase58: PROGRAM_ID,
    anchorSource: loadAnchorSource(),
    // Unique package name so the scratch dir doesn't collide with anything.
    anchorPackageName: "lever_external_diff",
    anchorVersionOverride: "0.32",

    setup: setupLever,
    callScript: callLeverFlow,
    accountsToCompare: leverAccountsToCompare,
  });
}

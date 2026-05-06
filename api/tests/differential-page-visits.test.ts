/**
 * page-visits differential — RW6, externally-authored Anchor program
 * from solana-developers/program-examples (basics/program-derived-
 * addresses).
 *
 * Sixth real-world byte-equal fixture. Different shape from RW1-RW5:
 * tiny (5 bytes data: u32 + u8), no Strings, no Vec, just a fixed-
 * size primitive struct under a PDA. Tests the byte-equal gate on
 * the simplest possible PDA-init pattern with no variable-length
 * fields — narrows the parity claim to the absolute minimum surface
 * (init prelude + state struct + bump persistence).
 */
import { defineDifferential } from "./differential-harness.ts";
import {
  PROGRAM_ID,
  CRATE_DIR,
  loadAnchorSource,
  setupPageVisits,
  callCreatePageVisits,
  isAvailable,
} from "./fixtures/page-visits-fixture.ts";

if (!isAvailable()) {
  // Fixture warned already.
}

defineDifferential({
  fixtureName: "page-visits",
  programIdBase58: PROGRAM_ID,
  anchorSource: loadAnchorSource(),
  anchorReferenceCrateDir: CRATE_DIR,
  anchorPackageName: "program_derived_addresses_program",
  setup: setupPageVisits,
  callScript: callCreatePageVisits,
  accountsToCompare: (ctx) => [
    { pubkey: ctx.pageVisitsPda, label: "page_visits_pda" },
  ],
});

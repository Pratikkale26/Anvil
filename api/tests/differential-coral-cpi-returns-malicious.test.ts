/**
 * coral-cpi-returns / malicious differential — return-data byte-equality
 * on a hand-rolled `set_return_data(&999u64.to_le_bytes())` call.
 *
 * Exercises a surface most fixtures don't touch: the cross-program
 * return-data channel, written directly via
 * `anchor_lang::solana_program::program::set_return_data(&data)`. The
 * instruction holds no state — accounts unchanged, no PDAs, no CPIs —
 * so the only signal that survives Anvil's emit is the 8-byte return
 * payload itself.
 *
 * If Anvil dropped the set_return_data call, re-encoded the payload,
 * called a different program-id's set_return_data, or returned the
 * bytes via Result<T> instead, the `compareReturnData: true` gate
 * surfaces the mismatch.
 *
 * Source: github.com/coral-xyz/anchor (tests/cpi-returns/programs/malicious).
 * Counts toward grant A1 (10 byte-equal external Anchor programs).
 */
import { defineDifferential } from "./differential-harness.ts";
import {
  LIB_RS,
  CRATE_DIR,
  PROGRAM_ID,
  ensureRepoCloned,
  loadAnchorSource,
  setupSpoofReturn,
  callSpoofReturn,
  spoofReturnAccountsToCompare,
} from "./fixtures/coral-cpi-returns-malicious-fixture.ts";
import { existsSync } from "node:fs";

ensureRepoCloned();

if (!existsSync(LIB_RS)) {
  console.warn(
    `[differential-coral-cpi-returns-malicious] SKIPPED — ${LIB_RS} missing. ensureRepoCloned tried to clone github.com/coral-xyz/anchor.`,
  );
} else {
  defineDifferential({
    fixtureName: "coral-cpi-returns-malicious-spoof",
    programIdBase58: PROGRAM_ID,
    anchorSource: loadAnchorSource(),
    // UNIQUE across fixtures (avoids cargo cache + scratch .so collisions
    // with any other coral-anchor fixture in the same Bun session).
    anchorPackageName: "coral_cpi_returns_malicious_diff",
    // Build upstream crate verbatim — coral-anchor's malicious crate
    // depends on `anchor-lang = { path = "../../../../lang" }`, a
    // workspace path-dep that wouldn't resolve from a scratch lib.rs.
    anchorReferenceCrateDir: CRATE_DIR,

    setup: setupSpoofReturn,
    callScript: callSpoofReturn,
    // No accounts touched — return-data is the entire signal.
    accountsToCompare: spoofReturnAccountsToCompare,
    compareReturnData: true,
  });
}

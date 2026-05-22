/**
 * program-examples anchor-realloc differential — byte-equality on the
 * `update` instruction, which exercises Anchor's realloc constraint
 * family in full (`realloc = ...`, `realloc::payer`, `realloc::zero`).
 *
 * Scenario:
 *   1. initialize("hi")          — fresh-keypair init, account = 14 bytes
 *   2. update("hello, anvil")    — realloc-up to 24 bytes, zero-fill,
 *                                  pay rent delta from payer, overwrite
 *                                  the String field
 *
 * History:
 * - 2026-05-22: filed as a SKIPPED test documenting 2 Anvil emit bugs
 *   surfaced by the byte-equal harness — variable-length account types
 *   treated as fixed-LEN (state.rs MIN_LEN guard issue) AND realloc::zero
 *   constraint dropped (instructions/update.rs hardcoded `realloc(_, false)`).
 * - 2026-05-23: both bugs fixed in commits 6e9ca25 (#56 realloc::zero) and
 *   170ed48 (#55 MIN_LEN). Test promoted to active.
 *
 * Targets native because Pinocchio's stable AccountInfo doesn't expose
 * realloc — see differential-harness.ts anvilTarget docs.
 *
 * Source: github.com/solana-developers/program-examples
 *   (basics/realloc/anchor/programs/anchor-realloc).
 */
import { defineDifferential } from "./differential-harness.ts";
import {
  LIB_RS,
  PROGRAM_ID,
  ensureRepoCloned,
  loadAnchorSource,
  setupAnchorRealloc,
  callAnchorReallocFlow,
  anchorReallocAccountsToCompare,
} from "./fixtures/program-examples-anchor-realloc-fixture.ts";
import { existsSync } from "node:fs";

ensureRepoCloned();

if (!existsSync(LIB_RS)) {
  console.warn(
    `[differential-program-examples-anchor-realloc] SKIPPED — ${LIB_RS} missing.`,
  );
} else {
  defineDifferential({
    fixtureName: "program-examples-anchor-realloc",
    programIdBase58: PROGRAM_ID,
    anchorSource: loadAnchorSource(),
    anchorPackageName: "anchor_realloc_external_diff",
    anchorVersionOverride: "0.32",
    anvilTarget: "native",
    setup: setupAnchorRealloc,
    callScript: callAnchorReallocFlow,
    accountsToCompare: anchorReallocAccountsToCompare,
  });
}

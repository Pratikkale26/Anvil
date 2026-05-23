/**
 * coral-floats differential — external real-world byte-equal target.
 *
 * Source: github.com/coral-xyz/anchor — tests/floats. Non-PDA account
 * with init(payer, space=8+8+4+32), `create(f32, f64)` + `update(f32,
 * f64)` instructions. has_one = authority on update.
 *
 * Scope: byte-equal on `account` (FloatDataAccount) after
 * `create(1.5_f32, 3.14_f64) -> update(2.5_f32, 6.28_f64)`. Exercises:
 *   - f32 + f64 args end-to-end (regression-guards issue #65).
 *   - non-PDA account init (account-as-signer pattern).
 *   - has_one = authority constraint validation on follow-up call.
 *   - sequential field-assign mutation of two float fields.
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
  setupFloats,
  callCreateUpdate,
  floatsAccountsToCompare,
} from "./fixtures/coral-floats-fixture.ts";
import { existsSync } from "node:fs";

ensureRepoCloned();

if (!existsSync(LIB_RS)) {
  console.warn(
    `[differential-coral-floats] SKIPPED — ${LIB_RS} missing. ensureRepoCloned tried to clone github.com/coral-xyz/anchor.`,
  );
} else {
  defineDifferential({
    fixtureName: "coral-floats-create-update",
    programIdBase58: PROGRAM_ID,
    anchorSource: loadAnchorSource(),
    anchorPackageName: "coral_floats_diff",
    anchorReferenceCrateDir: CRATE_DIR,

    setup: setupFloats,
    callScript: callCreateUpdate,
    accountsToCompare: floatsAccountsToCompare,
  });
}

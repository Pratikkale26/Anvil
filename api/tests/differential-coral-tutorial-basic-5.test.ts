/**
 * coral-tutorial-basic-5 differential — external real-world byte-equal target.
 *
 * Source: github.com/coral-xyz/anchor — examples/tutorial/basic-5 (the
 * robot-action-state PDA example). PDA `action_state` keyed by
 * seeds=[b"action-state", user.key().as_ref()] with five instructions
 * (create / walk / run / jump / reset) that each toggle a single u8 field.
 *
 * Scope: byte-equal on `action_state` PDA after `create -> walk -> jump`.
 * Exercises:
 *   - PDA init with a two-part seed (literal bytes + signer pubkey)
 *   - has_one = user constraint validation on follow-up calls (walk + jump)
 *   - sequential plain field-assign mutation of a u8 — regression catcher
 *     for emit drift on the simplest possible state-write shape
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
  setupBasicFive,
  callCreateWalkJump,
  basic5AccountsToCompare,
} from "./fixtures/coral-tutorial-basic-5-fixture.ts";
import { existsSync } from "node:fs";

ensureRepoCloned();

if (!existsSync(LIB_RS)) {
  console.warn(
    `[differential-coral-tutorial-basic-5] SKIPPED — ${LIB_RS} missing. ensureRepoCloned tried to clone github.com/coral-xyz/anchor.`,
  );
} else {
  defineDifferential({
    fixtureName: "coral-tutorial-basic-5-create-walk-jump",
    programIdBase58: PROGRAM_ID,
    anchorSource: loadAnchorSource(),
    anchorPackageName: "coral_basic_5_diff",
    anchorReferenceCrateDir: CRATE_DIR,

    setup: setupBasicFive,
    callScript: callCreateWalkJump,
    accountsToCompare: basic5AccountsToCompare,
  });
}

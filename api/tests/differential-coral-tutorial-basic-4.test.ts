/**
 * coral-tutorial-basic-4 differential — external real-world byte-equal target.
 *
 * Source: github.com/coral-xyz/anchor — examples/tutorial/basic-4. PDA-
 * addressed Counter with seeds=[b"counter"]. Exercises Anvil's PDA init
 * macro expansion (invoke_signed with bump seed), `ctx.bumps.counter`
 * read, and struct-literal write via deref_mut().
 *
 * Scope: byte-equal on `counter` PDA post-initialize. The stored `bump: u8`
 * field is the regression catcher — if Anvil drops `ctx.bumps.counter` and
 * writes 0, byte-compare fails on the final byte.
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
  setupInitialize,
  callInitialize,
  basic4AccountsToCompare,
} from "./fixtures/coral-tutorial-basic-4-fixture.ts";
import { existsSync } from "node:fs";

ensureRepoCloned();

if (!existsSync(LIB_RS)) {
  console.warn(
    `[differential-coral-tutorial-basic-4] SKIPPED — ${LIB_RS} missing. ensureRepoCloned tried to clone github.com/coral-xyz/anchor.`,
  );
} else {
  defineDifferential({
    fixtureName: "coral-tutorial-basic-4-initialize",
    programIdBase58: PROGRAM_ID,
    anchorSource: loadAnchorSource(),
    anchorPackageName: "coral_tutorial_basic_4_diff",
    anchorReferenceCrateDir: CRATE_DIR,

    setup: setupInitialize,
    callScript: callInitialize,
    accountsToCompare: basic4AccountsToCompare,
  });
}

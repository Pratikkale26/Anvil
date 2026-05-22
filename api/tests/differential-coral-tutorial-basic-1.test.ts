/**
 * coral-tutorial-basic-1 differential — external real-world byte-equal target.
 *
 * Source: github.com/coral-xyz/anchor — examples/tutorial/basic-1. The
 * canonical "hello world with state" Anchor tutorial — two instructions
 * (initialize + update) on a u64 field. Single-file program.
 *
 * Scope: byte-equal on `my_account` post-initialize. Validates Anvil's
 * `#[account(init, payer, space)]` emit on a non-PDA keypair-addressed
 * account with a single u64 field, plus the 8-byte Anchor discriminator
 * + Borsh u64 write.
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
  basic1AccountsToCompare,
} from "./fixtures/coral-tutorial-basic-1-fixture.ts";
import { existsSync } from "node:fs";

ensureRepoCloned();

if (!existsSync(LIB_RS)) {
  console.warn(
    `[differential-coral-tutorial-basic-1] SKIPPED — ${LIB_RS} missing. ensureRepoCloned tried to clone github.com/coral-xyz/anchor.`,
  );
} else {
  defineDifferential({
    fixtureName: "coral-tutorial-basic-1-initialize",
    programIdBase58: PROGRAM_ID,
    anchorSource: loadAnchorSource(),
    anchorPackageName: "coral_tutorial_basic_1_diff",
    // Upstream Cargo.toml path-deps anchor-lang from `../../../../lang`.
    anchorReferenceCrateDir: CRATE_DIR,

    setup: setupInitialize,
    callScript: callInitialize,
    accountsToCompare: basic1AccountsToCompare,
  });
}

/**
 * coral-interface-new differential — external real-world byte-equal target.
 *
 * Source: github.com/coral-xyz/anchor — tests/interface-account/programs/new.
 *
 * Scope: byte-equal on `another_account` post-init_another. Validates the
 * 72-byte allocation (8-byte disc + 2x Pubkey zero-init) for an init
 * instruction with no body writes. Sibling fixture `coral-interface-old`
 * covers the 40-byte (1 Pubkey) shape — this widens to the multi-field
 * default-zero case.
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
  setupInitAnother,
  callInitAnother,
  anotherAccountsToCompare,
} from "./fixtures/coral-interface-new-fixture.ts";
import { existsSync } from "node:fs";

ensureRepoCloned();

if (!existsSync(LIB_RS)) {
  console.warn(
    `[differential-coral-interface-new] SKIPPED — ${LIB_RS} missing. ensureRepoCloned tried to clone github.com/coral-xyz/anchor.`,
  );
} else {
  defineDifferential({
    fixtureName: "coral-interface-new-init-another",
    programIdBase58: PROGRAM_ID,
    anchorSource: loadAnchorSource(),
    anchorPackageName: "coral_interface_new_diff",
    // Upstream Cargo.toml path-deps anchor-lang from `../../../../lang`.
    anchorReferenceCrateDir: CRATE_DIR,

    setup: setupInitAnother,
    callScript: callInitAnother,
    accountsToCompare: anotherAccountsToCompare,
  });
}

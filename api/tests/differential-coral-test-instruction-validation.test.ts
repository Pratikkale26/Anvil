/**
 * coral-test-instruction-validation/pass-args-count differential —
 * external real-world byte-equal target.
 *
 * Source: github.com/coral-xyz/anchor —
 * tests/test-instruction-validation/pass-args-count/programs/test-instruction-validation.
 * Single-file Anchor program with two no-op handlers (msg!() only). We
 * dispatch `no_params`, whose NoParams Accounts struct holds a single
 * `user: Signer<'info>` and whose body is `Ok(())` after a log line.
 *
 * Scope: byte-equal on the user signer post-tx (witness-account pattern —
 * no writeable account, so we prove the dispatch path is identical by
 * comparing the signer's data + lamports + owner across both targets).
 * Covers Anchor's bare-dispatch path with a Signer-only Accounts struct
 * and a discriminator-only ix payload — the minimum coverage shape.
 *
 * Counts toward grant A1 (byte-equal external Anchor programs).
 */
import { defineDifferential } from "./differential-harness.ts";
import {
  LIB_RS,
  CRATE_DIR,
  PROGRAM_ID,
  ensureRepoCloned,
  loadAnchorSource,
  setupNoParams,
  callNoParams,
  userAccountsToCompare,
} from "./fixtures/coral-test-instruction-validation-fixture.ts";
import { existsSync } from "node:fs";

ensureRepoCloned();

if (!existsSync(LIB_RS)) {
  console.warn(
    `[differential-coral-test-instruction-validation] SKIPPED — ${LIB_RS} missing. ensureRepoCloned tried to clone github.com/coral-xyz/anchor.`,
  );
} else {
  defineDifferential({
    fixtureName: "coral-test-instruction-validation-no-params",
    programIdBase58: PROGRAM_ID,
    anchorSource: loadAnchorSource(),
    // Unique across fixtures so cargo cache + .so filename don't collide.
    anchorPackageName: "coral_test_ix_validation_diff",
    // Upstream Cargo.toml path-deps `anchor-lang = { path = "../../../../../lang" }`,
    // so we build the reference crate verbatim in-tree.
    anchorReferenceCrateDir: CRATE_DIR,

    setup: setupNoParams,
    callScript: callNoParams,
    accountsToCompare: userAccountsToCompare,
  });
}

/**
 * coral-safety-checks differential — external real-world byte-equal target.
 *
 * Source: github.com/coral-xyz/anchor — tests/safety-checks/programs/
 * account-info. Upstream uses this single-file program in its
 * safety-lint suite (a developer writing `unchecked: AccountInfo<'info>`
 * without `/// CHECK:` is expected to trip the lint). The handler is
 * `Ok(())`.
 *
 * Scope: byte-equal on the lone declared account (`unchecked:
 * AccountInfo<'info>`) post-initialize. The account is pre-seeded with
 * arbitrary bytes, a third-party owner (neither SystemProgram nor the
 * program), and a non-canonical lamport balance. The handler body is
 * `Ok(())` and the struct field is non-mut — so any drift in Anvil's
 * emit on a no-op bare-AccountInfo handler (zeroing, reallocating,
 * reassigning, lamport mutation) is caught by the post-state byte-
 * compare.
 *
 * Why this matters: validates Anvil's no-op handler emit + the bare
 * AccountInfo<'info> pass-through (no type-check, no ownership check,
 * no disc check). Complementary to coral-idl-docs which exercises the
 * typed Account<'info, T> deserialiser — different Anchor code path
 * on both sides.
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
  setupSafetyChecks,
  callSafetyChecks,
  safetyChecksAccountsToCompare,
} from "./fixtures/coral-safety-checks-fixture.ts";
import { existsSync } from "node:fs";

ensureRepoCloned();

if (!existsSync(LIB_RS)) {
  console.warn(
    `[differential-coral-safety-checks] SKIPPED — ${LIB_RS} missing. ensureRepoCloned tried to clone github.com/coral-xyz/anchor.`,
  );
} else {
  defineDifferential({
    fixtureName: "coral-safety-checks-initialize",
    programIdBase58: PROGRAM_ID,
    anchorSource: loadAnchorSource(),
    // Unique cargo package name — must not collide with other coral fixtures.
    anchorPackageName: "coral_safety_checks_diff",
    // Upstream Cargo.toml path-deps anchor-lang from `../../../../lang`,
    // a workspace-relative dep that wouldn't resolve from a scratch lib.rs.
    // anchorReferenceCrateDir lets cargo build the upstream crate verbatim.
    anchorReferenceCrateDir: CRATE_DIR,

    setup: setupSafetyChecks,
    callScript: callSafetyChecks,
    accountsToCompare: safetyChecksAccountsToCompare,
  });
}

/**
 * coral-multiple-errors differential — degenerate-corner-case runtime byte-equal.
 *
 * Source: github.com/coral-xyz/anchor —
 * tests/errors/programs/multiple-errors. Upstream uses this single-file
 * program to verify Anchor's macro expansion tolerates multiple
 * `#[error_code]` enums in the same crate. The program itself is
 * minimal: empty Accounts struct, no args, no msg!(), no state, two
 * disjoint error enums, handler body is `Ok(())`.
 *
 * Scope: zero accounts to compare, but the harness runs the SAME
 * instruction against both Anchor's and Anvil's emitted .so. If either
 * fails the tx, the call script throws and the test fails. If both
 * succeed cleanly with no observable side effects, the test passes — a
 * legitimate runtime equivalence signal for this degenerate fixture.
 *
 * What this byte-equal gates that other fixtures don't:
 *   - Empty Accounts struct path (`#[derive(Accounts)] struct Test {}`)
 *     compiled by Anvil produces an executable .so that handles
 *     `keys=[]` ix without inserting spurious behavior.
 *   - Two disjoint `#[error_code]` enums in the same crate survive
 *     parsing without one swallowing the other.
 *   - Bare `Ok(())` handler — no spurious lamport / data / log /
 *     return-data side effects from the empty handler emit.
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
  setupMultipleErrors,
  callMultipleErrors,
  multipleErrorsAccountsToCompare,
} from "./fixtures/coral-multiple-errors-fixture.ts";
import { existsSync } from "node:fs";

ensureRepoCloned();

if (!existsSync(LIB_RS)) {
  console.warn(
    `[differential-coral-multiple-errors] SKIPPED — ${LIB_RS} missing. ensureRepoCloned tried to clone github.com/coral-xyz/anchor.`,
  );
} else {
  defineDifferential({
    fixtureName: "coral-multiple-errors-test",
    programIdBase58: PROGRAM_ID,
    anchorSource: loadAnchorSource(),
    // Unique cargo package name — used for scratch-dir naming + cache keys
    // on the Anvil side. Reference Anchor build ignores this (its own
    // Cargo.toml under anchorReferenceCrateDir wins).
    anchorPackageName: "coral_multiple_errors_diff",
    // Upstream Cargo.toml path-deps anchor-lang from `../../../../lang`
    // (workspace-relative). anchorReferenceCrateDir lets cargo build the
    // upstream crate verbatim so the path-dep resolves.
    anchorReferenceCrateDir: CRATE_DIR,

    setup: setupMultipleErrors,
    callScript: callMultipleErrors,
    accountsToCompare: multipleErrorsAccountsToCompare,
  });
}

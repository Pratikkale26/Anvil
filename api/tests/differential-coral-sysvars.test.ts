/**
 * coral-sysvars differential — external real-world byte-equal target.
 *
 * Source: github.com/coral-xyz/anchor — tests/sysvars/programs/sysvars.
 * Single-file program whose `sysvars(_ctx)` handler is `Ok(())` and whose
 * Accounts struct declares three typed Sysvar bindings (Clock, Rent,
 * StakeHistory).
 *
 * Scope: byte-equal on the Rent sysvar slot post-sysvars(). Rent is a
 * static schedule deterministic across LiteSVM instances. Clock and
 * StakeHistory drift with slot/epoch — Rent is the right comparison
 * target. The handler is `Ok(())` and the bindings are non-mut, so any
 * accidental Sysvar mutation in Anvil's emit is caught by the post-
 * compare.
 *
 * Why this matters: Sysvar<'info, T> is a fourth Anchor account-binding
 * path none of the shipped 27 coral fixtures exercise (coral-idl-docs =
 * Account<T>, coral-system-accounts = SystemAccount, coral-safety-* =
 * UncheckedAccount / AccountInfo). Validates Anvil emits the typed
 * Sysvar plumbing without writing through the readonly slot.
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
  setupSysvars,
  callSysvars,
  sysvarsAccountsToCompare,
} from "./fixtures/coral-sysvars-fixture.ts";
import { existsSync } from "node:fs";

ensureRepoCloned();

if (!existsSync(LIB_RS)) {
  console.warn(
    `[differential-coral-sysvars] SKIPPED — ${LIB_RS} missing. ensureRepoCloned tried to clone github.com/coral-xyz/anchor.`,
  );
} else {
  defineDifferential({
    fixtureName: "coral-sysvars-sysvars",
    programIdBase58: PROGRAM_ID,
    anchorSource: loadAnchorSource(),
    // Unique cargo package name — must not collide with other coral fixtures.
    anchorPackageName: "coral_sysvars_diff",
    // Upstream Cargo.toml path-deps anchor-lang from `../../../../lang`,
    // a workspace-relative dep that wouldn't resolve from a scratch lib.rs.
    // anchorReferenceCrateDir lets cargo build the upstream crate verbatim.
    anchorReferenceCrateDir: CRATE_DIR,

    setup: setupSysvars,
    callScript: callSysvars,
    accountsToCompare: sysvarsAccountsToCompare,
  });
}

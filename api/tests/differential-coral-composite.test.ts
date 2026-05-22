/**
 * coral-composite differential — third external coral-anchor byte-equal target.
 *
 * Exercises: composite Accounts struct (CompositeUpdate nests Foo+Bar),
 * #[account(zero)] pre-allocation followed by `mut` write, u64 scalar
 * writes on two distinct accounts.
 *
 * Why this matters: validates that Anvil flattens nested Accounts structs
 * in the same declaration order Anchor does. A mismatched account order
 * would silently swap dummy_a and dummy_b writes — caught only because
 * the fixture writes different values into each.
 *
 * Counts toward grant A1 (10 byte-equal external Anchor programs).
 */
import {
  defineDifferential,
} from "./differential-harness.ts";
import {
  LIB_RS,
  PROGRAM_ID,
  ensureRepoCloned,
  loadAnchorSource,
  setupCompositeUpdate,
  callCompositeUpdate,
  compositeAccountsToCompare,
} from "./fixtures/coral-composite-fixture.ts";
import { existsSync } from "node:fs";

ensureRepoCloned();

if (!existsSync(LIB_RS)) {
  console.warn(
    `[differential-coral-composite] SKIPPED — ${LIB_RS} missing. ensureRepoCloned tried to clone github.com/coral-xyz/anchor.`,
  );
} else {
  defineDifferential({
    fixtureName: "coral-composite-update",
    programIdBase58: PROGRAM_ID,
    anchorSource: loadAnchorSource(),
    anchorPackageName: "composite",
    // Single-file fixture; build against published anchor-lang. The
    // upstream Cargo.toml uses a path-dep to the in-repo lang crate, but
    // the source itself only relies on standard Anchor 0.31+ syntax, so
    // building from a fresh scratch dir with published anchor-lang works.
    anchorVersionOverride: "0.32",

    setup: setupCompositeUpdate,
    callScript: callCompositeUpdate,
    accountsToCompare: compositeAccountsToCompare,
  });
}

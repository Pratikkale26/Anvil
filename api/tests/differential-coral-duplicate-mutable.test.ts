/**
 * coral-duplicate-mutable differential — basic init + u64 arg byte-equal.
 *
 * Scope: `initialize` instruction only — Anchor's simplest #[account(init,
 * payer, space)] + one u64 arg → state write pattern. The other handlers
 * (fails_duplicate_mutable, dup, nested_duplicate, etc.) exist to test
 * Anchor's account-validation rules and aren't byte-equal candidates.
 *
 * Source: github.com/coral-xyz/anchor (tests/duplicate-mutable-accounts).
 * Counts toward grant A1 (10 byte-equal external Anchor programs).
 */
import { defineDifferential } from "./differential-harness.ts";
import {
  LIB_RS,
  CRATE_DIR,
  PROGRAM_ID,
  ensureRepoCloned,
  loadAnchorSource,
  setupDuplicateMutable,
  callDuplicateMutableInit,
  duplicateMutableAccountsToCompare,
} from "./fixtures/coral-duplicate-mutable-fixture.ts";
import { existsSync } from "node:fs";

ensureRepoCloned();

if (!existsSync(LIB_RS)) {
  console.warn(
    `[differential-coral-duplicate-mutable] SKIPPED — ${LIB_RS} missing. ensureRepoCloned tried to clone github.com/coral-xyz/anchor.`,
  );
} else {
  defineDifferential({
    fixtureName: "coral-duplicate-mutable-init",
    programIdBase58: PROGRAM_ID,
    anchorSource: loadAnchorSource(),
    anchorPackageName: "duplicate_mutable_accounts",
    // Source uses `dup` (Anchor 0.33+ unreleased feature) and `init_if_needed`.
    // Published anchor-lang versions don't support `dup`, so build against the
    // upstream coral-xyz/anchor workspace anchor-lang via the in-tree path-dep.
    anchorReferenceCrateDir: CRATE_DIR,

    setup: setupDuplicateMutable,
    callScript: callDuplicateMutableInit,
    accountsToCompare: duplicateMutableAccountsToCompare,
  });
}

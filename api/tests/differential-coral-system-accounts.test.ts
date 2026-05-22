/**
 * coral-system-accounts differential — external real-world byte-equal target.
 *
 * Source: github.com/coral-xyz/anchor — tests/system-accounts/programs/
 * system-accounts. Upstream uses this single-file program to verify
 * Anchor's `SystemAccount<'info>` typed wrapper (owner == SystemProgram +
 * empty data). The handler is `Ok(())`.
 *
 * Scope: byte-equal on the `wallet: SystemAccount<'info>` field post-
 * initialize. The account is pre-seeded as SystemProgram-owned, empty
 * data, non-canonical lamport balance. The handler body is `Ok(())` and
 * the struct field is non-mut — so any drift in Anvil's emit on a no-op
 * SystemAccount handler (zeroing, reallocating, reassigning, lamport
 * mutation) is caught by the post-state byte-compare.
 *
 * Why this matters: validates Anvil's no-op handler emit + the typed
 * SystemAccount<'info> binding (third Anchor account-binding path,
 * distinct from coral-idl-docs which exercises Account<'info, T> and
 * coral-safety-checks which exercises bare AccountInfo<'info>).
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
  setupSystemAccounts,
  callSystemAccounts,
  systemAccountsAccountsToCompare,
} from "./fixtures/coral-system-accounts-fixture.ts";
import { existsSync } from "node:fs";

ensureRepoCloned();

if (!existsSync(LIB_RS)) {
  console.warn(
    `[differential-coral-system-accounts] SKIPPED — ${LIB_RS} missing. ensureRepoCloned tried to clone github.com/coral-xyz/anchor.`,
  );
} else {
  defineDifferential({
    fixtureName: "coral-system-accounts-initialize",
    programIdBase58: PROGRAM_ID,
    anchorSource: loadAnchorSource(),
    // Unique cargo package name — must not collide with other coral fixtures.
    anchorPackageName: "coral_system_accounts_diff",
    // Upstream Cargo.toml path-deps anchor-lang from `../../../../lang`,
    // a workspace-relative dep that wouldn't resolve from a scratch lib.rs.
    // anchorReferenceCrateDir lets cargo build the upstream crate verbatim.
    anchorReferenceCrateDir: CRATE_DIR,

    setup: setupSystemAccounts,
    callScript: callSystemAccounts,
    accountsToCompare: systemAccountsAccountsToCompare,
  });
}

/**
 * program-examples-checking-accounts differential — external Anchor byte-equal.
 *
 * The `checking_account_program` from solana-developers/program-examples
 * (basics/checking-accounts/anchor). Constraint-only validation with a
 * `Ok(())` no-op handler body.
 *
 * What this gates that other fixtures don't:
 *   - `owner = id()` constraint must compile + run identically under
 *     Anvil's emit (the constraint pattern shows up in many real programs)
 *   - No-op handler must NOT silently mutate / reassign / close the
 *     constraint-validated accounts. account_to_change is pre-seeded with
 *     a distinctive 32-byte pattern; any drift in data, lamports, or owner
 *     fires the gate.
 *
 * Counts toward grant A1 (10 byte-equal external Anchor programs).
 */
import { defineDifferential } from "./differential-harness.ts";
import {
  LIB_RS,
  PROGRAM_ID,
  ensureRepoCloned,
  loadAnchorSource,
  setupCheckingAccounts,
  callCheckingAccountsFlow,
  checkingAccountsToCompare,
} from "./fixtures/program-examples-checking-accounts-fixture.ts";
import { existsSync } from "node:fs";

ensureRepoCloned();

if (!existsSync(LIB_RS)) {
  console.warn(
    `[differential-program-examples-checking-accounts] SKIPPED — ${LIB_RS} missing. ensureRepoCloned tried to clone github.com/solana-developers/program-examples.`,
  );
} else {
  defineDifferential({
    fixtureName: "program-examples-checking-accounts",
    programIdBase58: PROGRAM_ID,
    anchorSource: loadAnchorSource(),
    // Unique package name so the scratch dir doesn't collide with other
    // fixtures (upstream crate is `anchor-program-example`, used by both
    // checking-accounts and account-data — disambiguate explicitly).
    anchorPackageName: "checking_accounts_external_diff",
    anchorVersionOverride: "0.32",

    setup: setupCheckingAccounts,
    callScript: callCheckingAccountsFlow,
    accountsToCompare: checkingAccountsToCompare,
    // account_to_change is a raw byte buffer pre-seeded via setAccount —
    // not an Anchor-managed account, no 8-byte discriminator to strip.
    stripDiscriminator: false,
  });
}

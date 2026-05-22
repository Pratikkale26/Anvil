/**
 * program-examples-create-account differential.
 *
 * Tests a raw `system_program::create_account` CPI that hands the new
 * account's ownership to the system program (not the calling program).
 * No args, no payload — just allocate-and-assign with rent-exempt
 * minimum lamports computed inline from the Rent sysvar.
 *
 * Adjacent to program-examples-rent (same CPI shape with explicit owner
 * = system_program), but stripped to the minimum: no AddressData borsh
 * payload, no instruction args. Regression-guards the
 * `&ctx.accounts.system_program.key()` owner-arg path in
 * Pinocchio's emitCreateAccountCpi.
 *
 * Source: github.com/solana-developers/program-examples (basics/create-account).
 */
import { defineDifferential } from "./differential-harness.ts";
import {
  LIB_RS,
  PROGRAM_ID,
  loadAnchorSource,
  setupCreateAccount,
  callCreateSystemAccount,
  createAccountAccountsToCompare,
} from "./fixtures/program-examples-create-account-fixture.ts";
import { existsSync } from "node:fs";

if (!existsSync(LIB_RS)) {
  console.warn(
    `[differential-program-examples-create-account] SKIPPED — ${LIB_RS} missing. Clone github.com/solana-developers/program-examples to /tmp/program-examples first.`,
  );
} else {
  defineDifferential({
    fixtureName: "program-examples-create-account",
    programIdBase58: PROGRAM_ID,
    anchorSource: loadAnchorSource(),
    anchorPackageName: "create_account_external_diff",
    anchorVersionOverride: "0.32",

    setup: setupCreateAccount,
    callScript: callCreateSystemAccount,
    accountsToCompare: createAccountAccountsToCompare,
    // new_account has no Anchor discriminator (system-owned, space=0).
    stripDiscriminator: false,
  });
}

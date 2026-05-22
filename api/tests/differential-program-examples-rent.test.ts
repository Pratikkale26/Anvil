/**
 * program-examples-rent differential.
 *
 * Tests a raw `system_program::create_account` CPI that hands the new
 * account's ownership to the system program (not the calling program).
 *
 * Originally surfaced a real Anvil emit bug — Pinocchio's
 * emitCreateAccountCpi was hardcoding owner=program_id, ignoring the
 * source's `&ctx.accounts.system_program.key()` 4th arg. Fixed in the
 * same commit that adds this fixture. The fixture stays as a regression
 * guard.
 *
 * Source: github.com/solana-developers/program-examples (basics/rent).
 */
import { defineDifferential } from "./differential-harness.ts";
import {
  LIB_RS,
  PROGRAM_ID,
  loadAnchorSource,
  setupRent,
  callCreateSystemAccount,
  rentAccountsToCompare,
} from "./fixtures/program-examples-rent-fixture.ts";
import { existsSync } from "node:fs";

if (!existsSync(LIB_RS)) {
  console.warn(
    `[differential-program-examples-rent] SKIPPED — ${LIB_RS} missing. Clone github.com/solana-developers/program-examples to /tmp/program-examples first.`,
  );
} else {
  defineDifferential({
    fixtureName: "program-examples-rent",
    programIdBase58: PROGRAM_ID,
    anchorSource: loadAnchorSource(),
    anchorPackageName: "rent_example_external_diff",
    anchorVersionOverride: "0.32",

    setup: setupRent,
    callScript: callCreateSystemAccount,
    accountsToCompare: rentAccountsToCompare,
    // new_account has no Anchor discriminator (system-owned).
    stripDiscriminator: false,
  });
}

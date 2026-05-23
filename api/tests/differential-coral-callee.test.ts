/**
 * coral-callee differential — external real-world byte-equal target.
 *
 * Source: github.com/coral-xyz/anchor — tests/cpi-returns/programs/callee.
 * Non-PDA `account` (CpiReturnAccount) with init(payer, space=8+8) +
 * `initialize` handler that writes `value = 10`. Three additional
 * handlers (return_u64, return_struct, return_vec, return_u64_from_account)
 * are read-only and use set_return_data — out of scope here.
 *
 * Scope: byte-equal on `account` after a single `initialize` call.
 * Exercises:
 *   - non-PDA account init (account-as-signer pattern).
 *   - literal constant field-assign (`account.value = 10`) — simplest
 *     possible state-write emit path.
 *   - in-mod `#[derive(AnchorSerialize, AnchorDeserialize)] StructReturn`
 *     coexisting with a stateful handler — confirms parser/emit doesn't
 *     drop the stateful init when the mod has an inline aux struct.
 *
 * Counts toward grant A1 (10 byte-equal external Anchor programs).
 */
import { defineDifferential } from "./differential-harness.ts";
import {
  LIB_RS,
  CRATE_DIR,
  PROGRAM_ID,
  ensureRepoCloned,
  loadAnchorSource,
  setupCallee,
  callInitialize,
  calleeAccountsToCompare,
} from "./fixtures/coral-callee-fixture.ts";
import { existsSync } from "node:fs";

ensureRepoCloned();

if (!existsSync(LIB_RS)) {
  console.warn(
    `[differential-coral-callee] SKIPPED — ${LIB_RS} missing. ensureRepoCloned tried to clone github.com/coral-xyz/anchor.`,
  );
} else {
  defineDifferential({
    fixtureName: "coral-callee-initialize",
    programIdBase58: PROGRAM_ID,
    anchorSource: loadAnchorSource(),
    anchorPackageName: "coral_callee_diff",
    anchorReferenceCrateDir: CRATE_DIR,

    setup: setupCallee,
    callScript: callInitialize,
    accountsToCompare: calleeAccountsToCompare,
  });
}

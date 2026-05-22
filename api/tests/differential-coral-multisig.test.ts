/**
 * coral-multisig differential — second external real-world byte-equal target.
 *
 * Exercises: account state init via #[account(zero, signer)], Vec<Pubkey>
 * write, u64 + u8 + u32 scalar writes. No CPI, no PDA derivation in handler.
 *
 * Anchor source: github.com/coral-xyz/multisig (programs/multisig).
 * The fixture pre-allocates a fresh multisig account in the same tx as
 * create_multisig — both .so runs see identical bytes because keypairs
 * are deterministic.
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
  setupCreateMultisig,
  callCreateMultisig,
  multisigAccountsToCompare,
} from "./fixtures/coral-multisig-fixture.ts";
import { existsSync } from "node:fs";

ensureRepoCloned();

if (!existsSync(LIB_RS)) {
  // describe.skip silent-falls-through so CI doesn't fail when an external
  // dev box hasn't cloned coral-xyz/multisig yet.
  console.warn(
    `[differential-coral-multisig] SKIPPED — ${LIB_RS} missing. ensureRepoCloned tried to clone github.com/coral-xyz/multisig.`,
  );
} else {
  defineDifferential({
    fixtureName: "coral-multisig-create",
    programIdBase58: PROGRAM_ID,
    anchorSource: loadAnchorSource(),
    anchorPackageName: "coral_multisig",
    // Coral source uses `ctx.bumps.clone()` — AuthBumps Clone derive
    // landed in Anchor 0.32. 0.31 won't compile the reference.
    anchorVersionOverride: "0.32",

    setup: setupCreateMultisig,
    callScript: callCreateMultisig,
    accountsToCompare: multisigAccountsToCompare,
  });
}

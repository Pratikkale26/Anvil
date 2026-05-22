/**
 * coral-overflow-checks differential — primitive integer byte-equality at MIN/MAX.
 *
 * Exercises every primitive integer width (i8/i16/i32/i64/i128/u8/u16/u32/u64/u128)
 * by writing each at both its MIN and MAX value into a single fresh account.
 * If Anvil's borsh-encoding diverges from Anchor's for any width or sign,
 * this fires.
 *
 * Why this matters: any program touching ints (basically all of them) is
 * sensitive to encoding bugs. A single byte-equal pass here covers a class
 * that would otherwise need 10+ separate fixtures.
 *
 * Source: github.com/coral-xyz/anchor (tests/misc/programs/overflow-checks).
 * Counts toward grant A1 (10 byte-equal external Anchor programs).
 */
import { defineDifferential } from "./differential-harness.ts";
import {
  LIB_RS,
  PROGRAM_ID,
  ensureRepoCloned,
  loadAnchorSource,
  setupOverflowInit,
  callOverflowInit,
  overflowAccountsToCompare,
} from "./fixtures/coral-overflow-checks-fixture.ts";
import { existsSync } from "node:fs";

ensureRepoCloned();

if (!existsSync(LIB_RS)) {
  console.warn(
    `[differential-coral-overflow-checks] SKIPPED — ${LIB_RS} missing. ensureRepoCloned tried to clone github.com/coral-xyz/anchor.`,
  );
} else {
  defineDifferential({
    fixtureName: "coral-overflow-checks-init",
    programIdBase58: PROGRAM_ID,
    anchorSource: loadAnchorSource(),
    anchorPackageName: "overflow_checks",
    // Source uses InitSpace derive (Anchor 0.30+) and the modern Anchor
    // error/bumps shape; 0.32 is the same baseline used for coral-multisig.
    anchorVersionOverride: "0.32",

    setup: setupOverflowInit,
    callScript: callOverflowInit,
    accountsToCompare: overflowAccountsToCompare,
  });
}

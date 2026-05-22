/**
 * coral-interface-account/old differential — external real-world byte-equal target.
 *
 * Source: github.com/coral-xyz/anchor — tests/interface-account/programs/old.
 * Single-file Anchor program with one instruction `init` that #[account(init,
 * payer, space = 40)]-allocates an ExpectedAccount (single `pub data: Pubkey`
 * field, never written by the handler).
 *
 * Scope: byte-equal on the freshly-init'd expected_account. The 8-byte
 * Anchor discriminator + zero-initialized 32-byte data field gives a stable
 * canonical byte string both targets must produce identically. Pure
 * Anchor `#[account(init, payer, space)]` macro coverage — no PDA, no CPI
 * beyond Anchor's macro-expanded system_program::create_account, no
 * clock/sysvar reads.
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
  setupInit,
  callInit,
  expectedAccountsToCompare,
} from "./fixtures/coral-interface-old-fixture.ts";
import { existsSync } from "node:fs";

ensureRepoCloned();

if (!existsSync(LIB_RS)) {
  console.warn(
    `[differential-coral-interface-old] SKIPPED — ${LIB_RS} missing. ensureRepoCloned tried to clone github.com/coral-xyz/anchor.`,
  );
} else {
  defineDifferential({
    fixtureName: "coral-interface-old-init",
    programIdBase58: PROGRAM_ID,
    anchorSource: loadAnchorSource(),
    // Unique across fixtures so cargo cache + .so filename don't collide.
    anchorPackageName: "coral_interface_old_diff",
    // Upstream Cargo.toml path-deps `anchor-lang = { path = "../../../../lang" }`,
    // so we build the reference crate verbatim in-tree.
    anchorReferenceCrateDir: CRATE_DIR,

    setup: setupInit,
    callScript: callInit,
    accountsToCompare: expectedAccountsToCompare,
  });
}

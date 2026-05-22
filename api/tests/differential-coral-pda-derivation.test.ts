/**
 * coral-pda-derivation differential — external real-world byte-equal target.
 *
 * Source: github.com/coral-xyz/anchor — tests/pda-derivation. Multi-file
 * Anchor program (`mod other;` declares AnotherBaseAccount in src/other.rs).
 *
 * Scope: byte-equal on the `init_base` instruction's output state — a
 * BaseAccount with two fields (`base_data: u64`, `base_data_key: Pubkey`).
 * Pure state-init via Anchor's `#[account(init, payer, space)]` macro
 * expansion. No PDA derivation in the handler. No CPI beyond Anchor's
 * macro-expanded system_program::create_account. No clock or sysvar reads.
 *
 * This is +1 toward grant deliverable A1 (10 byte-equal external Anchor
 * programs). Exercises:
 *   - multi-file project flattening through buildProjectSource
 *   - Anchor `#[account(init, payer, space = N)]` macro on a non-PDA keypair
 *   - u64 + Pubkey field writes to a fresh program-owned account
 *   - cross-file `crate::other::AnotherBaseAccount` qualified-path parse
 *     (the parsed IR contains InitAnotherBase / InitMyAccount accounts
 *     structs referencing other.rs's account type, even though only
 *     init_base is exercised in the scenario)
 */
import {
  defineDifferential,
} from "./differential-harness.ts";
import {
  LIB_RS,
  CRATE_DIR,
  PROGRAM_ID,
  ensureRepoCloned,
  loadAnchorSource,
  setupInitBase,
  callInitBase,
  baseAccountsToCompare,
} from "./fixtures/coral-pda-derivation-fixture.ts";
import { existsSync } from "node:fs";

ensureRepoCloned();

if (!existsSync(LIB_RS)) {
  // describe.skip silent-falls-through so CI doesn't fail when an external
  // dev box hasn't cloned coral-xyz/anchor yet.
  console.warn(
    `[differential-coral-pda-derivation] SKIPPED — ${LIB_RS} missing. ensureRepoCloned tried to clone github.com/coral-xyz/anchor.`,
  );
} else {
  defineDifferential({
    fixtureName: "coral-pda-derivation-init-base",
    programIdBase58: PROGRAM_ID,
    anchorSource: loadAnchorSource(),
    anchorPackageName: "pda_derivation",
    // Build the upstream crate verbatim — coral-anchor's pda-derivation
    // test depends on `anchor-lang = { path = "../../../../lang" }` and
    // `anchor-spl = { path = "../../../../spl" }`, workspace path-deps
    // that wouldn't resolve from a scratch lib.rs.
    anchorReferenceCrateDir: CRATE_DIR,

    setup: setupInitBase,
    callScript: callInitBase,
    accountsToCompare: baseAccountsToCompare,
  });
}

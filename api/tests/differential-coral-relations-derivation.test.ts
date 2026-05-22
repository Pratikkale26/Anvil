/**
 * coral-relations-derivation differential — external real-world byte-equal target.
 *
 * Source: github.com/coral-xyz/anchor — tests/relations-derivation. The
 * upstream test crate exercises Anchor's `has_one` constraint expansion and
 * canonical PDA derivation.
 *
 * Scope: byte-equal on the `init_base` instruction's output state — the
 * MyAccount PDA at seeds=[b"seed"] with two fields:
 *   - my_account: Pubkey (32) = ctx.accounts.my_account.key()
 *   - bump: u8 (1)            = ctx.bumps.account
 * Allocated 100 bytes (8 disc + 32 + 1 + 59 zero-fill tail).
 *
 * init_base is the only writable instruction in the crate — test_relation
 * and test_address handlers are pure Ok(()) once Anchor's account-validation
 * macros have run. init_base is therefore the maximum-value byte-equal
 * surface for this fixture.
 *
 * Validates:
 *   - Anchor `#[account(init, payer, seeds = [b"seed"], space = 100, bump)]`
 *     PDA initialization (system_program::create_account macro expansion)
 *   - `ctx.bumps.account` canonical-bump propagation through emit
 *   - `.key()` on a Signer account emits identical bytes across runtimes
 *   - 100-byte allocation with 59 trailing zero bytes after the 41-byte
 *     payload — both runtimes must zero-fill identically
 *
 * +1 toward grant deliverable A1 (10 byte-equal external Anchor programs).
 */
import { defineDifferential } from "./differential-harness.ts";
import {
  LIB_RS,
  CRATE_DIR,
  PROGRAM_ID,
  ensureRepoCloned,
  loadAnchorSource,
  setupInitBase,
  callInitBase,
  accountPdaToCompare,
} from "./fixtures/coral-relations-derivation-fixture.ts";
import { existsSync } from "node:fs";

ensureRepoCloned();

if (!existsSync(LIB_RS)) {
  // describe.skip silent-falls-through so CI doesn't fail when an external
  // dev box hasn't cloned coral-xyz/anchor yet.
  console.warn(
    `[differential-coral-relations-derivation] SKIPPED — ${LIB_RS} missing. ensureRepoCloned tried to clone github.com/coral-xyz/anchor.`,
  );
} else {
  defineDifferential({
    fixtureName: "coral-relations-derivation-init-base",
    programIdBase58: PROGRAM_ID,
    anchorSource: loadAnchorSource(),
    // Unique scratch package name — no-op when anchorReferenceCrateDir is
    // set (the harness uses the upstream Cargo.toml), but kept distinct
    // for fixture-name hygiene.
    anchorPackageName: "coral_relations_diff",
    // Build the upstream crate verbatim — coral-anchor's relations-derivation
    // test depends on `anchor-lang = { path = "../../../../lang" }`, a
    // workspace path-dep that wouldn't resolve from a scratch lib.rs.
    anchorReferenceCrateDir: CRATE_DIR,

    setup: setupInitBase,
    callScript: callInitBase,
    accountsToCompare: accountPdaToCompare,
  });
}

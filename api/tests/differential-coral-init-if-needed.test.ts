/**
 * coral-init-if-needed differential — byte-equal on the simplest init path
 * inside coral-xyz/anchor's `tests/misc/programs/init-if-needed` program.
 *
 * Exercises: pure `#[account(init, payer = payer, space = 8 + 8)]` (plain
 * init, NOT init_if_needed) + a single `u64` field write. No CPI in the
 * handler body, no PDA derivation, no clock/rent reads. The init constraint
 * itself expands to a `system_program::create_account` invoke, which is
 * what the byte-equal compare exercises across the two .so builds.
 *
 * `second_initialize` is chosen over the sibling `initialize` because
 * `initialize` uses `init_if_needed` — that constraint is conditional and
 * adds a "already exists?" branch we don't need for the simplest path.
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
  setupSecondInit,
  callSecondInit,
  secondInitAccountsToCompare,
} from "./fixtures/coral-init-if-needed-fixture.ts";
import { existsSync } from "node:fs";

ensureRepoCloned();

if (!existsSync(LIB_RS)) {
  console.warn(
    `[differential-coral-init-if-needed] SKIPPED — ${LIB_RS} missing. ensureRepoCloned tried to clone github.com/coral-xyz/anchor.`,
  );
} else {
  defineDifferential({
    fixtureName: "coral-init-if-needed-second",
    programIdBase58: PROGRAM_ID,
    anchorSource: loadAnchorSource(),
    anchorPackageName: "init_if_needed",
    // The upstream Cargo.toml uses `anchor-lang = { path = "../../../../lang",
    // features = ["init-if-needed"] }` (workspace path-dep) — a scratch
    // lib.rs build wouldn't resolve that. Route the reference build through
    // the upstream crate verbatim.
    anchorReferenceCrateDir: CRATE_DIR,

    setup: setupSecondInit,
    callScript: callSecondInit,
    accountsToCompare: secondInitAccountsToCompare,
  });
}

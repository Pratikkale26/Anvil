/**
 * program-examples-carnival differential — external Anchor byte-equal.
 *
 * The `carnival` program from solana-developers/program-examples
 * (basics/repository-layout/anchor/programs/carnival). Multi-file
 * Anchor program exercising a `pub mod instructions; pub mod state;`
 * layout with two levels of sub-modules + an empty `pub mod error;`.
 * Each handler delegates to a sibling-module helper fn that iterates
 * an in-memory Vec<T> and emits msg!() lines.
 *
 * What this gates that other fixtures don't:
 *   - Project-source flattening on a `repository-layout` example:
 *     buildProjectSource must collapse `instructions/{mod,eat_food,
 *     play_game,get_on_ride}.rs` and `state/{mod,food,game,ride}.rs`
 *     into a single source blob that both Anvil's parser AND the
 *     reference Anchor build accept.
 *   - `CarnivalContext<'info>` has exactly one declared account
 *     (`payer: Signer<'info>`). The emit must NOT silently walk the
 *     wire-supplied account list and mutate / reassign / close
 *     anything beyond that. We pre-seed a program-owned witness with a
 *     distinctive 32-byte pattern and pass it as a remaining-account
 *     — any drift in data, lamports, or owner fires the gate.
 *
 * Counts toward grant A1 (10+ byte-equal external Anchor programs).
 */
import { defineDifferential } from "./differential-harness.ts";
import {
  LIB_RS,
  PROGRAM_ID,
  loadAnchorSource,
  setupCarnival,
  callEatFood,
  carnivalAccountsToCompare,
} from "./fixtures/program-examples-carnival-fixture.ts";
import { existsSync } from "node:fs";

if (!existsSync(LIB_RS)) {
  console.warn(
    `[differential-program-examples-carnival] SKIPPED — ${LIB_RS} missing. ` +
      `Clone github.com/solana-developers/program-examples to /tmp/program-examples first.`,
  );
} else {
  defineDifferential({
    fixtureName: "program-examples-carnival",
    programIdBase58: PROGRAM_ID,
    anchorSource: loadAnchorSource(),
    // Unique package name so the scratch dir doesn't collide with the
    // other program-examples fixtures.
    anchorPackageName: "carnival_external_diff",
    anchorVersionOverride: "0.32",

    setup: setupCarnival,
    callScript: callEatFood,
    accountsToCompare: carnivalAccountsToCompare,
    // witness is a raw byte buffer pre-seeded via setAccount — not an
    // Anchor-managed account, no 8-byte discriminator to strip.
    stripDiscriminator: false,
  });
}

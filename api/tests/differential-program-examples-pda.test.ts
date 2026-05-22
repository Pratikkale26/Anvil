/**
 * program-examples-pda differential — external real-world byte-equal target.
 *
 * The `program-derived-addresses` Anchor program from
 * solana-developers/program-examples (basics/program-derived-addresses).
 * Multi-file project: src/lib.rs + src/state/*.rs + src/instructions/*.rs.
 *
 * Scope: byte-equal on the PageVisits PDA post-create_page_visits. The
 * compared state is
 *   `page_visits: u32 = 0, bump: u8 = <PDA-derived>`
 * The non-zero bump byte is the load-bearing signal — a divergence in
 * Anvil's PDA derivation (wrong seeds order, wrong program-ID threading)
 * makes the bump differ and trips the gate immediately. The discriminator
 * is also implicitly compared via account-data length + Anchor write-back
 * (stripDiscriminator defaults to true so we compare the 5 post-disc bytes).
 *
 * What this fixture exercises that other A1 fixtures don't:
 *   - `seeds = [PageVisits::SEED_PREFIX, payer.key().as_ref()]` — const-byte
 *     prefix + Pubkey ref seeds, a very common real-world PDA shape.
 *   - `#[account(init, seeds, bump, payer, space)]` macro expansion to a
 *     PDA-signer-seeds CPI into system_program::create_account, including
 *     writing the cached bump byte into the new account's data.
 *   - Cross-file qualified-path parse (handler references
 *     `crate::state::PageVisits` + `PageVisits::SEED_PREFIX` +
 *     `PageVisits::INIT_SPACE` across module boundaries via the
 *     buildProjectSource flatten pipeline).
 *   - `#[derive(InitSpace)]` automatic space calc on a u32+u8 layout
 *     (8-byte discriminator + 4-byte page_visits + 1-byte bump = 13 bytes).
 *
 * Counts toward grant A1 (10 byte-equal external Anchor programs).
 */
import { defineDifferential } from "./differential-harness.ts";
import {
  LIB_RS,
  PROGRAM_ID,
  ensureRepoCloned,
  loadAnchorSource,
  setupPageVisits,
  callPageVisitsFlow,
  pageVisitsAccountsToCompare,
} from "./fixtures/program-examples-pda-fixture.ts";
import { existsSync } from "node:fs";

ensureRepoCloned();

if (!existsSync(LIB_RS)) {
  console.warn(
    `[differential-program-examples-pda] SKIPPED — ${LIB_RS} missing. ensureRepoCloned tried to clone github.com/solana-developers/program-examples.`,
  );
} else {
  defineDifferential({
    fixtureName: "program-examples-pda",
    programIdBase58: PROGRAM_ID,
    anchorSource: loadAnchorSource(),
    // UNIQUE package name. Several program-examples crates share the
    // literal package name `anchor-program-example` (the upstream crate
    // name here too) — pin our own so the scratch dir + cached .so don't
    // collide with checking-accounts, account-data, etc.
    anchorPackageName: "pda_external_diff",
    anchorVersionOverride: "0.32",

    setup: setupPageVisits,
    callScript: callPageVisitsFlow,
    accountsToCompare: pageVisitsAccountsToCompare,
  });
}

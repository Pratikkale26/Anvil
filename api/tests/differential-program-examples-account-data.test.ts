/**
 * program-examples-account-data differential — external Anchor byte-equal.
 *
 * The `account_data_anchor_program` from solana-developers/program-examples
 * (basics/account-data/anchor/programs/anchor-program-example). Multi-file
 * Anchor program exercising `pub mod constants; pub mod instructions;
 * pub mod state;` layout with two levels of sub-modules
 * (`instructions/{mod,create}.rs`, `state/{mod,address_info}.rs`).
 *
 * What this gates that other fixtures don't:
 *   - Project-source flattening on a `pub mod constants; pub mod
 *     instructions; pub mod state;` layout where the `space =
 *     ANCHOR_DISCRIMINATOR_SIZE + AddressInfo::INIT_SPACE` constraint
 *     depends on (a) a cross-module const lookup AND (b) the
 *     `#[derive(InitSpace)]` macro expansion. Either lookup failing
 *     would break the byte-equal allocation parity.
 *   - The `*ctx.accounts.address_info = AddressInfo { ... }` deref-set
 *     pattern must serialize the borsh payload into the underlying
 *     data buffer identically to Anchor's expanded code.
 *
 * Counts toward grant A1 (10+ byte-equal external Anchor programs).
 */
import { defineDifferential } from "./differential-harness.ts";
import {
  LIB_RS,
  CRATE_DIR,
  PROGRAM_ID,
  loadAnchorSource,
  setupAccountData,
  callCreateAddressInfo,
  accountDataAccountsToCompare,
} from "./fixtures/program-examples-account-data-fixture.ts";
import { existsSync } from "node:fs";

if (!existsSync(LIB_RS)) {
  console.warn(
    `[differential-program-examples-account-data] SKIPPED — ${LIB_RS} missing. ` +
      `Clone github.com/solana-developers/program-examples to /tmp/program-examples first.`,
  );
} else {
  defineDifferential({
    fixtureName: "program-examples-account-data",
    programIdBase58: PROGRAM_ID,
    anchorSource: loadAnchorSource(),
    // Unique cargo package name so the scratch dir doesn't collide with
    // other program-examples fixtures running in the same Bun session.
    anchorPackageName: "pe_account_data_diff",
    // Upstream Cargo.toml declares anchor-lang = "1.0.0" (Anchor 1.0.0-rc.5)
    // and the crate sits inside a Cargo workspace. anchorReferenceCrateDir
    // lets cargo build the upstream crate verbatim — the scratch path
    // would otherwise need the same workspace + 1.0.0-rc dep wiring.
    anchorReferenceCrateDir: CRATE_DIR,

    setup: setupAccountData,
    callScript: callCreateAddressInfo,
    accountsToCompare: accountDataAccountsToCompare,
    // address_info is an Anchor #[account] with the canonical 8-byte
    // discriminator at offset 0 — default stripDiscriminator: true is
    // correct (compares the borsh payload only).
    stripDiscriminator: true,
  });
}

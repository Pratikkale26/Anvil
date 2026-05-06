/**
 * account-data differential — RW4, externally-authored Anchor program
 * from solana-developers/program-examples.
 *
 * Stresses the `#[max_len]` fix: AddressInfo has three Strings with
 * max_len(50) each, so Anvil's INIT_SPACE must compute 163 (4+50 +
 * 1 + 4+50 + 4+50). Pre-fix it computed 193 via the String=64 legacy
 * default. The byte-equal gate now confirms both targets allocate the
 * same on-chain buffer and serialize the same bytes into it.
 *
 * Anchor reference is built from the upstream crate verbatim. The
 * Anvil emit consumes the flattened project-source blob (constants +
 * state + instructions modules folded into one).
 */
import { defineDifferential } from "./differential-harness.ts";
import {
  PROGRAM_ID,
  CRATE_DIR,
  loadAnchorSource,
  setupAccountData,
  callCreateAddressInfo,
  isAvailable,
} from "./fixtures/account-data-fixture.ts";

if (!isAvailable()) {
  // Fixture warned already; the harness's auto-skip surfaces the
  // divergence in CI output without hanging.
}

defineDifferential({
  fixtureName: "account-data",
  programIdBase58: PROGRAM_ID,
  anchorSource: loadAnchorSource(),
  anchorReferenceCrateDir: CRATE_DIR,
  anchorPackageName: "account_data_anchor_program",
  setup: setupAccountData,
  callScript: callCreateAddressInfo,
  accountsToCompare: (ctx) => [
    { pubkey: ctx.addressInfo.publicKey, label: "address_info" },
  ],
});

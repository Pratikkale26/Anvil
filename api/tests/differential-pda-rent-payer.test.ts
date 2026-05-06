/**
 * pda-rent-payer differential — RW5, externally-authored Anchor program
 * from solana-developers/program-examples.
 *
 * Stresses pure lamport accounting through a signer-seeded CPI:
 *   1. init_rent_vault funds the PDA from the payer.
 *   2. create_new_account uses the PDA as the *from* on a system_
 *      program::create_account CPI signed by the PDA's seeds.
 *
 * Both accounts compared (rent_vault PDA + new_account) are SystemAccount-
 * shaped — system-owned, zero data — so the byte-equal gate reduces to
 * lamport-equal + owner-equal. If Anvil's emit gets the CPI shape wrong
 * (wrong account ordering, missing signer-seeds, off-by-one rent
 * arithmetic), lamports diverge and the gate fires.
 */
import { defineDifferential } from "./differential-harness.ts";
import {
  PROGRAM_ID,
  CRATE_DIR,
  loadAnchorSource,
  setupPdaRentPayer,
  callPdaRentPayer,
  isAvailable,
} from "./fixtures/pda-rent-payer-fixture.ts";

if (!isAvailable()) {
  // Fixture warned already; the harness's auto-skip surfaces the
  // divergence in CI output without hanging.
}

defineDifferential({
  fixtureName: "pda-rent-payer",
  programIdBase58: PROGRAM_ID,
  anchorSource: loadAnchorSource(),
  anchorReferenceCrateDir: CRATE_DIR,
  anchorPackageName: "pda_rent_payer",
  setup: setupPdaRentPayer,
  callScript: callPdaRentPayer,
  // SystemAccount — no Anchor discriminator. Don't try to strip 8.
  stripDiscriminator: false,
  accountsToCompare: (ctx) => [
    { pubkey: ctx.rentVaultPda, label: "rent_vault_pda" },
    { pubkey: ctx.newAccount.publicKey, label: "new_account" },
  ],
});

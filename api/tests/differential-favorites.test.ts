/**
 * Favorites differential — RW3, externally-authored Anchor program from
 * solana-developers/program-examples.
 *
 * Exercises byte-equal byte parity for an init_if_needed PDA with
 * variable-length fields (String + Vec<String>). Two reasons it's
 * worth its own fixture:
 *
 *   1. Real-world credibility: anvilsol.xyz now claims byte-equality
 *      against an externally-authored program from Anza's example
 *      catalog, not just Anvil-internal demos.
 *   2. Coverage edge: most existing differential fixtures are
 *      fixed-size (u64, Pubkey, [u8; 32]). favorites has a variable-
 *      length String + Vec<String> with borsh-prefixed lengths — a
 *      different shape on disk, and the byte-equal gate proves Anvil's
 *      emit produces the same wire format Anchor does.
 *
 * Anchor reference is built from the upstream crate at
 * /tmp/program-examples/basics/favorites/anchor (auto-cloned by
 * realworld-cargo.test.ts on first run). If the clone isn't there,
 * the fixture skips loudly with a console warn — same convention as
 * realworld-tracking.
 */
import { defineDifferential } from "./differential-harness.ts";
import {
  PROGRAM_ID,
  CRATE_DIR,
  loadAnchorSource,
  setupFavorites,
  callSetFavorites,
  isAvailable,
} from "./fixtures/favorites-fixture.ts";

if (!isAvailable()) {
  // The fixture's isAvailable already warned; the harness's auto-skip
  // surfaces the divergence in CI output without hanging.
}

defineDifferential({
  fixtureName: "favorites",
  programIdBase58: PROGRAM_ID,
  anchorSource: loadAnchorSource(),
  // Build the reference .so directly from the upstream crate — the
  // flattened anchorSource is for Anvil's parser; Anchor's reference
  // build uses the original Cargo.toml + workspace deps.
  anchorReferenceCrateDir: CRATE_DIR,
  // Required because Favorites uses init_if_needed.
  anchorLangFeatures: ["init-if-needed"],
  anchorPackageName: "favorites",
  setup: setupFavorites,
  callScript: callSetFavorites,
  accountsToCompare: (ctx) => [
    { pubkey: ctx.favoritesPda, label: "favorites_pda" },
  ],
});

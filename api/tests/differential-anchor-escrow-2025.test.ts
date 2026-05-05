/**
 * A6 — first real-world differential fixture (byte-equal scope).
 *
 * mikemaccana/anchor-escrow-2025 make_offer init flow. Asserts byte-equal
 * on the offer-PDA only — the credibility-lift claim from A6. The wider
 * "all touched accounts" version lives in differential-tracking.test.ts
 * as a non-blocking ceiling tracker (M3); the same fixture pieces drive
 * both, factored into ./fixtures/anchor-escrow-2025-fixture.ts.
 *
 * Auto-scenario can't synthesize this scenario (the offer PDA's seeds use
 * `id.to_le_bytes().as_ref()` — auto-scenario refuses arg-derived seeds
 * per A1, see scenario-runner-seeds.test.ts). Hand-authored scenario
 * via this fixture file is the supported path.
 */
import { defineDifferential } from "./differential-harness.ts";
import {
  PROGRAM_ID,
  CRATE_DIR,
  ensureRepoCloned,
  loadAnchorSource,
  setupMakeOffer,
  callMakeOffer,
  fullAccountsToCompare,
} from "./fixtures/anchor-escrow-2025-fixture.ts";

ensureRepoCloned();

defineDifferential({
  fixtureName: "anchor-escrow-2025-make-offer",
  programIdBase58: PROGRAM_ID,
  anchorSource: loadAnchorSource(),
  anchorPackageName: "anchor_escrow_2025_diff",
  // Build the upstream crate verbatim (multi-file Anchor projects don't
  // survive flattening as buildable Rust). Anvil-emit path still consumes
  // the flattened source; only the reference build switches modes.
  anchorReferenceCrateDir: CRATE_DIR,

  setup: setupMakeOffer,
  callScript: callMakeOffer,

  // Promoted to FULL compare scope (offer_pda + vault_ata + maker_ata_a)
  // 2026-05-05 after N1 landed TokenInterface runtime-dispatch emit:
  //
  //   - offer_pda byte-equals via set_inner expansion (A6, 41da298)
  //   - vault_ata byte-equals because the helper-fn classification (Path
  //     2 v0, 4f43320) + N1 dispatch generates a real Token-Interface
  //     transfer_checked CPI on Pinocchio that creates+writes the ATA
  //     identical to Anchor's reference
  //   - maker_ata_a byte-equals because that same CPI debits the maker
  //     side identically
  //
  // Differential-tracking.test.ts caught this transition automatically —
  // ceiling was 2 mismatches, dropped to 0, "now BYTE_EQUAL — promote"
  // signal. M3 worked exactly as designed.
  accountsToCompare: fullAccountsToCompare,
});

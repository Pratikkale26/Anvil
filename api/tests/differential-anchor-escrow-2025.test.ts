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
  offerOnlyCompare,
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

  // Compare scope is intentionally narrow: only the offer PDA's bytes.
  // Why not vault_ata + maker_ata_a too? Both surface separable emit gaps:
  //
  //   - vault_ata diverges as PRESENCE: Anchor's reference creates the ATA
  //     via the `init, associated_token::*` constraint; Anvil's emit
  //     doesn't yet generate the ATA-create CPI for this constraint shape.
  //   - maker_ata_a depends on the transfer_tokens helper actually firing.
  //     transfer_tokens lives in a sibling module (handlers/shared.rs) and
  //     is classified as pass_through; user-helper inlining for SPL CPI
  //     wrappers is the Path 2 deferred work.
  //
  // The wider "ceiling-tracked" version that compares all three accounts
  // lives in differential-tracking.test.ts as M3. When the ATA-init +
  // helper-inline gaps close, promote the compare scope here too.
  accountsToCompare: offerOnlyCompare,
});

/**
 * program-examples-escrow differential — external Anchor byte-equal.
 *
 * solana-developers/program-examples' tokens/escrow Anchor program: the
 * canonical "Anchor token escrow" reference. Multi-file Anchor project
 * (lib.rs + constants.rs + error.rs + instructions/{mod,make_offer,
 * take_offer,shared}.rs + state/{mod,offer}.rs) using Anchor 1.0.0-rc.5
 * + token-interface (Interface<TokenInterface> + InterfaceAccount<Mint /
 * TokenAccount>).
 *
 * What this gates that other fixtures don't:
 *   - Project-source flattening over a 9-file layout (2 sub-module
 *     directories) where the make_offer instruction depends on a
 *     `transfer_tokens` helper defined in instructions/shared.rs AND on
 *     the Offer state struct in state/offer.rs. Cross-module call
 *     resolution must work end-to-end for the parser to surface the
 *     typed SPL transfer_checked CPI from the shared helper.
 *   - `set_inner(Offer { ... bump: ctx.bumps.offer })` writes a PDA whose
 *     bump comes from the macro-derived Bumps struct — the typed
 *     pda_signer_seeds + state-write emit path on a 3-seed PDA
 *     (b"offer" + maker + id_le).
 *   - Token-interface dispatch — the Interface<TokenInterface> account
 *     slot supplies the SPL Token program ID at runtime. Emit must
 *     route the transfer_checked CPI through the supplied token_program
 *     account, not hardcoded TOKEN_PROGRAM_ID, for the legacy-vs-T22
 *     parity to hold.
 *
 * Scenario picked: make_offer only. take_offer adds init_if_needed × 2 +
 * PDA-signed CPI close, which is its own differential (and matches the
 * anchor-escrow-2025 split). Narrow byte-equal on Offer PDA — same
 * reasoning as anchor-escrow-2025's offer-only fixture.
 *
 * Counts toward grant A1 (10+ byte-equal external Anchor programs).
 */
import { defineDifferential } from "./differential-harness.ts";
import {
  LIB_RS,
  CRATE_DIR,
  PROGRAM_ID,
  loadAnchorSource,
  setupMakeOffer,
  callMakeOffer,
  makeOfferAccountsToCompare,
} from "./fixtures/program-examples-escrow-fixture.ts";
import { existsSync } from "node:fs";

// Regression gate for finding #62 (asymmetric unsalvageable-call comment-out)
// + the set_inner(Offer { ..., bump: ctx.bumps.X }) helper port. Confirmed
// 2026-05-22: Anvil's emit commented out send_wanted_tokens_to_maker(&context)?
// in take_offer.rs but left the sibling withdraw_and_close_vault(context)?
// uncommented — the leftover call references stale `context` binding and
// fails compile (cannot find value 'context'). make_offer also fails on
// the set_inner(Offer { ..., bump: ctx.bumps.offer }) helper port. Both
// surfaces block byte-equal even though only make_offer is invoked (the
// whole crate must compile for the deployed .so).
//
// Gated behind RUN_PENDING_DIFFERENTIALS=1. Flip on once #62 lands.
const RUN_PENDING = process.env.RUN_PENDING_DIFFERENTIALS === "1";

if (!existsSync(LIB_RS)) {
  console.warn(
    `[differential-program-examples-escrow] SKIPPED — ${LIB_RS} missing. ` +
      `Clone github.com/solana-developers/program-examples to /tmp/program-examples first.`,
  );
} else if (!RUN_PENDING) {
  console.warn(
    `[differential-program-examples-escrow] SKIPPED — pending finding #62 ` +
      `(asymmetric unsalvageable-call comment-out + set_inner bump helper). ` +
      `Set RUN_PENDING_DIFFERENTIALS=1 to run.`,
  );
} else {
  defineDifferential({
    fixtureName: "program-examples-escrow",
    programIdBase58: PROGRAM_ID,
    anchorSource: loadAnchorSource(),
    // Unique scratch cargo package name so the build dir doesn't collide
    // with other program-examples fixtures. (anchorPackageName is IGNORED
    // when anchorReferenceCrateDir is set — the upstream Cargo.toml owns
    // pkg name + deps — but keep a unique value defensively in case the
    // reference-build path falls back to scratch on a future refactor.)
    anchorPackageName: "pe_escrow_diff",
    // Upstream Cargo.toml: anchor-lang = "1.0.0-rc.5" + anchor-spl =
    // "1.0.0-rc.5" + init-if-needed (the take_offer SIBLING struct needs
    // it even though we only call make_offer — finding #47 documented
    // in differential-harness). anchorReferenceCrateDir builds the
    // upstream crate verbatim, so the rc.5 deps + workspace wiring + the
    // init-if-needed feature ride along without scaffold duplication.
    anchorReferenceCrateDir: CRATE_DIR,

    setup: setupMakeOffer,
    callScript: callMakeOffer,
    accountsToCompare: makeOfferAccountsToCompare,
    // Offer is an Anchor #[account] with the 8-byte discriminator at
    // offset 0 — default stripDiscriminator: true compares the borsh
    // payload only (id + maker + token_mint_a + token_mint_b +
    // token_b_wanted_amount + bump).
    stripDiscriminator: true,
  });
}

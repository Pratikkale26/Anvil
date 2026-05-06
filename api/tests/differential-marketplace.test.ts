/**
 * Marketplace differential — closes M1 corpus 10→15.
 *
 * The marketplace.rs demo is structurally an NFT marketplace (admin +
 * fee_bps + treasury + per-listing PDA with vault). This fixture
 * exercises only `initialize` — creates the marketplace PDA and
 * proves the state struct (admin: Pubkey, fee_bps: u16, treasury:
 * Pubkey, bump: u8, listing_count: u64 = 75 bytes) round-trips byte-
 * equal under Anvil's emit.
 *
 * Listing/purchase/delist exercise SPL token CPI surface that's
 * already covered by spl-transfer / set-authority / close fixtures;
 * they'd add NFT mint + ATA setup machinery that overlaps with
 * escrow's coverage. The marketplace PDA layout is the unique-to-
 * marketplace shape, so it's where the byte-equal gate adds
 * coverage that no other fixture provides.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { defineDifferential } from "./differential-harness.ts";
import {
  PROGRAM_ID,
  setupMarketplace,
  callInitializeMarketplace,
} from "./fixtures/marketplace-fixture.ts";

const MARKETPLACE_SRC = join(import.meta.dir, "..", "src", "demo-programs", "marketplace.rs");

defineDifferential({
  fixtureName: "marketplace",
  programIdBase58: PROGRAM_ID,
  anchorSource: readFileSync(MARKETPLACE_SRC, "utf-8"),
  anchorPackageName: "marketplace_anchor_diff",
  // marketplace.rs imports anchor_spl::token::* + associated_token. The
  // narrow `initialize` scenario doesn't actually invoke any of those
  // CPIs, but the Anchor reference build still has to compile against
  // them since they're imported in the source.
  anchorExtraDeps: `anchor-spl = "0.31"`,
  // Purchase ix uses init_if_needed for buyer_ata; Anchor requires this
  // opt-in feature for any program in the build.
  anchorLangFeatures: ["init-if-needed"],
  setup: setupMarketplace,
  callScript: callInitializeMarketplace,
  accountsToCompare: (ctx) => [
    { pubkey: ctx.marketplacePda, label: "marketplace_pda" },
  ],
});

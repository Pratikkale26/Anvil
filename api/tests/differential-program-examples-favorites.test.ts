/**
 * program-examples-favorites differential — external real-world byte-equal
 * target.
 *
 * Source: github.com/solana-developers/program-examples —
 * basics/favorites/anchor. Single-instruction Anchor 1.0-rc.5 program that
 * `set_inner`s a Favorites struct {u64, String, Vec<String>} into an
 * init_if_needed PDA seeded by [b"favorites", user.key()].
 *
 * Scope: byte-equal on the Favorites PDA post-set_favorites. The PDA
 * holds variable-length Borsh state (String + Vec<String>) — exactly the
 * class of payload that catches emit bugs in length-prefix encoding,
 * UTF-8 byte ordering, struct field ordering, and trailing-zero handling
 * inside Anchor's zero-init + InitSpace allocation.
 *
 * Counts toward grant A1 (10 byte-equal external Anchor programs).
 */
import { defineDifferential } from "./differential-harness.ts";
import {
  LIB_RS,
  CRATE_DIR,
  PROGRAM_ID,
  ensureRepoCloned,
  loadAnchorSource,
  setupFavorites,
  callSetFavorites,
  favoritesAccountsToCompare,
} from "./fixtures/program-examples-favorites-fixture.ts";
import { existsSync } from "node:fs";

ensureRepoCloned();

if (!existsSync(LIB_RS)) {
  console.warn(
    `[differential-program-examples-favorites] SKIPPED — ${LIB_RS} missing. ensureRepoCloned tried to clone github.com/solana-developers/program-examples.`,
  );
} else {
  defineDifferential({
    fixtureName: "program-examples-favorites-set-favorites",
    programIdBase58: PROGRAM_ID,
    anchorSource: loadAnchorSource(),
    // Unique cargo package name (must not collide with sibling fixtures).
    anchorPackageName: "pe_favorites_diff",
    // Upstream Cargo.toml pins anchor-lang = "1.0.0-rc.5" with
    // features = ["init-if-needed"]. anchorReferenceCrateDir builds the
    // upstream crate verbatim so the rc.5 version + feature flag are
    // preserved (a scratch lib.rs with anchorVersionOverride would have
    // to re-encode the feature flag and risk drift from upstream).
    anchorReferenceCrateDir: CRATE_DIR,

    setup: setupFavorites,
    callScript: callSetFavorites,
    accountsToCompare: favoritesAccountsToCompare,
  });
}

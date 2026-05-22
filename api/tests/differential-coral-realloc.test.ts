/**
 * coral-realloc differential — PDA-init byte-equality on a Vec<u8> + bump
 * account.
 *
 * Exercises three Borsh/account surfaces in one tight 14-byte payload:
 *   - Vec<u8> length-prefix + payload encoding
 *   - bumps.sample access in handler body
 *   - PDA-derived `#[account(init, seeds=[b"sample"], bump)]` allocation
 *     with non-trivial space expression `Sample::space(1)` resolved
 *     through an impl-block helper
 *
 * Why this matters: any program using PDA-init + variable-length data
 * (lists, dynamic configs, vaults) is sensitive to Vec<u8> encoding and
 * bump-byte placement. One byte-equal check here covers a class that
 * would otherwise need separate fixtures per shape.
 *
 * Source: github.com/coral-xyz/anchor (tests/realloc/programs/realloc).
 * Counts toward grant A1 (10 byte-equal external Anchor programs).
 */
import { defineDifferential } from "./differential-harness.ts";
import {
  LIB_RS,
  CRATE_DIR,
  PROGRAM_ID,
  ensureRepoCloned,
  loadAnchorSource,
  setupReallocInit,
  callReallocInit,
  reallocAccountsToCompare,
} from "./fixtures/coral-realloc-fixture.ts";
import { existsSync } from "node:fs";

ensureRepoCloned();

if (!existsSync(LIB_RS)) {
  console.warn(
    `[differential-coral-realloc] SKIPPED — ${LIB_RS} missing. ensureRepoCloned tried to clone github.com/coral-xyz/anchor.`,
  );
} else {
  defineDifferential({
    fixtureName: "coral-realloc-init",
    programIdBase58: PROGRAM_ID,
    anchorSource: loadAnchorSource(),
    anchorPackageName: "realloc",
    // Build upstream crate verbatim — coral-anchor's realloc crate
    // depends on `anchor-lang = { path = "../../../../lang" }`, a
    // workspace path-dep that wouldn't resolve from a scratch lib.rs.
    anchorReferenceCrateDir: CRATE_DIR,

    setup: setupReallocInit,
    callScript: callReallocInit,
    accountsToCompare: reallocAccountsToCompare,
  });
}

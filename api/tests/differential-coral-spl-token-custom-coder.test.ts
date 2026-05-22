/**
 * coral-xyz/anchor — tests/custom-coder/programs/spl-token differential.
 *
 * External real-world byte-equal target. The program body is
 * `pub mod spl_token {}` (empty mod, zero instructions). Both targets
 * must build a valid BPF loader artifact, reject an unknown-discriminator
 * tx without crashing, and leave the wire-supplied witness account
 * byte-equal post-rollback.
 *
 * The differential signal is weaker than handler-bearing programs (Solana
 * runtime rolls back state on tx failure, so byte-equal post-fail is
 * trivial). The load-bearing assertion here is that Anvil's emit for an
 * empty `pub mod X {}` produces a working loader artifact at all — a
 * regression that builds-but-doesn't-load would be invisible to
 * cargo-check and only surface in this test.
 *
 * Counts toward grant A1 (byte-equal external Anchor programs).
 */
import { defineDifferential } from "./differential-harness.ts";
import {
  LIB_RS,
  CRATE_DIR,
  PROGRAM_ID,
  ensureRepoCloned,
  loadAnchorSource,
  setupSplToken,
  callSplToken,
  splTokenAccountsToCompare,
} from "./fixtures/coral-spl-token-custom-coder-fixture.ts";
import { existsSync } from "node:fs";

ensureRepoCloned();

if (!existsSync(LIB_RS)) {
  console.warn(
    `[differential-coral-spl-token-custom-coder] SKIPPED — ${LIB_RS} missing. ensureRepoCloned tried to clone github.com/coral-xyz/anchor.`,
  );
} else {
  defineDifferential({
    fixtureName: "coral-spl-token-custom-coder-empty-mod",
    programIdBase58: PROGRAM_ID,
    anchorSource: loadAnchorSource(),
    // Unique across fixtures so cargo cache + .so filename don't collide.
    anchorPackageName: "coral_spl_token_custom_coder_diff",
    // Upstream Cargo.toml uses `anchor-lang = { path = "../../../../lang" }`,
    // so we build the reference crate verbatim in-tree (same pattern as
    // coral-interface-old).
    anchorReferenceCrateDir: CRATE_DIR,

    setup: setupSplToken,
    callScript: callSplToken,
    accountsToCompare: splTokenAccountsToCompare,
  });
}

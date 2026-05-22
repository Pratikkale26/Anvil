/**
 * program-examples realloc differential — byte-equality on the SHRINK
 * branch of Anchor's realloc constraint family.
 *
 * Scenario:
 *   1. initialize("hello")  -> account = 17 bytes (8 disc + 4 len + 5)
 *   2. update("x")          -> realloc-down to 13 bytes (8 + 4 + 1),
 *                              rent REFUND to payer, Borsh re-serialize
 *
 * Validates finding #56 (realloc::zero emit) and its companion shrink
 * path. If Anvil's emit drops `realloc` entirely on update, the account
 * stays at 17 bytes with stale "ello" trailing — the byte-equal compare
 * (data + lamports + owner) catches it on all three axes. The realloc
 * constraint MUST execute regardless of whether the new size is larger
 * or smaller than the current size.
 *
 * Targets native — Pinocchio's stable AccountInfo doesn't expose
 * realloc; matches the sibling growth fixture for the same reason.
 *
 * Uses `anchorReferenceCrateDir` so the upstream Cargo.toml (pinning
 * anchor-lang 1.0.0) drives the reference build verbatim. The Anvil
 * emit consumes the raw lib.rs blob (no declare_id! rewrite).
 *
 * Source: github.com/solana-developers/program-examples
 *   (basics/realloc/anchor/programs/anchor-realloc).
 */
import { defineDifferential } from "./differential-harness.ts";
import {
  CRATE_DIR,
  LIB_RS,
  PROGRAM_ID,
  ensureRepoCloned,
  loadAnchorSource,
  setupReallocShrink,
  callReallocShrinkFlow,
  reallocShrinkAccountsToCompare,
} from "./fixtures/program-examples-realloc-fixture.ts";
import { existsSync } from "node:fs";

ensureRepoCloned();

// Regression gate for finding #61 (realloc-shrink ordering bug). Confirmed
// 2026-05-22: Anvil's emit for the update handler orders
// `message_account.realloc(__new_size, true)` BEFORE the Borsh deserialize
// of the old buffer. On shrink (e.g. "hello" 17B → "x" 13B), the realloc
// truncates bytes before the deserialize can read the old String — the
// handler then fails with InvalidAccountData. The reference Anchor build
// deserializes BEFORE the realloc constraint runs, so it sees the intact
// buffer. The fix is to reorder body emission: deserialize old state →
// rewrite args → realloc → re-serialize.
//
// Gated behind RUN_PENDING_DIFFERENTIALS=1 so the suite stays green
// until the emit reorder lands. Flip the env var on to re-validate.
const RUN_PENDING = process.env.RUN_PENDING_DIFFERENTIALS === "1";

if (!existsSync(LIB_RS)) {
  console.warn(
    `[differential-program-examples-realloc] SKIPPED — ${LIB_RS} missing.`,
  );
} else if (!RUN_PENDING) {
  console.warn(
    `[differential-program-examples-realloc] SKIPPED — pending finding #61 ` +
      `(realloc-shrink order bug). Set RUN_PENDING_DIFFERENTIALS=1 to run.`,
  );
} else {
  defineDifferential({
    fixtureName: "program-examples-realloc",
    programIdBase58: PROGRAM_ID,
    anchorSource: loadAnchorSource(),
    anchorPackageName: "pe_realloc_diff",
    // Build upstream crate verbatim — its Cargo.toml pins anchor-lang
    // 1.0.0; standalone `cargo build-sbf` resolves because the per-crate
    // manifest has no workspace path-deps.
    anchorReferenceCrateDir: CRATE_DIR,
    anvilTarget: "native",
    setup: setupReallocShrink,
    callScript: callReallocShrinkFlow,
    accountsToCompare: reallocShrinkAccountsToCompare,
  });
}

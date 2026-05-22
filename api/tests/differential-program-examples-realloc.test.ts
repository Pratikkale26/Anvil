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

// Regression gate for finding #61 (realloc-shrink ordering bug). FIXED in
// emit-time reorder + shrink-refund branch on 2026-05-22. The bug had two
// halves: (1) Anvil's emit for the update handler ordered
// `message_account.realloc(__new_size, true)` BEFORE the Borsh deserialize
// of the old buffer, so on shrink (e.g. "hello" 17B → "x" 13B) the realloc
// truncated bytes before the deserialize could read the old String —
// InvalidAccountData; (2) the realloc rent emit only handled the grow
// direction (system_program transfer payer → account), leaving the lamport
// balance at the pre-shrink value while Anchor refunds the excess rent to
// the payer. The fix mirrors Anchor's lifecycle: deserialize old state →
// inject the realloc block AFTER the read line (using the `_account`
// AccountInfo alias the walker emits at state_read time) → handler body
// mutates the deserialized struct → re-serialize. Shrink branch added via
// direct lamport mutation since system_program won't sign for transfers
// out of a program-owned account.
if (!existsSync(LIB_RS)) {
  console.warn(
    `[differential-program-examples-realloc] SKIPPED — ${LIB_RS} missing.`,
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

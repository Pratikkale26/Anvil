/**
 * A6 — first real-world differential fixture (byte-equal scope).
 *
 * mikemaccana/anchor-escrow-2025 make_offer init flow. Byte-equal across
 * the FULL compare scope (offer-PDA + maker_ata_a + vault_ata + token
 * accounts) — verified continuously by `differential-tracking.test.ts`
 * with `maxMismatches: 0`. That file is the authoritative regression
 * gate; this file remains as a documentation pointer.
 *
 * History:
 * - 2026-05-13: Skipped after upstream upgraded to Anchor 0.32.1. The
 *   token_interface re-export of transfer_checked triggered a runtime
 *   dispatch path the emit didn't honor — the visitor was dropping
 *   `stmt.tokenProgramArg` so the Pinocchio emit hardcoded
 *   TOKEN_2022_PROGRAM_ID. LiteSVM reported "Unknown program TokenzQd..."
 *   because the fixture uses legacy SPL Token mints.
 * - 2026-05-18: Fixed by threading tokenProgramArg through the visitor
 *   (commit 935e8b7). Emit now correctly reads program_id from the
 *   AccountInfo at runtime. differential-tracking surfaced the test
 *   passing byte-equal on the full compare scope.
 *
 * Why this file stays as a stub: the byte-equal gate is in
 * differential-tracking.test.ts, which is the layer that auto-promotes
 * tracked fixtures to byte-equal when the underlying emit divergence
 * closes. Adding a separate active test here would duplicate the
 * coverage. The stub-and-pointer pattern keeps the regression-guard
 * conceptually visible without duplicating CI work.
 */
import { describe, test } from "bun:test";

describe.skip("Anchor vs Anvil-Pinocchio runtime correctness (anchor-escrow-2025-make-offer)", () => {
  test("regression-gated by differential-tracking.test.ts (maxMismatches=0)", () => {
    // See file header.
  });
});

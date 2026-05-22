/**
 * anchor-escrow-2025 take_offer differential.
 *
 * Companion to differential-anchor-escrow-2025.test.ts (make_offer).
 * make_offer verifies the init-side of the escrow flow with 9 accounts;
 * take_offer is a strictly bigger code surface with 12 accounts:
 *
 *   - transfer_tokens called with Some(signers_seeds) — the PDA-signing
 *     CPI branch (make_offer only exercised None).
 *   - close_token_account — new helper from shared.rs, never exercised
 *     by make_offer. Closes the vault back to the maker.
 *   - init_if_needed × 2 (taker_ata_a, maker_ata_b) — both ATAs are
 *     created inside the ix handler.
 *   - has_one + `close = maker` constraint expansion on the offer PDA.
 *
 * SKIPPED — upstream stack-overflow on Anchor reference build (2026-05-22)
 * ─────────────────────────────────────────────────────────────────────
 *
 * Anchor 0.32.1's macro expansion of `try_accounts` for the 12-field
 * TakeOffer struct produces a 4352-byte stack frame; SBF's max is
 * 4096. cargo-build-sbf emits this warning at compile time:
 *
 *   Error: Function _ZN...TakeOffer..try_accounts...
 *   Stack offset of 4120 exceeded max offset of 4096 by 24 bytes,
 *   please minimize large stack variables.
 *   Estimated function frame size: 4352 bytes.
 *
 * At runtime the linked .so panics with:
 *
 *   Program log: Instruction: TakeOffer
 *   Program ... failed: Access violation in stack frame 5
 *   at address 0x200005ff0 of size 8
 *
 * — before any handler logic runs. make_offer's 9-field struct fits;
 * take_offer's 12-field struct does not.
 *
 * Boxing the InterfaceAccount fields in upstream source (`Box<...>`)
 * would resolve it, but modifying upstream defeats the byte-equal-
 * against-real-source guarantee that makes this fixture credible.
 *
 * NOTEWORTHY FINDING ────────────────────────────────────────────────
 *
 * The Anvil-emitted Pinocchio .so for the SAME source runs take_offer
 * end-to-end without overflowing. Verified standalone (not via this
 * differential — the harness pairs the two .so files and Anchor's
 * reference fails first). The Anvil emit doesn't materialize the
 * full struct of validated accounts on the stack at the validation
 * stage; the Pinocchio CPI path is lighter.
 *
 * Two paths forward when this skip is revisited:
 *   1. Wait for upstream to Box the accounts (recommended fix; see
 *      Anchor docs §"Common Errors → Stack offset exceeded").
 *   2. Substitute refund_offer (7 accounts, also exercises
 *      transfer_tokens Some-branch + close_token_account) as the
 *      take-side coverage. Same emit code-path, fits in SBF stack.
 *
 * The fixture exports (setupTakeOffer, callTakeOffer,
 * takeOfferAccountsToCompare) remain live in
 * fixtures/anchor-escrow-2025-fixture.ts — once the upstream blocker
 * lifts, this file flips back to `defineDifferential(...)` with no
 * other change.
 */
import { describe, test } from "bun:test";

describe.skip("Anchor vs Anvil-Pinocchio runtime correctness (anchor-escrow-2025-take-offer)", () => {
  test.skip(
    "blocked on upstream Anchor 0.32 stack overflow — see file header",
    () => {
      // Re-enable: flip describe.skip → describe and re-add the
      // defineDifferential(...) call. The fixture exports are ready
      // (setupTakeOffer/callTakeOffer/takeOfferAccountsToCompare in
      // fixtures/anchor-escrow-2025-fixture.ts).
    },
  );
});

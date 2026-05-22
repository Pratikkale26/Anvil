/**
 * program-examples anchor-realloc differential — byte-equality on the
 * `update` instruction, which exercises Anchor's realloc constraint
 * family in full (`realloc = ...`, `realloc::payer`, `realloc::zero`).
 *
 * Intended scenario:
 *   1. initialize("hi")          — fresh-keypair init, account = 14 bytes
 *   2. update("hello, anvil")    — realloc-up to 24 bytes, zero-fill,
 *                                  pay rent delta from payer, overwrite
 *                                  the String field
 *
 * SKIPPED — two Anvil emit bugs surfaced by this fixture (2026-05-22)
 * ─────────────────────────────────────────────────────────────────────
 *
 * The harness builds both .so files cleanly. The Anvil-emitted .so
 * fails the FIRST instruction (initialize) with
 * `invalid account data for instruction` (ProgramError::InvalidAccountData,
 * custom 0x0) before update / realloc is ever reached. Root cause is in
 * the emitted state.rs + instructions/update.rs:
 *
 * BUG 1 — variable-length account types treated as fixed-LEN
 *   The source's `Message::required_space(input_len)` returns
 *   `8 + 4 + input_len` (Anchor's standard variable-length pattern).
 *   The Anvil emit hardcodes `Message::LEN = 64` (and TOTAL_LEN = 72)
 *   in state.rs, then Message::write() rejects any account smaller than
 *   TOTAL_LEN:
 *     if data.len() < Self::TOTAL_LEN { return Err(InvalidAccountData); }
 *   For initialize("hi"), the account is allocated at 14 bytes per the
 *   source's space expression, then write() guards against `< 72` and
 *   short-circuits. Every variable-length init in any Anchor program
 *   sits on this guard.
 *
 * BUG 2 — `realloc::zero = true` constraint dropped
 *   instructions/update.rs emits `message_account.realloc(__new_size, false)`
 *   verbatim regardless of whether the source's realloc::zero constraint
 *   says true or false. The `false` flag means "don't zero new bytes" —
 *   so even after BUG 1 is fixed, update() would diverge from Anchor's
 *   reference (which DOES zero new tail bytes per the realloc::zero
 *   constraint) by leaving uninitialized data in the realloc'd tail.
 *
 * NOTEWORTHY ─────────────────────────────────────────────────────────
 *
 * Both bugs are silent under coral-realloc (the sibling fixture):
 *   - coral-realloc uses a 1-byte Vec<u8> + bump (TOTAL_LEN matches
 *     the source's `Sample::space(1)` by coincidence, dodging BUG 1).
 *   - coral-realloc only calls `initialize`, never realloc (dodges BUG 2).
 *
 * This fixture is the first to exercise both surfaces simultaneously.
 * The bugs presumably also affect any program-examples / coral fixture
 * that does init-with-variable-length-input OR realloc-with-zero=true,
 * so the impact class is broader than this one test.
 *
 * REVIVE STEPS ───────────────────────────────────────────────────────
 *
 * Once both bugs are fixed (state.rs emit threads a runtime-size guard
 * instead of a const LEN comparison; update.rs threads the source's
 * realloc::zero flag), flip `describe.skip` → `describe` below.
 * Everything else (fixture exports, callScript, account compare) is
 * ready to go.
 *
 * Source: github.com/solana-developers/program-examples
 *   (basics/realloc/anchor/programs/anchor-realloc).
 */
import { describe, test } from "bun:test";

describe.skip("Anchor vs Anvil runtime correctness (program-examples-anchor-realloc)", () => {
  test.skip(
    "blocked on Anvil emit bugs (variable-length LEN + realloc::zero) — see file header",
    () => {
      // Re-enable: flip both describe.skip and test.skip back to
      // describe / test, then replace this stub body with:
      //
      //   import { defineDifferential } from "./differential-harness.ts";
      //   import {
      //     LIB_RS, PROGRAM_ID, ensureRepoCloned, loadAnchorSource,
      //     setupAnchorRealloc, callAnchorReallocFlow,
      //     anchorReallocAccountsToCompare,
      //   } from "./fixtures/program-examples-anchor-realloc-fixture.ts";
      //   ensureRepoCloned();
      //   defineDifferential({
      //     fixtureName: "program-examples-anchor-realloc",
      //     programIdBase58: PROGRAM_ID,
      //     anchorSource: loadAnchorSource(),
      //     anchorPackageName: "anchor_realloc_external_diff",
      //     anchorVersionOverride: "0.32",
      //     anvilTarget: "native",
      //     setup: setupAnchorRealloc,
      //     callScript: callAnchorReallocFlow,
      //     accountsToCompare: anchorReallocAccountsToCompare,
      //   });
      //
      // (Pinocchio target also fails — `anvilTarget: "native"` is
      // the right pick once the bugs are fixed because Pinocchio's
      // stable AccountInfo doesn't expose realloc; see
      // differential-harness.ts:281-286.)
    },
  );
});

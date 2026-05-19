/**
 * Pyth oracle differential — DEFERRED, blocked on M2c harness (write-
 * back state + synthetic PriceUpdate setup helper).
 *
 * Update 2026-05-19: the original blocker — "Anvil has no typed IR
 * kind for Pyth reads" — is closed. The full Pyth oracle arc shipped
 * across 10 commits (M2a → M2b → N5 → N5b → N5c). Both legacy
 * (pyth_sdk_solana) and modern (pyth_solana_receiver_sdk
 * PriceUpdateV2) reads are typed (cpi_pyth_read_price_{legacy,modern})
 * and emit compile-clean target code via hand-rolled byte
 * deserialization. The pyth_feed_id_literal IR kind inlines
 * get_feed_id_from_hex calls at parse time.
 *
 * What's locked already:
 *   - cargo-compile-pyth.test.ts — all 4 (demo × target) builds OK
 *   - pyth-byte-offsets.test.ts — TS re-reads using the SAME offsets
 *     as the Pinocchio emit, locks byte-layout contract
 *   - litesvm-aux-programs.test.ts — Pyth Receiver .so fixture loads
 *     into LiteSVM via addProgram
 *
 * What this differential WOULD add (the M2c arc):
 *   - A pyth demo with a write-back state account so the post-read
 *     state is comparable.
 *   - A TS helper that synthesizes PriceUpdateV2 bytes (the building
 *     blocks are in pyth-byte-offsets.test.ts as `buildModernPriceUpdate`).
 *   - svm.setAccount() install the synthetic PriceUpdate, then run
 *     the scenario with BOTH Anchor reference and Anvil emit, then
 *     byte-compare the post-read state account.
 *
 * Caveat blocking the differential gate (NOT M2c, separate issue):
 *   - Anchor reference build of pyth_solana_receiver_sdk hits the
 *     same borsh-derive proc-macro issue Anvil sidestepped via the
 *     hand-rolled emit. Until the receiver-sdk fixes its Cargo.toml
 *     to declare `borsh` as a direct dep, Anchor itself can't build
 *     a pyth-modern reference — meaning we can compare Anvil emit
 *     against Anvil emit, but not against Anchor. Track upstream:
 *     https://github.com/pyth-network/pyth-crosschain/issues
 *
 * When unblocked, replace the `describe.skip` body with a real
 * `defineDifferential({...})` call — same shape as
 * `differential-staking.test.ts`.
 */
import { describe, test } from "bun:test";

describe.skip("Anchor vs Anvil-Pinocchio runtime correctness (oracle-pyth) [DEFERRED — M2c harness]", () => {
  test.skip("see file header for the path to enable", () => {});
});

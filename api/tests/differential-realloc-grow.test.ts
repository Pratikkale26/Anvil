/**
 * realloc grow differential — DEFERRED STUB.
 *
 * Goal: byte-equal compare across Anchor + Anvil-Pinocchio for the
 * `realloc = expr` constraint family — re-allocate the account's data
 * buffer, transfer/refund rent delta, optionally zero-fill the grown
 * region.
 *
 * Status: scaffolded but blocked on the same issue as the existing
 * differential-realloc.test.ts deferred stub — Anchor's `init` with a
 * `Vec<u8>`-bearing state account hits `InvalidAccountData` at runtime
 * even with a deterministic PDA and explicit `space = N` matching the
 * post-init serialized size. The pre-existing stub's notes flagged the
 * same path: "may need explicit Rent sysvar in the Accounts struct,
 * or `space = 24 + ...` to satisfy Anchor's `size_of::<T>()` check
 * separate from the borsh-serialized size."
 *
 * What ships in this commit instead: the walker-side fix for
 * `<state>.<field>.push(byte)` (and other Vec/HashMap mutating
 * methods) — that path used to emit `let log = ...` instead of
 * `let mut log = ...` and trip E0596 on cargo build. The deterministic
 * cargo-build coverage (realworld-cargo.test.ts) catches the compile
 * regression. The runtime byte-equal compare is the missing layer.
 *
 * To enable this fixture (estimated 4-6 hours):
 *   1. Add a Rent sysvar to the Open accounts struct + pass the rent
 *      sysvar pubkey in the test's TransactionInstruction.
 *   2. Try `space = 8 + std::mem::size_of::<Log>() + 4 + 1` (size_of
 *      reserves the Vec's pointer/len/cap struct, then realloc handles
 *      the data side).
 *   3. If that still fails, bisect against a hand-written non-Anvil
 *      Anchor 0.31 program that succeeds, and copy the working pattern.
 *
 * Tracking this here so the next pass picks it up rather than
 * re-discovering the gap. A new fixture filename
 * (differential-realloc-grow vs differential-realloc) keeps the two
 * deferred contexts distinct: -realloc tracks the rent-delta variant,
 * -realloc-grow tracks the Vec<u8>-grow-on-push variant.
 */
import { describe, test } from "bun:test";

describe.skip("Anchor vs Anvil-Pinocchio runtime correctness (realloc-grow) [DEFERRED — Anchor init layout]", () => {
  test.skip("see file header for the path to enable", () => {});
});

/**
 * A3 regression — `programIdBase58` is folded into the source-hash cache
 * key, AND the source's `declare_id!()` is rewritten to match before
 * building. Without both, two requests sharing a program's source but
 * targeting different deploy addresses got the same cached .so → Anchor's
 * `Account<'info, T>` owner check fired on the second run with a
 * misleading `ConstraintOwner` error.
 *
 * We don't shell out cargo here -- this is a pure unit test of the source-
 * rewrite + key-stability invariants. The full end-to-end is covered by
 * the differential fixture suite when the toolchain is present.
 */
import { describe, test, expect } from "bun:test";
import { rewriteDeclareIdForTest } from "../src/build/differential-build.ts";
import { decodeBase58 } from "../src/parser/project-source.ts";

const SAMPLE_ANCHOR = `
use anchor_lang::prelude::*;
declare_id!("11111111111111111111111111111111");

#[program]
pub mod foo {}
`;

const SAMPLE_PINOCCHIO = `
pinocchio_pubkey::declare_id!("11111111111111111111111111111111");
`;

const SAMPLE_NATIVE = `
use solana_program::pubkey::Pubkey;
use solana_program::pubkey;
pub const ID: Pubkey = pubkey!("11111111111111111111111111111111");
`;

// The shapes Anvil's G19 emit ACTUALLY produces for the program-id const —
// a raw byte-array literal, not a declare_id!/pubkey! string. Pinocchio emits
// a bare `[u8; 32]`; Native wraps it in `Pubkey::new_from_array`. Before the
// byte-array rewrite these slipped past rewriteDeclareId, so a deploy-id
// override never reached the emit and the #35 entry guard reverted every init
// on the Anvil side with IncorrectProgramId (spurious byte-divergence).
const ID_BYTES_ORIG =
  "1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1";
const SAMPLE_PINOCCHIO_CONST = `pub const ID: Pubkey = [${ID_BYTES_ORIG}];`;
const SAMPLE_NATIVE_CONST = `pub const ID: Pubkey = Pubkey::new_from_array([${ID_BYTES_ORIG}]);`;

const NEW_ID = "Counter111111111111111111111111111111111111";

describe("rewriteDeclareId: Anchor / Pinocchio / Native shapes", () => {
  test("Anchor declare_id! rewritten", () => {
    const out = rewriteDeclareIdForTest(SAMPLE_ANCHOR, NEW_ID);
    expect(out).toContain(`declare_id!("${NEW_ID}")`);
    expect(out).not.toContain('"11111111111111111111111111111111"');
  });

  test("Pinocchio declare_id! rewritten", () => {
    const out = rewriteDeclareIdForTest(SAMPLE_PINOCCHIO, NEW_ID);
    expect(out).toContain(`declare_id!("${NEW_ID}")`);
  });

  test("Native pubkey!() rewritten", () => {
    const out = rewriteDeclareIdForTest(SAMPLE_NATIVE, NEW_ID);
    expect(out).toContain(`pubkey!("${NEW_ID}")`);
    expect(out).not.toContain('pubkey!("11111111111111111111111111111111")');
  });

  test("Anvil G19 Pinocchio byte-array ID const rewritten to override bytes", () => {
    const expected = `[${decodeBase58(NEW_ID)!.join(", ")}]`;
    const out = rewriteDeclareIdForTest(SAMPLE_PINOCCHIO_CONST, NEW_ID);
    expect(out).toContain(expected);
    expect(out).not.toContain(ID_BYTES_ORIG);
  });

  test("Anvil G19 Native new_from_array byte-array ID const rewritten", () => {
    const expected = `new_from_array([${decodeBase58(NEW_ID)!.join(", ")}])`;
    const out = rewriteDeclareIdForTest(SAMPLE_NATIVE_CONST, NEW_ID);
    expect(out).toContain(expected);
    expect(out).not.toContain(ID_BYTES_ORIG);
  });

  test("byte-array rewrite does NOT touch a `[0u8; 32]` stub const", () => {
    // emitter-base-utils emits zeroed Pubkey stubs like `[0u8; 32]`; the byte
    // rewrite must only fire on a comma-separated numeric literal, never on a
    // repeat-expression, or it would corrupt those stubs.
    const stub = `pub const FEED: Pubkey = Pubkey::new_from_array([0u8; 32]);`;
    expect(rewriteDeclareIdForTest(stub, NEW_ID)).toBe(stub);
  });

  test("undefined programIdBase58 is a no-op", () => {
    expect(rewriteDeclareIdForTest(SAMPLE_ANCHOR, undefined)).toBe(SAMPLE_ANCHOR);
  });

  test("source with no declare_id is returned unchanged", () => {
    const noDeclare = "pub fn foo() {}";
    expect(rewriteDeclareIdForTest(noDeclare, NEW_ID)).toBe(noDeclare);
  });

  test("idempotent: rewriting the same target ID twice yields the same result", () => {
    const once = rewriteDeclareIdForTest(SAMPLE_ANCHOR, NEW_ID);
    const twice = rewriteDeclareIdForTest(once, NEW_ID);
    expect(twice).toBe(once);
  });
});

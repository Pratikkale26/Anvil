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

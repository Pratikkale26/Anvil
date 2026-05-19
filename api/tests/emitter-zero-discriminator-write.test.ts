/**
 * task #43 — `#[account(zero)]` discriminator-write in Pinocchio + Native emit.
 *
 * Pre-fix: an Anchor program using `#[account(zero)]` would deploy to a
 * real validator and the FIRST instruction would succeed, but subsequent
 * instructions that re-read the account through `Type::from_account_info`
 * failed with InvalidAccountData — Anvil's emit never wrote
 * `Type::DISCRIMINATOR` into the first 8 bytes, leaving them as the zeros
 * the caller supplied.
 *
 * Surfaced by diff-arc Phase C 2026-05-19 on Anchor's composite example.
 * After Phase C's initialize() ran on both sides:
 *   Anchor dummyA: f8ca38c22234a46f0000000000000000  (DummyA::DISCRIMINATOR + zeros)
 *   Anvil  dummyA: 00000000000000000000000000000000  (no disc written)
 * composite_update on Anvil then refused: "invalid account data".
 *
 * Post-fix: emitInitAccountPrelude includes a `zero` constraint branch
 * that calls emitZeroAccountDiscriminatorWrite — a guarded write that only
 * fires when the existing 8 bytes are zero (matches Anchor's precondition).
 *
 * Lock the contract: an emit produced for a source with `#[account(zero)]`
 * MUST include the discriminator-write code in the handler body.
 */
import { describe, test, expect } from "bun:test";
import { parseAnchor } from "../src/parser/anchor-parser.ts";
import { emitPinocchioFull } from "../src/emitter/pinocchio-emitter.ts";
import { emitNativeFull } from "../src/emitter/native-emitter.ts";

const COMPOSITE_SOURCE = `
use anchor_lang::prelude::*;
declare_id!("11111111111111111111111111111111");

#[program]
mod composite {
    use super::*;
    pub fn initialize(_ctx: Context<Initialize>) -> Result<()> { Ok(()) }
}

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(zero)]
    pub dummy_a: Account<'info, DummyA>,
    #[account(zero)]
    pub dummy_b: Account<'info, DummyB>,
}

#[account]
pub struct DummyA { pub data: u64 }

#[account]
pub struct DummyB { pub data: u64 }
`;

const NON_ZERO_SOURCE = `
use anchor_lang::prelude::*;
declare_id!("11111111111111111111111111111111");

#[program]
mod plain {
    use super::*;
    pub fn do_stuff(_ctx: Context<Plain>) -> Result<()> { Ok(()) }
}

#[derive(Accounts)]
pub struct Plain<'info> {
    #[account(mut)]
    pub state: Account<'info, MyState>,
}

#[account]
pub struct MyState { pub data: u64 }
`;

describe("task #43 — Pinocchio emit writes Type::DISCRIMINATOR for #[account(zero)]", () => {
  test("composite initialize handler writes both DummyA + DummyB discriminators", async () => {
    const parsed = await parseAnchor(COMPOSITE_SOURCE);
    if (!parsed.ok) throw new Error("parse: " + parsed.error);
    const emit = emitPinocchioFull(parsed.ir);
    const lib = (emit.files ?? []).map((f) => f.content).join("\n") || emit.code || "";
    expect(lib).toContain("DummyA::DISCRIMINATOR");
    expect(lib).toContain("DummyB::DISCRIMINATOR");
    // Guard: only write when first 8 bytes are zero
    expect(lib).toMatch(/__zero_data\[\.\.8\]\.iter\(\)\.all\(\|&b\| b == 0\)/);
    // Pinocchio uses borrow_mut_data_unchecked
    expect(lib).toContain("borrow_mut_data_unchecked");
  });

  test("non-zero account (just #[account(mut)]) does NOT trigger the write", async () => {
    const parsed = await parseAnchor(NON_ZERO_SOURCE);
    if (!parsed.ok) throw new Error("parse: " + parsed.error);
    const emit = emitPinocchioFull(parsed.ir);
    const lib = (emit.files ?? []).map((f) => f.content).join("\n") || emit.code || "";
    // mut-only accounts get no prelude disc write
    expect(lib).not.toContain("#[account(zero)]: write");
  });

  test("disc-write block carries the comment marker so the user can locate it", async () => {
    const parsed = await parseAnchor(COMPOSITE_SOURCE);
    if (!parsed.ok) throw new Error("parse: " + parsed.error);
    const emit = emitPinocchioFull(parsed.ir);
    const lib = (emit.files ?? []).map((f) => f.content).join("\n") || emit.code || "";
    expect(lib).toContain("#[account(zero)]: write DummyA::DISCRIMINATOR");
    expect(lib).toContain("#[account(zero)]: write DummyB::DISCRIMINATOR");
  });
});

describe("task #43 — Native emit writes Type::DISCRIMINATOR for #[account(zero)]", () => {
  test("Native composite emit also writes the disc, via data.borrow_mut()", async () => {
    const parsed = await parseAnchor(COMPOSITE_SOURCE);
    if (!parsed.ok) throw new Error("parse: " + parsed.error);
    const emit = emitNativeFull(parsed.ir);
    const lib = (emit.files ?? []).map((f) => f.content).join("\n") || emit.code || "";
    expect(lib).toContain("DummyA::DISCRIMINATOR");
    expect(lib).toContain("DummyB::DISCRIMINATOR");
    expect(lib).toContain("data.borrow_mut()");
    // Guard remains
    expect(lib).toMatch(/__zero_data\[\.\.8\]\.iter\(\)\.all\(\|&b\| b == 0\)/);
  });
});

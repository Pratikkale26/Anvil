/**
 * #21 / H1 — Composite #[derive(Accounts)] struct fields.
 *
 * Anchor flattens nested Accounts structs at IDL generation: the inner
 * struct's fields become slots in the outer struct's account list. Pre-H1
 * Anvil refused this shape with the composite_accounts_field validator
 * error so users got a clear pre-emit failure instead of a cryptic post-
 * cargo E0609 ("no field X on type AccountInfo").
 *
 * Post-H1 (2026-05-19): parseAccountsStructFields now flattens composites
 * directly. The validator error retires for the cases the parser can
 * handle; this test pivots from "validator refuses" to "parser produces
 * a flat account list + body chains resolve":
 *
 *   accounts: [foo_dummy_a, bar_dummy_b]
 *   body: `ctx.accounts.foo.dummy_a` → rewritten to `ctx.accounts.foo_dummy_a`
 *
 * Cycle detection + multi-level recursion live in
 * parser-composite-flatten.test.ts. This file holds the end-to-end shape:
 * a real composite Anchor program produces an emit-validatable IR.
 */
import { describe, test, expect } from "bun:test";
import { parseAnchor } from "../src/parser/anchor-parser.js";
import { emitPinocchioFull } from "../src/emitter/pinocchio-emitter.js";
import { validateEmitterOutput } from "../src/emitter/output-validator.js";

const COMPOSITE_SOURCE = `
use anchor_lang::prelude::*;

declare_id!("EHthziFziNoac9LBGxEaVN47Y3uUiRoXvqAiR6oes4iU");

#[program]
mod composite_min {
    use super::*;
    pub fn composite_update(
        ctx: Context<CompositeUpdate>,
        dummy_a: u64,
    ) -> Result<()> {
        let a = &mut ctx.accounts.foo.dummy_a;
        a.data = dummy_a;
        Ok(())
    }
}

#[derive(Accounts)]
pub struct CompositeUpdate<'info> {
    foo: Foo<'info>,
    bar: Bar<'info>,
}

#[derive(Accounts)]
pub struct Foo<'info> {
    #[account(mut)]
    pub dummy_a: Account<'info, DummyA>,
}

#[derive(Accounts)]
pub struct Bar<'info> {
    #[account(mut)]
    pub dummy_b: Account<'info, DummyB>,
}

#[account]
pub struct DummyA {
    pub data: u64,
}

#[account]
pub struct DummyB {
    pub data: u64,
}
`;

describe("Composite #[derive(Accounts)] (#21 / H1)", () => {
  test("composite fields flatten into the outer accounts list", async () => {
    const parsed = await parseAnchor(COMPOSITE_SOURCE);
    if (!parsed.ok) throw new Error(`parse failed: ${parsed.error}`);

    // Pre-H1 there was 1 slot per composite ("foo", "bar"); post-H1 they
    // expand to "<outer>_<inner>" leaf names.
    const ix = parsed.ir.instructions.find((i) => i.name === "composite_update");
    expect(ix).toBeDefined();
    const accountNames = ix!.accounts.map((a) => a.name);
    expect(accountNames).toEqual(["foo_dummy_a", "bar_dummy_b"]);
  });

  test("composite_accounts_field validator error no longer fires", async () => {
    const parsed = await parseAnchor(COMPOSITE_SOURCE);
    if (!parsed.ok) throw new Error(`parse failed: ${parsed.error}`);
    const emit = emitPinocchioFull(parsed.ir);
    const issues = validateEmitterOutput(parsed.ir, emit);
    const compositeError = issues.find(
      (e) =>
        e.severity === "error"
        && (/composite.*Accounts/i.test(e.message)
          || /nested.*Accounts/i.test(e.message)
          || /Accounts struct field/i.test(e.message)),
    );
    expect(compositeError).toBeUndefined();
  });

  test("normal (non-composite) Accounts struct does NOT trigger the error", async () => {
    const normal = `
use anchor_lang::prelude::*;
declare_id!("EHthziFziNoac9LBGxEaVN47Y3uUiRoXvqAiR6oes4iU");
#[program]
mod normal {
    use super::*;
    pub fn ix(_ctx: Context<Plain>) -> Result<()> { Ok(()) }
}
#[derive(Accounts)]
pub struct Plain<'info> {
    #[account(mut)]
    pub a: Account<'info, A>,
    pub signer: Signer<'info>,
}
#[account]
pub struct A { pub x: u64 }
`;
    const parsed = await parseAnchor(normal);
    if (!parsed.ok) throw new Error(`parse failed: ${parsed.error}`);
    const emit = emitPinocchioFull(parsed.ir);
    const issues = validateEmitterOutput(parsed.ir, emit);
    const errors = issues.filter((i) => i.severity === "error");
    const compositeError = errors.find(
      (e) =>
        /composite.*Accounts/i.test(e.message)
        || /nested.*Accounts/i.test(e.message)
        || /Accounts struct field/i.test(e.message),
    );
    expect(compositeError).toBeUndefined();
  });
});

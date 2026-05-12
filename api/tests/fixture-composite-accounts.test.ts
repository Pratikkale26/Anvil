/**
 * Regression for #21 — Composite #[derive(Accounts)] struct fields.
 *
 * Surfaced by the 2026-05-12 real-world sweep (anchor/tests/composite):
 *
 *   #[derive(Accounts)]
 *   pub struct CompositeUpdate<'info> {
 *       foo: Foo<'info>,    // ← another #[derive(Accounts)] struct
 *       bar: Bar<'info>,    // ← another #[derive(Accounts)] struct
 *   }
 *
 * Source: ctx.accounts.foo.dummy_a — Anchor flattens at IDL gen so the
 * nested struct's accounts join the parent's account list.
 *
 * Pre-fix: parser treats `foo: Foo<'info>` as a regular AccountInfo
 * field, validator passes, cargo refuses with E0609 "no field dummy_a
 * on type &pinocchio::account_info::AccountInfo".
 *
 * Until the parser learns to flatten nested Accounts, the validator
 * MUST refuse this shape so users see a clear error pre-emit instead
 * of a cryptic E0609 post-cargo.
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

describe("Composite #[derive(Accounts)] regression (#21)", () => {
  test("validator surfaces an error for composite Accounts field", async () => {
    const parsed = await parseAnchor(COMPOSITE_SOURCE);
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
    expect(compositeError).toBeDefined();
    // Should name the offending field or the parent struct.
    expect(compositeError!.message).toMatch(/foo|bar|Foo|Bar|CompositeUpdate/);
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

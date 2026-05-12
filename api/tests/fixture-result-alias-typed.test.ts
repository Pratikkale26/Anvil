/**
 * Regression for #20 — Anchor `Result<T>` typed instruction return.
 *
 * Surfaced by the 2026-05-12 real-world sweep (anchor-cpi-test / callee):
 * source declares `pub fn return_u64(_ctx) -> Result<u64>` with `Ok(10)`
 * tail. Emit drops the typed-T (no set_return_data wiring) and appends
 * its own `Ok(())` tail, producing:
 *
 *   Ok(10);    // discarded statement — E cannot be inferred
 *   Ok(())     // unit return tail
 *
 * which cargo refuses with E0282 "type annotations needed: cannot infer
 * type of the type parameter E declared on the enum Result".
 *
 * The validator marked this CLEAN. This test locks the new shape:
 * either the emit becomes cargo-green (with set_return_data wiring), OR
 * the validator refuses with a specific error pointing the user toward
 * explicit set_return_data (the supported path per
 * api/src/demo-programs/return-data.rs:8-12).
 */
import { describe, test, expect } from "bun:test";
import { parseAnchor } from "../src/parser/anchor-parser.js";
import { emitPinocchioFull } from "../src/emitter/pinocchio-emitter.js";
import { emitNativeFull } from "../src/emitter/native-emitter.js";
import { validateEmitterOutput } from "../src/emitter/output-validator.js";

const SOURCE = `
use anchor_lang::prelude::*;

declare_id!("Fg6PaFpoGXkYsidMpWTK6W2BeZ7FEfcYkg476zPFsLnS");

#[program]
pub mod callee_min {
    use super::*;

    pub fn return_unit(_ctx: Context<NoAccounts>) -> Result<()> {
        Ok(())
    }

    pub fn return_u64(_ctx: Context<NoAccounts>) -> Result<u64> {
        Ok(10)
    }

    pub fn return_vec(_ctx: Context<NoAccounts>) -> Result<Vec<u8>> {
        Ok(vec![1, 2, 3])
    }
}

#[derive(Accounts)]
pub struct NoAccounts<'info> {
    pub signer: Signer<'info>,
}
`;

describe("Result<T> typed-return regression (#20)", () => {
  test("validator surfaces an error for typed Result<T> instruction (pinocchio)", async () => {
    const parsed = await parseAnchor(SOURCE);
    if (!parsed.ok) throw new Error(`parse failed: ${parsed.error}`);

    const emit = emitPinocchioFull(parsed.ir);
    const issues = validateEmitterOutput(parsed.ir, emit);
    const errors = issues.filter((i) => i.severity === "error");

    const typedReturnError = errors.find(
      (e) =>
        /typed Result<.+>/i.test(e.message)
        || /set_return_data/i.test(e.message)
        || /unsupported return type/i.test(e.message),
    );
    expect(typedReturnError).toBeDefined();
    // Should flag the specific non-unit instructions, not return_unit.
    expect(typedReturnError!.message).toMatch(/return_u64|return_vec/);
  });

  test("validator surfaces an error for typed Result<T> instruction (native)", async () => {
    const parsed = await parseAnchor(SOURCE);
    if (!parsed.ok) throw new Error(`parse failed: ${parsed.error}`);

    const emit = emitNativeFull(parsed.ir);
    const issues = validateEmitterOutput(parsed.ir, emit);
    const errors = issues.filter((i) => i.severity === "error");

    const typedReturnError = errors.find(
      (e) =>
        /typed Result<.+>/i.test(e.message)
        || /set_return_data/i.test(e.message)
        || /unsupported return type/i.test(e.message),
    );
    expect(typedReturnError).toBeDefined();
  });

  test("Result<()> instruction does NOT trigger the error", async () => {
    const unitOnly = `
use anchor_lang::prelude::*;
declare_id!("Fg6PaFpoGXkYsidMpWTK6W2BeZ7FEfcYkg476zPFsLnS");
#[program]
pub mod unit_only {
    use super::*;
    pub fn ix(_ctx: Context<NoAccounts>) -> Result<()> {
        Ok(())
    }
}
#[derive(Accounts)]
pub struct NoAccounts<'info> {
    pub signer: Signer<'info>,
}
`;
    const parsed = await parseAnchor(unitOnly);
    if (!parsed.ok) throw new Error(`parse failed: ${parsed.error}`);
    const emit = emitPinocchioFull(parsed.ir);
    const issues = validateEmitterOutput(parsed.ir, emit);
    const errors = issues.filter((i) => i.severity === "error");
    const typedReturnError = errors.find(
      (e) =>
        /typed Result<.+>/i.test(e.message)
        || /set_return_data/i.test(e.message)
        || /unsupported return type/i.test(e.message),
    );
    expect(typedReturnError).toBeUndefined();
  });
});

/**
 * Regression for #20 — Anchor `Result<T>` typed instruction return.
 *
 * Surfaced by the 2026-05-12 real-world sweep (anchor-cpi-test / callee):
 * source declares `pub fn return_u64(_ctx) -> Result<u64>` with `Ok(10)`
 * tail. Anchor's #[program] macro expands this to
 * `set_return_data(&borsh::to_vec(&10)?); Ok(())`.
 *
 * Earlier Anvil refused these loudly (uniform `-> ProgramResult` router can't
 * carry T). Now a single-tail `Ok(<expr>)` getter is WIRED: the emit publishes
 * the value via set_return_data — byte-identical to the macro by delegation
 * (same value, same Borsh path). This test locks the wiring at the parse+emit
 * layer; differential-typed-result-return.test.ts proves byte-equality end-to-
 * end against a real Anchor reference build.
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

function isTypedReturnError(message: string): boolean {
  return (
    /typed Result<.+>/i.test(message)
    || /unsupported return type/i.test(message)
    || /non-unit Result/i.test(message)
  );
}

// emit*Full returns { singleFile, files, warnings, ... }; the single-file
// rendering carries every instruction body for string assertions.
function code(out: unknown): string {
  return typeof out === "string" ? out : (out as { singleFile: string }).singleFile;
}

describe("Result<T> typed-return wiring (#20)", () => {
  for (const [target, emit] of [
    ["pinocchio", emitPinocchioFull],
    ["native", emitNativeFull],
  ] as const) {
    test(`typed Result<T> getter is wired to set_return_data, not refused (${target})`, async () => {
      const parsed = await parseAnchor(SOURCE);
      if (!parsed.ok) throw new Error(`parse failed: ${parsed.error}`);

      const out = emit(parsed.ir);
      const issues = validateEmitterOutput(parsed.ir, out);
      const errors = issues.filter((i) => i.severity === "error");
      const src = code(out);

      // No longer a loud refusal — the getters are wired.
      expect(errors.find((e) => isTypedReturnError(e.message))).toBeUndefined();
      // And no stale unimplemented!() stub for the now-supported shape.
      expect(src).not.toMatch(/unimplemented!\("[Aa]nvil: non-unit Result/);

      // Both non-unit getters publish their value via set_return_data, with the
      // value delegated to borsh::to_vec under a turbofish that pins the type to
      // the declared inner T (byte-identical to Anchor's macro — without the
      // turbofish, `10` would default to i32 / the vec to Vec<i32>).
      expect(src).toMatch(/set_return_data\(&borsh::to_vec::<u64>\(&\(10\)\)\.map_err\([^)]*\)\?\)/);
      expect(src).toMatch(/set_return_data\(&borsh::to_vec::<Vec<u8>>\(&\(vec!\[1, 2, 3\]\)\)\.map_err\([^)]*\)\?\)/);
    });
  }

  test("Result<()> (unit) instruction emits no set_return_data", async () => {
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
    const out = emitPinocchioFull(parsed.ir);
    const issues = validateEmitterOutput(parsed.ir, out);
    expect(issues.filter((i) => i.severity === "error").find((e) => isTypedReturnError(e.message))).toBeUndefined();
    expect(code(out)).not.toMatch(/set_return_data/);
  });
});

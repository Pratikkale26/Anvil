/**
 * H1/H2 / #35 — custom error codes must match Anchor's `discriminant + offset`
 * formula (anchor-syn codegen/error.rs + parser/error.rs).
 *
 * - offset defaults to ERROR_CODE_OFFSET (6000), overridden by
 *   #[error_code(offset = N)]
 * - discriminant follows Rust enum rules: explicit `= N` sets it, else
 *   previous + 1 (from 0)
 *
 * Anvil previously re-numbered every error `6000 + index`, dropping BOTH the
 * explicit discriminant and the offset.
 */
import { describe, test, expect } from "bun:test";
import { parseAnchor } from "../src/parser/anchor-parser.ts";

async function codes(errEnum: string): Promise<Record<string, number>> {
  const src = `
use anchor_lang::prelude::*;
declare_id!("Counter111111111111111111111111111111111111");
#[program] pub mod m { use super::*; pub fn go(ctx: Context<G>) -> Result<()> { Ok(()) } }
#[derive(Accounts)] pub struct G<'info> { pub signer: Signer<'info> }
${errEnum}
`;
  const r = await parseAnchor(src);
  expect(r.ok).toBe(true);
  if (!r.ok) throw new Error("parse failed");
  return Object.fromEntries(r.ir.errors.map((e) => [e.name, e.code]));
}

describe("H1/H2 — error code numbering", () => {
  test("default enum: 6000 + index (unchanged)", async () => {
    expect(await codes(`#[error_code] pub enum E { Alpha, Beta, Gamma }`)).toEqual({
      Alpha: 6000, Beta: 6001, Gamma: 6002,
    });
  });

  test("explicit discriminants → 6000 + discriminant (with auto-increment)", async () => {
    expect(await codes(`#[error_code] pub enum E { Frozen = 10, Locked = 50, Other }`)).toEqual({
      Frozen: 6010, Locked: 6050, Other: 6051,
    });
  });

  test("#[error_code(offset = N)] replaces the 6000 base", async () => {
    expect(await codes(`#[error_code(offset = 500)] pub enum E { Alpha, Beta }`)).toEqual({
      Alpha: 500, Beta: 501,
    });
  });

  test("offset + explicit discriminant combine", async () => {
    expect(await codes(`#[error_code(offset = 100)] pub enum E { A = 5, B }`)).toEqual({
      A: 105, B: 106,
    });
  });
});

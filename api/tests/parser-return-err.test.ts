/**
 * Regression test for the body-classifier dispatch added during M3.
 *
 * `return Err(...)` parses as expression_statement → return_expression.
 * The classifier's top-level switch had a `return_expression` case but
 * dispatched on the outer expression_statement first, routing to
 * classifyExpressionStatement which didn't handle return_expression —
 * the typed return_err / return_ok IR kinds were silently dropped to
 * pass_through. M3 added an explicit return_expression branch inside
 * classifyExpressionStatement; this test pins it.
 */
import { describe, test, expect } from "bun:test";
import { parseAnchor } from "../src/parser/anchor-parser.ts";

const SRC = `
use anchor_lang::prelude::*;

declare_id!("11111111111111111111111111111111");

#[program]
pub mod p {
    use super::*;
    pub fn fail(_ctx: Context<E>) -> Result<()> {
        return Err(MyError::Bad.into());
    }
    pub fn ok(_ctx: Context<E>) -> Result<()> {
        return Ok(());
    }
}

#[derive(Accounts)]
pub struct E<'info> {
    pub user: Signer<'info>,
}

#[error_code]
pub enum MyError {
    #[msg("bad")] Bad,
}
`;

describe("M3: return_expression dispatch", () => {
  test("return Err(...); produces return_err kind", async () => {
    const r = await parseAnchor(SRC);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const fail = r.ir.instructions.find((i) => i.name === "fail")!;
    expect(fail.body.some((s) => s.kind === "return_err")).toBe(true);
  });

  test("return Ok(()); produces return_ok kind", async () => {
    const r = await parseAnchor(SRC);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const ok = r.ir.instructions.find((i) => i.name === "ok")!;
    expect(ok.body.some((s) => s.kind === "return_ok")).toBe(true);
  });
});

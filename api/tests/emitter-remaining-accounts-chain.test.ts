/**
 * task #42 — `ctx.remaining_accounts.iter()` emit shape.
 *
 * Pre-fix: the structural rewriter substituted `ctx.remaining_accounts`
 * with `&accounts[N..]` unconditionally. When the rewrite landed in a
 * method-call chain (`ctx.remaining_accounts.iter()`), Rust's operator
 * precedence parsed `&accounts[N..].iter()` as `&(accounts[N..].iter())`
 * → `&std::slice::Iter<T>` which is NOT an iterator. Cargo refused with
 * "is not an iterator".
 *
 * Post-fix: when the parent of the field_expression is itself a method
 * or field chain, drop the leading `&`. Slice indexing on `&[T]` returns
 * the right shape for `.iter()` / `.len()` / `.is_empty()` etc.
 *
 * Standalone uses (e.g. passing the slice to a function) still get the
 * leading `&` since the consumer expects `&[AccountInfo]`.
 *
 * Surfaced by diff-arc Phase B 2026-05-19 on duplicate-mutable.
 */
import { describe, test, expect } from "bun:test";
import { parseAnchor } from "../src/parser/anchor-parser.ts";
import { emitPinocchioFull } from "../src/emitter/pinocchio-emitter.ts";

const PROGRAM = (body: string) => `
use anchor_lang::prelude::*;
declare_id!("11111111111111111111111111111111");

#[program]
mod p {
    use super::*;
    pub fn ix(ctx: Context<C>) -> Result<()> {
        ${body}
        Ok(())
    }
}

#[derive(Accounts)]
pub struct C<'info> {
    pub signer: Signer<'info>,
}
`;

async function emitFor(body: string): Promise<string> {
  const parsed = await parseAnchor(PROGRAM(body));
  if (!parsed.ok) throw new Error("parse: " + parsed.error);
  const emit = emitPinocchioFull(parsed.ir);
  return (emit.files ?? []).map((f) => f.content).join("\n") || emit.code || "";
}

describe("task #42 — ctx.remaining_accounts chain rewriting", () => {
  test(".iter() form: no leading & (would break iterator)", async () => {
    const code = await emitFor(`for x in ctx.remaining_accounts.iter() { let _ = x; }`);
    expect(code).toContain("accounts[1..].iter()");
    expect(code).not.toContain("&accounts[1..].iter()");
  });

  test(".len() form: no leading &", async () => {
    const code = await emitFor(`let n = ctx.remaining_accounts.len();`);
    expect(code).toContain("accounts[1..].len()");
    expect(code).not.toContain("&accounts[1..].len()");
  });

  test(".is_empty() form: no leading &", async () => {
    const code = await emitFor(`if ctx.remaining_accounts.is_empty() { return Ok(()); }`);
    expect(code).toContain("accounts[1..].is_empty()");
    expect(code).not.toContain("&accounts[1..].is_empty()");
  });

  test("bare slice reference (no chain): leading & preserved", async () => {
    const code = await emitFor(`fn aux(_: &[AccountInfo]) {} aux(ctx.remaining_accounts);`);
    expect(code).toContain("&accounts[1..]");
  });
});

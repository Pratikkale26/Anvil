/**
 * task #37 — `let X = ctx.accounts.Y.deref_mut(); *X = T { ... };`
 * rewrites to `ctx.accounts.Y.set_inner(T { ... });` which then
 * decomposes via the existing set_inner classifier to per-field
 * state_field_assign statements.
 *
 * Pre-fix the pattern survived as pass_through, validator flagged the
 * residual ctx.accounts.* references, and cargo refused with
 * "no method deref_mut" / "no field <X> on AccountInfo".
 *
 * Surfaced by diff-arc Phase B 2026-05-19 on anchor-tutorial-basic-4.
 */
import { describe, test, expect } from "bun:test";
import { rewriteDerefMutAssigns } from "../src/parser/ast-helpers.ts";
import { parseAnchor } from "../src/parser/anchor-parser.ts";

describe("task #37 — rewriteDerefMutAssigns (text-level helper)", () => {
  test("simple deref_mut + assignment rewrites to set_inner", () => {
    const body = `{
      let counter = ctx.accounts.counter.deref_mut();
      *counter = Counter { authority: payer.key(), count: 0 };
    }`;
    const out = rewriteDerefMutAssigns(body);
    expect(out).toContain("ctx.accounts.counter.set_inner(Counter {");
    expect(out).toContain("authority: payer.key()");
    expect(out).toContain("count: 0");
    expect(out).not.toContain("*counter =");
    expect(out).not.toContain("deref_mut()");
  });

  test("intermediate let-bindings between let and assign survive in place", () => {
    const body = `{
      let counter = ctx.accounts.counter.deref_mut();
      let bump = ctx.bumps.counter;
      *counter = Counter { authority: *ctx.accounts.authority.key, count: 0, bump };
    }`;
    const out = rewriteDerefMutAssigns(body);
    expect(out).toContain("let bump = ctx.bumps.counter;");
    expect(out).toContain("ctx.accounts.counter.set_inner(Counter {");
    expect(out).toContain("bump");
  });

  test("nested struct literals — brace balance honored", () => {
    const body = `{
      let s = ctx.accounts.state.deref_mut();
      *s = State { inner: Inner { x: 1, y: 2 }, name: "ok" };
    }`;
    const out = rewriteDerefMutAssigns(body);
    expect(out).toContain("ctx.accounts.state.set_inner(State {");
    // Inner block fields preserved
    expect(out).toContain("Inner { x: 1, y: 2 }");
    expect(out).toContain('name: "ok"');
  });

  test("unmatched let (no deref-assign) leaves source unchanged", () => {
    const body = `{
      let counter = ctx.accounts.counter.deref_mut();
      counter.count += 1;
    }`;
    const out = rewriteDerefMutAssigns(body);
    // The let-binding is dropped only when the deref-assign is found. Here
    // there's no `*counter = ... { ... };` so nothing rewrites.
    expect(out).toBe(body);
  });

  test("multiple deref_mut sites in same body all rewrite", () => {
    const body = `{
      let a = ctx.accounts.a.deref_mut();
      let b = ctx.accounts.b.deref_mut();
      *a = TypeA { x: 1 };
      *b = TypeB { y: 2 };
    }`;
    const out = rewriteDerefMutAssigns(body);
    expect(out).toContain("ctx.accounts.a.set_inner(TypeA {");
    expect(out).toContain("ctx.accounts.b.set_inner(TypeB {");
  });

  test("non-deref_mut bodies are untouched", () => {
    const body = `{ let x = 1; let y = x + 2; Ok(()) }`;
    const out = rewriteDerefMutAssigns(body);
    expect(out).toBe(body);
  });
});

describe("task #37 — end-to-end: basic-4 init body decomposes via set_inner pipeline", () => {
  const BASIC_4_SOURCE = `
use anchor_lang::prelude::*;
use std::ops::DerefMut;

declare_id!("11111111111111111111111111111111");

#[program]
pub mod basic_4 {
    use super::*;

    pub fn initialize(ctx: Context<Initialize>) -> Result<()> {
        let counter = ctx.accounts.counter.deref_mut();
        let bump = ctx.bumps.counter;
        *counter = Counter {
            authority: *ctx.accounts.authority.key,
            count: 0,
            bump,
        };
        Ok(())
    }
}

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(init, payer = authority, space = 8 + 32 + 8 + 1, seeds = [b"counter"], bump)]
    counter: Account<'info, Counter>,
    #[account(mut)]
    authority: Signer<'info>,
    system_program: Program<'info, System>,
}

#[account]
pub struct Counter {
    pub authority: Pubkey,
    pub count: u64,
    pub bump: u8,
}
`;

  test("initialize body has state_field_assign for authority/count/bump (no pass_through residue)", async () => {
    const parsed = await parseAnchor(BASIC_4_SOURCE);
    if (!parsed.ok) throw new Error("parse: " + parsed.error);
    const initialize = parsed.ir.instructions.find((i) => i.name === "initialize");
    expect(initialize).toBeDefined();
    const fields = initialize!.body
      .filter((s) => s.kind === "state_field_assign")
      .map((s) => (s as { field: string }).field);
    expect(fields).toContain("authority");
    expect(fields).toContain("count");
    expect(fields).toContain("bump");
    // No pass_through residue carrying *counter = or deref_mut
    const passThrough = initialize!.body.filter((s) => s.kind === "pass_through");
    for (const pt of passThrough) {
      expect((pt as { code: string }).code).not.toContain("deref_mut");
      expect((pt as { code: string }).code).not.toContain("*counter =");
    }
  });
});

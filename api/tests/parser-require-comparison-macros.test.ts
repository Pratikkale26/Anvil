/**
 * task #38 — require_keys_eq! / require_eq! / require_neq! / require_gt!
 * / require_gte! / require_keys_neq! comparison-shorthand macros.
 *
 * Anchor's `require!(cond, err)` has a family of comparison-flavored
 * shortcuts that all decompose to a boolean condition + error. Pre-fix
 * Anvil treated them as unknown macros and fell to pass_through, leaving
 * embedded `ctx.accounts.*` references in the body that tripped the
 * validator's passthrough audit.
 *
 * Post-fix: classifier desugars each variant to a `require` IR kind with
 * the appropriate `lhs <op> rhs` condition. Two-arg and three-arg shapes
 * supported; default error code matches `require!`.
 *
 * Surfaced by diff-arc 2026-05-19 (anchor-tutorial-basic-4).
 */
import { describe, test, expect } from "bun:test";
import { parseAnchor } from "../src/parser/anchor-parser.ts";

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
    pub a: Signer<'info>,
    pub b: Signer<'info>,
}
`;

async function classifyFirstStmt(body: string) {
  const parsed = await parseAnchor(PROGRAM(body));
  if (!parsed.ok) throw new Error("parse: " + parsed.error);
  return parsed.ir.instructions[0]!.body[0];
}

describe("task #38 — require_* comparison macros desugar to require", () => {
  test("require_keys_eq!(lhs, rhs) → require(lhs == rhs)", async () => {
    const stmt = await classifyFirstStmt(`require_keys_eq!(ctx.accounts.a.key(), ctx.accounts.b.key());`);
    expect(stmt?.kind).toBe("require");
    if (stmt?.kind === "require") {
      expect(stmt.condition).toContain("==");
      expect(stmt.condition).toContain("ctx.accounts.a.key()");
      expect(stmt.condition).toContain("ctx.accounts.b.key()");
    }
  });

  test("require_keys_neq!(lhs, rhs) → require(lhs != rhs)", async () => {
    const stmt = await classifyFirstStmt(`require_keys_neq!(ctx.accounts.a.key(), ctx.accounts.b.key());`);
    expect(stmt?.kind).toBe("require");
    if (stmt?.kind === "require") expect(stmt.condition).toContain("!=");
  });

  test("require_eq!(lhs, rhs) → require(lhs == rhs)", async () => {
    const stmt = await classifyFirstStmt(`require_eq!(1u64, 2u64);`);
    expect(stmt?.kind).toBe("require");
    if (stmt?.kind === "require") expect(stmt.condition).toBe("1u64 == 2u64");
  });

  test("require_neq!(lhs, rhs) → require(lhs != rhs)", async () => {
    const stmt = await classifyFirstStmt(`require_neq!(1u64, 2u64);`);
    expect(stmt?.kind).toBe("require");
    if (stmt?.kind === "require") expect(stmt.condition).toBe("1u64 != 2u64");
  });

  test("require_gt!(lhs, rhs) → require(lhs > rhs)", async () => {
    const stmt = await classifyFirstStmt(`require_gt!(5u64, 1u64);`);
    expect(stmt?.kind).toBe("require");
    if (stmt?.kind === "require") expect(stmt.condition).toBe("5u64 > 1u64");
  });

  test("require_gte!(lhs, rhs) → require(lhs >= rhs)", async () => {
    const stmt = await classifyFirstStmt(`require_gte!(5u64, 5u64);`);
    expect(stmt?.kind).toBe("require");
    if (stmt?.kind === "require") expect(stmt.condition).toBe("5u64 >= 5u64");
  });

  test("3-arg form: require_eq!(lhs, rhs, ErrorCode::X) uses the named error", async () => {
    const stmt = await classifyFirstStmt(`require_eq!(1u64, 2u64, ErrorCode::Mismatch);`);
    expect(stmt?.kind).toBe("require");
    if (stmt?.kind === "require") {
      expect(stmt.error).toContain("ErrorCode::Mismatch");
    }
  });

  test("2-arg form: error defaults to ProgramError::Custom(0)", async () => {
    const stmt = await classifyFirstStmt(`require_eq!(1u64, 2u64);`);
    expect(stmt?.kind).toBe("require");
    if (stmt?.kind === "require") {
      expect(stmt.error).toBe("ProgramError::Custom(0)");
    }
  });

  test("plain require! still works", async () => {
    const stmt = await classifyFirstStmt(`require!(true, ErrorCode::X);`);
    expect(stmt?.kind).toBe("require");
    if (stmt?.kind === "require") expect(stmt.condition).toBe("true");
  });

  test("unknown macros still pass through (regression: don't over-fire on Rust stdlib macros)", async () => {
    const stmt = await classifyFirstStmt(`println!("hi");`);
    expect(stmt?.kind).toBe("pass_through");
  });
});

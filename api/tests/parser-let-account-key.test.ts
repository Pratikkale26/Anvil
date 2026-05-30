/**
 * task #39 — `let X = ctx.accounts.Y.key();` shape.
 *
 * Anchor handlers commonly capture an account's program-controlled
 * Pubkey into a local for use in CpiContext::new or similar:
 *
 *   let cpi_program_id = ctx.accounts.token_program.key();
 *   let cpi_ctx = CpiContext::new(cpi_program_id, ...);
 *
 * Pre-fix: the let-binding fell through to pass_through with the full
 * `ctx.accounts.token_program.key()` text intact. The emit's post-process
 * correctly rewrote it to `*token_program.key()` so cargo passed, but the
 * auditPassthrough pre-emit validator flagged the IR's `code` field as
 * "pass_through references ctx.accounts — Anchor-only" — a false positive
 * for users who saw the audit error and assumed cargo would also break.
 *
 * Post-fix: classifyLetDeclaration recognizes the shape and stores the
 * pass_through code with `ctx.accounts.` stripped. Both the audit and
 * the emit see the same clean text. cashiers-check's 3 audit errors on
 * `let cpi_program_id = ctx.accounts.token_program.key()` retire.
 *
 * Surfaced by diff-arc 2026-05-19 on cashiers-check.
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
    pub token_program: AccountInfo<'info>,
    pub authority: Signer<'info>,
}
`;

describe("task #39 — let X = ctx.accounts.Y.key()", () => {
  test("captured pass_through code drops the ctx.accounts. prefix", async () => {
    const parsed = await parseAnchor(PROGRAM(`let cpi_program_id = ctx.accounts.token_program.key();`));
    if (!parsed.ok) throw new Error("parse: " + parsed.error);
    const stmt = parsed.ir.instructions[0]!.body[0];
    expect(stmt?.kind).toBe("pass_through");
    if (stmt?.kind === "pass_through") {
      // Clean: no ctx.accounts. prefix, references the AccountInfo binding directly.
      expect(stmt.code).not.toContain("ctx.accounts.");
      expect(stmt.code).toContain("token_program.key()");
      // localVar preserved
      expect(stmt.code).toContain("cpi_program_id");
    }
  });

  test("audit-style ctx.accounts check would not fire", async () => {
    const parsed = await parseAnchor(PROGRAM(`let id = ctx.accounts.authority.key();`));
    if (!parsed.ok) throw new Error("parse: " + parsed.error);
    const stmt = parsed.ir.instructions[0]!.body[0];
    expect(stmt?.kind).toBe("pass_through");
    if (stmt?.kind === "pass_through") {
      const wouldAudit = /\bctx\.accounts\.\w+/.test(stmt.code);
      expect(wouldAudit).toBe(false);
    }
  });

  test("ctx.accounts.X.to_account_info() classifies as a state_read account alias (5d957d8)", async () => {
    const parsed = await parseAnchor(PROGRAM(`let ai = ctx.accounts.token_program.to_account_info();`));
    if (!parsed.ok) throw new Error("parse: " + parsed.error);
    const stmt = parsed.ir.instructions[0]!.body[0];
    // 5d957d8 recognises `to_account_info()` as an account-binding alias
    // (state_read), NOT a generic pass_through — it lowers to the canonical
    // account binding `ai` on emit (the standard CPI shape). Same reason the
    // pre-emit audit treats `.to_account_info()` as emit-handled (the B2
    // option-b tightening in passthrough-audit.ts).
    expect(stmt?.kind).toBe("state_read");
  });

  test("regression: state_read of bare ctx.accounts.X still classifies as state_read", async () => {
    const parsed = await parseAnchor(PROGRAM(`let acc = &ctx.accounts.authority;`));
    if (!parsed.ok) throw new Error("parse: " + parsed.error);
    const stmt = parsed.ir.instructions[0]!.body[0];
    // The state_read regex matches BEFORE our new branch — verify it's still
    // classified correctly.
    expect(stmt?.kind).toBe("state_read");
  });
});

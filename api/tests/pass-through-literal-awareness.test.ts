/**
 * B4 — the pass-through text pipeline must be STRING/CHAR-LITERAL AWARE.
 *
 * Two confirmed silent bugs in pass-through-emit.ts, both from scanning
 * statement text without distinguishing code from string/char literals:
 *
 *  1. Field-access rewrites (`<acct>.owner/.amount/.decimals/.minimum_balance`)
 *     fired INSIDE string literals — `msg!("vault.amount low")` had `.amount`
 *     rewritten inside the quotes (→ `token_account_amount(...)`), silently
 *     corrupting the log string.
 *
 *  2. The unbalanced-bracket safety scanner counted brackets inside string
 *     literals — `msg!("balance low :(")` looked unbalanced, so the WHOLE
 *     statement (which could be a security check) was silently commented out.
 *
 * Fix: both now run over a literal-masked, position-preserving view (string /
 * char / comment content → spaces). Code-region rewrites are unchanged (the
 * differential + snapshot suites cover that no in-code rewrite regressed).
 */
import { describe, test, expect } from "bun:test";
import { parseAnchor } from "../src/parser/anchor-parser.ts";
import { emitPinocchioFull } from "../src/emitter/pinocchio-emitter.ts";

const SRC = `use anchor_lang::prelude::*;
use anchor_spl::token::{Token, TokenAccount};
declare_id!("LiteralAware11111111111111111111111111111111");
#[program]
pub mod p {
    use super::*;
    pub fn check(ctx: Context<Check>) -> Result<()> {
        // (1) dotted token field INSIDE a string literal: .amount must NOT be
        // rewritten inside the quotes (would corrupt the log).
        msg!("vault.amount is too low");
        // (2) unbalanced bracket inside a string: the statement must NOT be
        // silently commented out as unbalanced.
        msg!("balance low :(");
        Ok(())
    }
}
#[derive(Accounts)]
pub struct Check<'info> {
    pub vault: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}
`;

describe("B4 — pass-through pipeline is string/char-literal aware", () => {
  test("field rewrites + bracket scanner ignore string-literal contents", async () => {
    const r = await parseAnchor(SRC);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const out = emitPinocchioFull(r.ir);
    const text = out.files.map((f) => f.content).join("\n");

    // (1) the log string survives verbatim. Pre-fix the field regex rewrote
    // `vault.amount` → `token_account_amount(...)` INSIDE the quotes, so this
    // exact literal would be absent.
    expect(text).toContain('"vault.amount is too low"');

    // (2) the unbalanced-bracket-in-string statement is emitted, NOT commented
    // out. Pre-fix the `(` inside the string flipped the bracket balance and the
    // whole statement got replaced with a "unbalanced brackets" marker.
    expect(text).toContain('"balance low :("');
    expect(text).not.toContain("unbalanced brackets");
  });
});

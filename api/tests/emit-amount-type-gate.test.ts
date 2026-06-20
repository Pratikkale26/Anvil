/**
 * F7 / #22 — `.amount` must lower to the SPL byte-64 read
 * (`token_account_amount`) ONLY for token-like accounts. A custom #[account]
 * state struct with a field NAMED `amount` must read the struct field
 * (deserialize + localVar.amount), NOT SPL byte-64 of unrelated state —
 * otherwise a money-math read is silently corrupted, validator-clean.
 *
 * Same class as F1 `.decimals` (gated on Mint). The gate is the SINGLE
 * predicate isTokenLikeAccount (accountType TokenAccount OR token:: /
 * associated_token:: constraint), applied at every `.amount` site:
 *   - AST: expr-transform `ctx.accounts.X.amount`, walker.resolveAmountExpr
 *     (CPI amount args)
 *   - structural (pass_through bodies): transformCtxAccountsStructural Pass 5 +
 *     rewriteStateBoundFieldsStructural Pass 6c (amount un-skipped)
 * A split predicate was the prior inconsistent-emit revert, so this test pins
 * BOTH the AST and the pass_through path on BOTH targets.
 */
import { describe, test, expect } from "bun:test";
import { parseAnchor } from "../src/parser/anchor-parser.ts";
import { emitNativeFull } from "../src/emitter/native-emitter.ts";
import { emitPinocchioFull } from "../src/emitter/pinocchio-emitter.ts";

const POOL = `#[account] pub struct Pool { pub authority: Pubkey, pub bump: u8, pub amount: u64, pub reserve: [u8; 64] }`;

async function emit(program: string, accounts: string) {
  const src = `
use anchor_lang::prelude::*;
use anchor_spl::token::TokenAccount;
declare_id!("AmountGate11111111111111111111111111111111");
#[program] pub mod p { use super::*; ${program} }
${accounts}
${POOL}
`;
  const r = await parseAnchor(src);
  expect(r.ok).toBe(true);
  if (!r.ok) throw new Error("parse failed: " + r.error);
  return { ir: r.ir, native: emitNativeFull(r.ir).singleFile, pino: emitPinocchioFull(r.ir).singleFile };
}

function fnBody(code: string, fn: string): string {
  const m = code.match(new RegExp(`pub fn ${fn}[\\s\\S]*?\\n\\}`));
  return m ? m[0] : "";
}

describe("F7 — .amount type-gate (custom-state vs token account)", () => {
  test("AST: custom-state .amount reads the struct field, NOT token_account_amount", async () => {
    const { native, pino } = await emit(
      `pub fn go(ctx: Context<C>) -> Result<()> { let _a = ctx.accounts.pool.amount; Ok(()) }`,
      `#[derive(Accounts)] pub struct C<'info> { pub pool: Account<'info, Pool>, pub signer: Signer<'info> }`,
    );
    for (const code of [native, pino]) {
      const body = fnBody(code, "go");
      expect(body).not.toContain("token_account_amount(pool");
      expect(body).toMatch(/Pool::(read|from_account_info)/);
      expect(body).toMatch(/pool\w*\.amount/); // localVar.amount
    }
  });

  test("AST: token-account .amount stays token_account_amount", async () => {
    const { native, pino } = await emit(
      `pub fn go(ctx: Context<C>) -> Result<()> { let _b = ctx.accounts.vault.amount; Ok(()) }`,
      `#[derive(Accounts)] pub struct C<'info> { pub vault: Account<'info, TokenAccount>, pub signer: Signer<'info> }`,
    );
    for (const code of [native, pino]) {
      expect(fnBody(code, "go")).toContain("token_account_amount(vault");
    }
  });

  test("AST: a token::-constrained account (constraint-only token-like) stays token_account_amount", async () => {
    // No TokenAccount in the type, but a token:: constraint → still token-like.
    const { native, pino } = await emit(
      `pub fn go(ctx: Context<C>) -> Result<()> { let _b = ctx.accounts.tok.amount; Ok(()) }`,
      `#[derive(Accounts)] pub struct C<'info> {
         #[account(token::mint = mint)] pub tok: Account<'info, TokenAccount>,
         pub mint: Account<'info, Pool>, pub signer: Signer<'info> }`,
    );
    for (const code of [native, pino]) {
      expect(fnBody(code, "go")).toContain("token_account_amount(tok");
    }
  });

  test("pass_through (structural): custom-state AND token .amount in one body — consistent, no leak", async () => {
    const { ir, native, pino } = await emit(
      `pub fn drain(ctx: Context<C>) -> Result<()> {
         let mut acc = 0u64;
         while acc < ctx.accounts.pool.amount { acc = acc + ctx.accounts.vault.amount; }
         Ok(())
       }`,
      `#[derive(Accounts)] pub struct C<'info> {
         pub pool: Account<'info, Pool>, pub vault: Account<'info, TokenAccount>, pub signer: Signer<'info> }`,
    );
    // Confirm it actually routes through pass_through (else this test is moot).
    expect(ir.instructions[0]!.body.some((b) => b.kind === "pass_through")).toBe(true);
    for (const code of [native, pino]) {
      const body = fnBody(code, "drain");
      expect(body).toMatch(/Pool::(read|from_account_info)/);  // custom state deserialized
      expect(body).not.toContain("token_account_amount(pool"); // NOT byte-64 on custom state
      expect(body).toContain("token_account_amount(vault");    // token account IS byte-64
      expect(body).not.toMatch(/ctx\s*\.\s*accounts/);         // no residual leak (→0u64 mangle)
    }
  });
});

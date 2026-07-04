/**
 * passthrough-audit ↔ system-program CPI + token-account `.amount` (single-source).
 *
 * The pre-emit audit ERRORed on ANY pass_through carrying `ctx.accounts` or
 * `CpiContext::`, including two shapes the emitter lowers byte-equal:
 *   - system-program CPIs via CpiContext — `create_account(CpiContext::new(
 *     ctx.accounts.system_program.key(), CreateAccount{..}), ..)` — the walker
 *     lowers to invoke(&system_instruction::create_account(..)); byte-equal-PROVEN
 *     by differential-program-examples-create-account.
 *   - token-account `.amount` reads — `ctx.accounts.vault.amount` lowers to
 *     `token_account_amount(vault)?` (Finding B, e52af5a); byte-equal-PROVEN by
 *     differential-token-balance-clamp.
 * Both blocked `anvil compile` / `--strict` and HTTP-422'd /emit?strict on
 * validator-clean, differential-certified programs — false positives, the same
 * class as the branched-SPL FP (Finding C) and the mpl_core lint blocker.
 *
 * Fix: normalizeForAudit strips those exact shapes. A shape the emitter does NOT
 * prove — a `.amount` on a NON-token account (arbitrary struct field, unproven
 * lowering, B2 silent-read guard) — MUST still flag. This pins both directions.
 */
import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseAnchor } from "../src/parser/anchor-parser.ts";
import { auditPassthrough } from "../src/emitter/passthrough-audit.ts";
import { loadAnchorSource } from "./fixtures/program-examples-create-account-fixture.ts";

const auditErrs = async (src: string) => {
  const r = await parseAnchor(src);
  if (!r.ok) throw new Error("parse failed: " + r.error);
  return auditPassthrough(r.ir).filter((f) => f.severity === "error");
};

describe("passthrough-audit: emitter-lowered system-program CPI + token .amount are NOT classification-gap errors", () => {
  test("create-account (system_program::create_account via CpiContext) → no audit errors", async () => {
    // Use the committed program-examples fixture (loadAnchorSource) rather than
    // a gitignored realworld/*.rs that never existed in a fresh clone / CI.
    const src = loadAnchorSource();
    expect(await auditErrs(src)).toEqual([]);
  });

  test("token-balance-clamp (token-account .amount read) → no audit errors", async () => {
    const src = readFileSync(join(import.meta.dir, "..", "src", "demo-programs", "token-balance-clamp.rs"), "utf-8");
    expect(await auditErrs(src)).toEqual([]);
  });
});

describe("passthrough-audit: unproven shapes still flag (B2 guard not blinded)", () => {
  test(".amount on a NON-token account still ERRORs (lowering unproven)", async () => {
    const src = `use anchor_lang::prelude::*;
declare_id!("Dec1areProgram11111111111111111111111111111");
#[account] pub struct Cfg { pub amount: u64 }
#[program] pub mod p { use super::*;
  pub fn go(ctx: Context<Go>) -> Result<()> {
    let x = ctx.accounts.cfg.amount; // cfg is NOT a token account
    msg!("{}", x);
    Ok(())
  }
}
#[derive(Accounts)] pub struct Go<'info> { #[account(mut)] pub cfg: Account<'info, Cfg>, pub authority: Signer<'info> }`;
    const errs = await auditErrs(src);
    expect(errs.some((e) => /ctx\.accounts/.test(e.message))).toBe(true);
  });

  test("an unbalanced / non-CpiContext create_account is left intact (fail-closed)", async () => {
    // A bare create_account whose program arg is a computed expr (not the
    // CpiContext::new(ctx.accounts.X…) shape) is NOT the walker-handled form;
    // its CpiContext must still flag.
    const src = `use anchor_lang::prelude::*;
declare_id!("Dec1areProgram11111111111111111111111111111");
#[program] pub mod p { use super::*;
  pub fn go(ctx: Context<Go>) -> Result<()> {
    let _c = CpiContext::new(some_program(), Whatever { a: ctx.accounts.payer.to_account_info() });
    Ok(())
  }
}
#[derive(Accounts)] pub struct Go<'info> { #[account(mut)] pub payer: Signer<'info> }`;
    const errs = await auditErrs(src);
    expect(errs.some((e) => /CpiContext/.test(e.message))).toBe(true);
  });
});

/**
 * F2 + F3 — surface two previously-silent parser fallbacks as warnings.
 *
 * F2: Token-2022 extractors seed each account local with a placeholder
 * (`let mint = "mint"`) and overwrite it from the CPI accounts struct. When
 * a PRIMARY field (mint/source/destination/authority/account/owner) is absent
 * from an otherwise-present struct, the placeholder was kept SILENTLY and could
 * bind the wrong account. Now resolveStructAccount warns. token_program_id is
 * intentionally NOT warned (it's commonly CpiContext-sourced, placeholder fine).
 *
 * F3: extractSignerSeedsExpr fell back to the literal "signer_seeds" on any
 * parse failure with no warning; the emitter then synthesizes its own seeds
 * prelude that may not match source intent. Now the failure path warns.
 */
import { describe, test, expect } from "bun:test";
import { parseAnchor } from "../src/parser/anchor-parser.ts";
import { extractSignerSeedsExpr } from "../src/parser/cpi-detector.ts";

function mockCollector() {
  const warnings: Array<{ code: string; message: string }> = [];
  const c: any = {
    add: (w: { code: string; message: string }) => warnings.push(w),
    drain: () => warnings,
    forInstruction() { return c; },
  };
  return { c, warnings };
}

const MEMO = (ownerField: string) => `use anchor_lang::prelude::*;
use anchor_spl::token_interface::{memo_transfer_initialize, MemoTransfer, Token2022};
declare_id!("F2F3Test11111111111111111111111111111111111");
#[program] pub mod m { use super::*;
  pub fn go(ctx: Context<A>) -> Result<()> {
    memo_transfer_initialize(CpiContext::new(ctx.accounts.token_program.to_account_info(),
      MemoTransfer {
        token_program_id: ctx.accounts.token_program.to_account_info(),
        account: ctx.accounts.token_account.to_account_info(),
        ${ownerField}: ctx.accounts.owner.to_account_info(),
      }))?;
    Ok(()) } }
#[derive(Accounts)] pub struct A<'info> {
  /// CHECK
  #[account(mut)] pub token_account: UncheckedAccount<'info>,
  /// CHECK
  pub owner: Signer<'info>,
  pub token_program: Program<'info, Token2022>,
}`;

describe("F2 — T22 placeholder account fields warn only on genuine miss", () => {
  test("well-formed struct (all fields present) does NOT warn", async () => {
    const r = await parseAnchor(MEMO("owner"));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.ir.warnings.filter((w) => w.code === "cpi_classification_lost").length).toBe(0);
  });

  test("a missing PRIMARY field (owner renamed) warns and names the field", async () => {
    // The struct now lacks `owner` (it's mis-named `ownr`), so the extractor's
    // "owner" lookup misses and falls back to the placeholder.
    const r = await parseAnchor(MEMO("ownr"));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const w = r.ir.warnings.filter((x) => x.code === "cpi_classification_lost");
    expect(w.length).toBeGreaterThan(0);
    expect(w.some((x) => /'owner'/.test(x.message))).toBe(true);
  });
});

describe("F3 — extractSignerSeedsExpr warns when it falls back to the default", () => {
  test("unparseable seeds → returns 'signer_seeds' AND warns", () => {
    const { c, warnings } = mockCollector();
    const out = extractSignerSeedsExpr("some text with no isolable signer arg", c);
    expect(out).toBe("signer_seeds");
    expect(warnings.filter((w) => w.code === "signer_seeds_lost_variable_binding").length).toBe(1);
  });

  test("valid fluent .with_signer(...) → extracts expr, no warning", () => {
    const { c, warnings } = mockCollector();
    const out = extractSignerSeedsExpr('foo.with_signer(&[&[b"seed", &[bump]]])', c);
    expect(out).toBe('&[&[b"seed", &[bump]]]');
    expect(warnings.length).toBe(0);
  });

  test("valid legacy new_with_signer(...) → extracts the 3rd arg, no warning", () => {
    const { c, warnings } = mockCollector();
    const out = extractSignerSeedsExpr("CpiContext::new_with_signer(p, a, my_seeds)", c);
    expect(out).toBe("my_seeds");
    expect(warnings.length).toBe(0);
  });

  test("a user variable literally named signer_seeds extracts cleanly (no false warn)", () => {
    const { c, warnings } = mockCollector();
    const out = extractSignerSeedsExpr("x.with_signer(signer_seeds)", c);
    expect(out).toBe("signer_seeds");
    expect(warnings.length).toBe(0);
  });
});

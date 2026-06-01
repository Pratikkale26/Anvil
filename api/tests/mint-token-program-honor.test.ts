/**
 * #19 — `mint::token_program` (Anchor 0.30+ Token-Interface) recognized + honored.
 *
 * Before: `mint::token_program` was an unrecognized constraint key → dropped from
 * the IR with a `constraint_key_unrecognized` warning. That was a FALSE ALARM:
 * the init-mint routing reads the token program from a SIBLING account (named
 * `token_program` or typed Interface<TokenInterface>/Program<Token2022>), so the
 * emit already routed correctly (byte-equal-verified by program-examples-t22-
 * basics) — the dropped constraint changed nothing, but the warning implied a
 * coverage gap. (It is a cosmetic warning, not a compile blocker — the program
 * emits 0 validator errors today.)
 *
 * After (recognize + loud-on-mismatch, NOT a silent re-route): the constraint is
 * carried in the IR (no false-alarm warning). The proven sibling routing is kept.
 * The constraint is HONORED by REFUSING LOUDLY when the account it names
 * DISAGREES with the sibling Anvil routed to — i.e. when multiple token-program
 * accounts are present and per-mint disambiguation would be needed. Anvil never
 * silently re-routes from a constraint whose multi-program resolution isn't built.
 *
 * Common case (`mint::token_program = token_program`, sibling agrees): no marker,
 * byte-identical routing. Mismatch case: a ⚠️ Anvil marker → validator error →
 * safe-by-default refuses.
 */
import { describe, test, expect } from "bun:test";
import { parseAnchor } from "../src/parser/anchor-parser.ts";
import { emitPinocchioFull } from "../src/emitter/pinocchio-emitter.ts";
import { emitNativeFull } from "../src/emitter/native-emitter.ts";
import { validateEmitterOutput } from "../src/emitter/output-validator.ts";

const COMMON = `
use anchor_lang::prelude::*;
use anchor_spl::token_interface::{Mint, TokenInterface};
declare_id!("MinttP11111111111111111111111111111111111111");
#[program]
pub mod mint_tp {
    use super::*;
    pub fn create(_ctx: Context<Create>) -> Result<()> { Ok(()) }
}
#[derive(Accounts)]
pub struct Create<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(init, payer = payer, mint::decimals = 6, mint::authority = payer, mint::token_program = token_program)]
    pub mint: InterfaceAccount<'info, Mint>,
    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}
`;

// Two token-program accounts; the constraint names the one that is NOT the first
// sibling Anvil's routing picks → genuine multi-token-program disambiguation.
const MISMATCH = COMMON
  .replace(
    "pub token_program: Interface<'info, TokenInterface>,",
    "pub other_tp: Interface<'info, TokenInterface>,\n    pub token_program: Interface<'info, TokenInterface>,",
  )
  .replace("mint::token_program = token_program)", "mint::token_program = other_tp)");

describe("#19 — mint::token_program recognized + honored (loud-on-mismatch)", () => {
  test("recognized: no unrecognized-key warning; carried in the IR", async () => {
    const r = await parseAnchor(COMMON);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(
      r.ir.warnings.filter((w) => /unrecognized.*mint::token_program/i.test(w.message ?? "")),
    ).toEqual([]);
    const mint = r.ir.instructions[0]!.accounts.find((a) => a.name === "mint");
    expect(mint?.constraints.some((c) => c.kind === "mint::token_program")).toBe(true);
  });

  for (const [target, emit] of [
    ["pinocchio", emitPinocchioFull] as const,
    ["native", emitNativeFull] as const,
  ]) {
    test(`${target}: common case agrees → no marker, 0 errors, routes to token_program.key`, async () => {
      const r = await parseAnchor(COMMON);
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      const out = emit(r.ir);
      expect(out.singleFile).not.toContain("mint::token_program binds");
      expect(validateEmitterOutput(r.ir, out).filter((i) => i.severity === "error")).toEqual([]);
      // Routing is honored via the sibling (unchanged by recognition).
      expect(/token_program\s*\.\s*key/.test(out.singleFile)).toBe(true);
    });
  }

  test("BITES: constraint names a non-sibling token program → ⚠️ marker + validator REFUSES", async () => {
    const r = await parseAnchor(MISMATCH);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const out = emitPinocchioFull(r.ir);
    expect(out.singleFile).toContain("mint::token_program binds 'other_tp'");
    const errs = validateEmitterOutput(r.ir, out).filter(
      (i) => i.severity === "error" && /unsafe-marker|not yet supported/i.test(i.message),
    );
    expect(errs.length).toBeGreaterThan(0);
  });
});

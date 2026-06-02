/**
 * passthrough-audit ↔ branched-SPL-CPI recognizer (single-source).
 *
 * The pre-emit audit used to ERROR on ANY pass_through carrying `CpiContext::`,
 * including the control-flow-wrapped inline SPL CPI shape the walker rewrites
 * byte-equal (`if cond { token::mint_to(CpiContext::new_with_signer(…)) }`).
 * That blocked `anvil compile` / `--strict` on byte-equal-PROVEN demos (staking
 * `unstake`, vesting `revoke`) — a false positive (differential-staking /
 * -vesting are green).
 *
 * Fix: normalizeForAudit strips the EXACT shapes the walker handles, via the
 * shared `branched-spl-cpi-recognizer` (single-source with the walker). A shape
 * the recognizer does NOT match — a genuinely-unhandled CpiContext (closure /
 * computed program-id), or `ctx.bumps` (Finding B, a real Pinocchio mangle) —
 * MUST still flag. This test pins both directions so the audit can neither
 * re-introduce the FP nor be blinded.
 */
import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseAnchor } from "../src/parser/anchor-parser.ts";
import { auditPassthrough } from "../src/emitter/passthrough-audit.ts";
import { stripHandledBranchedSplCpis } from "../src/emitter/body-emitter/branched-spl-cpi-recognizer.ts";

const demo = (name: string) => readFileSync(join(import.meta.dir, "..", "src", "demo-programs", name), "utf-8");
const auditErrs = async (src: string) => {
  const r = await parseAnchor(src);
  if (!r.ok) throw new Error("parse failed");
  return auditPassthrough(r.ir).filter((f) => f.severity === "error");
};

describe("passthrough-audit: handled branched SPL CPI is NOT a classification-gap error", () => {
  test("staking: conditional token::mint_to(CpiContext::new_with_signer) no longer errors", async () => {
    const errs = await auditErrs(demo("staking.rs"));
    // staking's only audit error was the conditional mint_to CpiContext FP.
    expect(errs.some((e) => /CpiContext/.test(e.message))).toBe(false);
    expect(errs).toEqual([]);
  });

  test("vesting: conditional token::transfer CpiContext FP suppressed", async () => {
    const errs = await auditErrs(demo("vesting.rs"));
    expect(errs.some((e) => /CpiContext/.test(e.message))).toBe(false);
  });
});

describe("passthrough-audit: true positives still flag (not blinded)", () => {
  test("perp-funding: ctx.bumps-in-let (Finding B) still ERRORs", async () => {
    const errs = await auditErrs(demo("perp-funding.rs"));
    expect(errs.some((e) => /ctx\.bumps/.test(e.message))).toBe(true);
  });

  test("strip leaves a bare let-bound CpiContext (closure/let-else shape) intact", () => {
    const bare = `let _c = CpiContext::new(ctx.accounts.token_program.to_account_info(), Transfer { from: ctx.accounts.a.to_account_info(), to: ctx.accounts.b.to_account_info(), authority: ctx.accounts.auth.to_account_info() });`;
    expect(/CpiContext::/.test(stripHandledBranchedSplCpis(bare))).toBe(true);
  });

  test("strip leaves a computed-program-id token::transfer CpiContext intact", () => {
    const computed = `token::transfer(CpiContext::new(some_fn(), Transfer { from: ctx.accounts.a.to_account_info(), to: ctx.accounts.b.to_account_info(), authority: ctx.accounts.auth.to_account_info() }), amt)?;`;
    expect(/CpiContext::/.test(stripHandledBranchedSplCpis(computed))).toBe(true);
  });
});

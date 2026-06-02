/**
 * #17 — a `cpi_custom` stub (uncataloged invoke/invoke_signed CPI — e.g. cNFT /
 * Bubblegum / any custom program) must be a validator ERROR, not just a
 * warning, so safe-by-default REFUSES it.
 *
 * Surfaced by the 2026-06-01 new-repo sweep (compression/cnft-vault): the
 * instruction was stubbed `unimplemented!("Anvil: cpi_custom …")` + a
 * `// ⚠️ Anvil … manual port required` marker, yet the program validated with
 * 0 ERRORS (only warnings) → safe-by-default shipped a program that PANICS
 * on-chain. Two conspiring causes:
 *   1. "manual port required" wasn't in output-validator's isBroken error-phrase
 *      set (only "manual rebuild required" / "not yet supported" / … were), so
 *      the ⚠️ Anvil marker was classified as a (review) WARNING; AND
 *   2. that marker suppressed the `unimplemented!("[Aa]nvil")` error-scan.
 * Same silent-stub class as B1-B5, via a phrasing hole. The fix promotes
 * "manual port required" to an error phrase — which also covers the Option<T>,
 * non-unit-Result, carried-helper, and B4 unbalanced-bracket stubs (all use it).
 */
import { describe, test, expect } from "bun:test";
import { parseAnchor } from "../src/parser/anchor-parser.ts";
import { emitPinocchioFull } from "../src/emitter/pinocchio-emitter.ts";
import { emitNativeFull } from "../src/emitter/native-emitter.ts";
import { validateEmitterOutput } from "../src/emitter/output-validator.ts";

// A handler with a raw invoke_signed to an uncataloged program → cpi_custom
// → unimplemented!() stub. This is exactly what cnft-vault's Bubblegum CPIs hit.
const SRC = `use anchor_lang::prelude::*;
use anchor_lang::solana_program::program::invoke_signed;
use anchor_lang::solana_program::instruction::Instruction;
declare_id!("CpiCustomGate1111111111111111111111111111111");

#[program]
pub mod m {
    use super::*;
    pub fn forward(ctx: Context<Forward>, data: Vec<u8>) -> Result<()> {
        let ix = Instruction { program_id: ctx.accounts.target_program.key(), accounts: vec![], data };
        // NON-canonical on purpose: the account_infos come from a dynamically
        // built Vec (not an inline &[...] array literal of .to_account_info()
        // calls), so the #23 canonical-shape detector does NOT fire → this stays
        // an uncataloged cpi_custom STUB on BOTH targets, which is exactly the
        // shape #17 verifies the validator refuses.
        let infos = vec![
            ctx.accounts.target_program.to_account_info(),
            ctx.accounts.authority.to_account_info(),
        ];
        invoke_signed(&ix, &infos, &[&[b"auth", &[1u8]]])?;
        Ok(())
    }
}

#[derive(Accounts)]
pub struct Forward<'info> {
    /// CHECK: target program
    pub target_program: UncheckedAccount<'info>,
    /// CHECK: pda authority
    pub authority: UncheckedAccount<'info>,
}
`;

describe("#17 — cpi_custom (uncataloged CPI) stub is a validator ERROR, not just a warning", () => {
  for (const [target, emit] of [
    ["pinocchio", emitPinocchioFull] as const,
    ["native", emitNativeFull] as const,
  ]) {
    test(`${target}: unimplemented!() cpi_custom stub → ERROR so safe-by-default refuses`, async () => {
      const r = await parseAnchor(SRC);
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      const out = emit(r.ir);
      const issues = validateEmitterOutput(r.ir, out);
      const errors = issues.filter((i) => i.severity === "error");
      // Pre-#17 this was 0 (the runtime-panic stub shipped as "clean").
      expect(errors.length).toBeGreaterThan(0);
      expect(
        errors.some((i) => /cpi_custom|manual port required|unsafe-marker|unimplemented/i.test(i.message)),
      ).toBe(true);
    });
  }
});

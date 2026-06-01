/**
 * B2 — read-only custom-state Account<T> must still get the
 * `owner == program_id` check. Anchor's `Account<T>::try_from` enforces owner
 * unconditionally (`mut` only gates writeback); Anvil previously gated the
 * owner check on `a.isMut`, so a READ-ONLY state account — e.g. a `config`
 * whose `admin` field authorizes a privileged path — was deserialized with a
 * discriminator + length check but NO owner check. An attacker could pass a
 * same-size, same-discriminator account owned by a DIFFERENT program and pass
 * the authorization read. Class-wide, both targets.
 *
 * This test pins BOTH directions of the scope:
 *   (1) read-only custom state (Account<'info, Config>) GETS the owner check
 *   (2) Program / Sysvar / Signer / SystemAccount do NOT (owned by other
 *       programs — their types aren't in ir.accounts, so isCustomState excludes
 *       them) — so the fix doesn't over-fire and reject legitimate accounts.
 */
import { describe, test, expect } from "bun:test";
import { parseAnchor } from "../src/parser/anchor-parser.ts";
import { emitPinocchioFull } from "../src/emitter/pinocchio-emitter.ts";
import { emitNativeFull } from "../src/emitter/native-emitter.ts";
import { validateEmitterOutput } from "../src/emitter/output-validator.ts";

// `read_config` reads a NON-mut custom-state account (`config`) for auth, plus
// a Signer, a Program, and a Sysvar — none of which may get a program_id owner
// check. `touch` takes the same config as `mut` (the pre-B2 covered case).
const SRC = `use anchor_lang::prelude::*;
declare_id!("Read0n1y0wnerCheck1111111111111111111111111");
#[program]
pub mod m {
    use super::*;
    pub fn read_config(ctx: Context<ReadConfig>) -> Result<()> {
        require_keys_eq!(ctx.accounts.config.admin, ctx.accounts.authority.key());
        Ok(())
    }
    pub fn touch(ctx: Context<Touch>) -> Result<()> {
        ctx.accounts.config.value += 1;
        Ok(())
    }
}
#[account]
pub struct Config { pub admin: Pubkey, pub value: u64 }

#[derive(Accounts)]
pub struct ReadConfig<'info> {
    // read-only custom state used for authorization — MUST get an owner check.
    pub config: Account<'info, Config>,
    pub authority: Signer<'info>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct Touch<'info> {
    #[account(mut)]
    pub config: Account<'info, Config>,
}
`;

describe("B2: read-only custom-state Account<T> gets owner==program_id check", () => {
  for (const [target, emit] of [
    ["pinocchio", emitPinocchioFull] as const,
    ["native", emitNativeFull] as const,
  ]) {
    test(`${target}: read-only config gets the check; signer/program/sysvar do not`, async () => {
      const r = await parseAnchor(SRC);
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      const out = emit(r.ir);
      const readConfigFn = out.files
        .map((f) => f.content)
        .join("\n")
        .match(/fn read_config\([\s\S]*?\n\}/)?.[0] ?? "";
      expect(readConfigFn.length).toBeGreaterThan(0);

      // (1) the read-only custom-state account IS owner-checked.
      // Pinocchio: `config.owner() != program_id`; native: `config.owner != program_id`.
      expect(readConfigFn).toMatch(/\bconfig\s*\.\s*owner(\(\))?\s*!=\s*program_id/);

      // (2) the signer / program / sysvar are NOT owner-checked against program_id
      // (they're owned by other programs; over-firing would reject valid txns).
      expect(readConfigFn).not.toMatch(/\bauthority\s*\.\s*owner(\(\))?\s*!=\s*program_id/);
      expect(readConfigFn).not.toMatch(/\bsystem_program\s*\.\s*owner(\(\))?\s*!=\s*program_id/);
      expect(readConfigFn).not.toMatch(/\brent\s*\.\s*owner(\(\))?\s*!=\s*program_id/);
    });
  }

  test("validator flags a missing read-only owner check (lockstep with emitter)", async () => {
    const r = await parseAnchor(SRC);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const out = emitPinocchioFull(r.ir);

    // Sanity: a clean emit (which now includes the read-only owner check) must
    // NOT raise a missing-owner-check issue.
    const cleanIssues = validateEmitterOutput(r.ir, out);
    expect(cleanIssues.some((i) => /owner.*check|owner == program_id/i.test(i.message))).toBe(false);

    // Now strip the read-only config's owner check from read_config and confirm
    // the validator catches the regression.
    const tampered = {
      ...out,
      files: out.files.map((f) => ({
        ...f,
        content: f.content.replace(
          /\n\s*if config\.owner\(\) != program_id \{\n\s*return Err\(ProgramError::IncorrectProgramId\);\n\s*\}/,
          "",
        ),
      })),
    };
    const issues = validateEmitterOutput(r.ir, tampered);
    expect(issues.some((i) => i.severity === "error" && /owner/i.test(i.message))).toBe(true);
  });
});

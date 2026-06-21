/**
 * #16 — loud-refuse for a PDA-signed CPI carried as a pass-through
 * `invoke_signed(.., signer_a)` whose `signer_*` variable the emitter never
 * binds. Pre-fix this emitted a referenced-but-unbound identifier (E0425) that
 * the fast validator stamped clean; now checkUnboundSignerSeeds flags it as an
 * error so --strict refuses. (A full correct-emit fix — binding the custom
 * signer var — is tracked separately; this is the safe loud-refuse guard.)
 *
 * The canonical `signer_seeds` path (every PDA-signing demo) is the control:
 * it binds `let signer_seeds = …` so it must NOT be flagged.
 */
import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseAnchor } from "../src/parser/anchor-parser.ts";
import { emitPinocchioFull } from "../src/emitter/pinocchio-emitter.ts";
import { emitNativeFull } from "../src/emitter/native-emitter.ts";
import { validateEmitterOutput } from "../src/emitter/output-validator.ts";

const BROKEN = `use anchor_lang::prelude::*;
use anchor_lang::system_program::{self, Transfer};
declare_id!("11111111111111111111111111111111");
#[program]
pub mod m {
    use super::*;
    pub fn release(ctx: Context<Release>, amt: u64) -> Result<()> {
        let bump_a = ctx.bumps.vault;
        let seeds_a = &[b"vault".as_ref(), &[bump_a]];
        let signer_a = &[&seeds_a[..]];
        let cpi = CpiContext::new_with_signer(
            ctx.accounts.system_program.to_account_info(),
            Transfer {
                from: ctx.accounts.vault.to_account_info(),
                to: ctx.accounts.user.to_account_info(),
            },
            signer_a,
        );
        system_program::transfer(cpi, amt)?;
        Ok(())
    }
}
#[derive(Accounts)]
pub struct Release<'info> {
    #[account(mut)]
    pub user: Signer<'info>,
    #[account(mut, seeds = [b"vault"], bump)]
    pub vault: SystemAccount<'info>,
    pub system_program: Program<'info, System>,
}
`;

const CONTROL = readFileSync(join(import.meta.dir, "..", "src", "demo-programs", "escrow.rs"), "utf-8");

const hash16 = (issues: { message: string }[]) => issues.filter((i) => i.message.includes("Anvil #16"));

describe("#16 — unbound signer-seeds variable is a loud validator error", () => {
  for (const [target, emit] of [
    ["pinocchio", emitPinocchioFull] as const,
    ["native", emitNativeFull] as const,
  ]) {
    test(`${target}: a custom signer_* var with no binding is flagged as error`, async () => {
      const r = await parseAnchor(BROKEN);
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      const issues = hash16(validateEmitterOutput(r.ir, emit(r.ir)));
      expect(issues.length).toBeGreaterThan(0);
      expect(issues.every((i) => i.severity === "error")).toBe(true);
      expect(issues.some((i) => i.message.includes("signer_a"))).toBe(true);
    });

    test(`${target}: canonical signer_seeds program (escrow) is NOT flagged`, async () => {
      const r = await parseAnchor(CONTROL);
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(hash16(validateEmitterOutput(r.ir, emit(r.ir))).length).toBe(0);
    });
  }
});

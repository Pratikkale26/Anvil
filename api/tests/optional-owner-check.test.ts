/**
 * Bare-optional `Account<T>` intrinsic owner check (companion to
 * readonly-owner-check.test.ts for the non-optional B2 case).
 *
 * Anchor's `Account<T>::try_from` enforces `owner == program_id` even on a
 * bare `Option<Account<'info, T>>` when the account is present (zero
 * constraints needed). Anvil's preamble `ownerChecks` filter skips optionals
 * (`!a.isOptional`), so the check is injected by the body walker INSIDE the
 * Some-branch (present → checked, absent → skipped, matching Anchor) right
 * before `T::from_account_info`. Without it, a wrong-owner account with a
 * valid discriminator passed as the present optional would be deserialized and
 * its state read for authorization — accepted by Anvil, rejected by Anchor.
 *
 * Runtime reject + revert-parity is gated by
 * differential-option-account-owner-reject.test.ts; this pins the EMIT on both
 * targets and both shapes (read `&` and mut `&mut`).
 */
import { describe, test, expect } from "bun:test";
import { parseAnchor } from "../src/parser/anchor-parser.ts";
import { emitPinocchioFull } from "../src/emitter/pinocchio-emitter.ts";
import { emitNativeFull } from "../src/emitter/native-emitter.ts";

const READ_SRC = `use anchor_lang::prelude::*;
declare_id!("optnRd0nyCheck11111111111111111111111111111");
#[program]
pub mod m {
    use super::*;
    pub fn gate(ctx: Context<Gate>) -> Result<()> {
        if let Some(cfg) = &ctx.accounts.config {
            require_keys_eq!(cfg.admin, ctx.accounts.authority.key());
        }
        Ok(())
    }
}
#[account]
pub struct Config { pub admin: Pubkey }
#[derive(Accounts)]
pub struct Gate<'info> {
    pub authority: Signer<'info>,
    pub config: Option<Account<'info, Config>>,
}
`;

const MUT_SRC = `use anchor_lang::prelude::*;
declare_id!("optnRd0nyCheck11111111111111111111111111111");
#[program]
pub mod m {
    use super::*;
    pub fn gate(ctx: Context<Gate>) -> Result<()> {
        if let Some(cfg) = &mut ctx.accounts.config {
            cfg.counter += 1;
        }
        Ok(())
    }
}
#[account]
pub struct Config { pub admin: Pubkey, pub counter: u64 }
#[derive(Accounts)]
pub struct Gate<'info> {
    pub authority: Signer<'info>,
    pub config: Option<Account<'info, Config>>,
}
`;

describe("bare-optional Account<T> gets the intrinsic owner check in the Some-branch", () => {
  for (const [shape, src] of [["read (&)", READ_SRC], ["mut (&mut)", MUT_SRC]] as const) {
    for (const [target, emit, ownerExpr] of [
      ["Pinocchio", emitPinocchioFull, "cfg_account.owner() != program_id"],
      ["Native", emitNativeFull, "cfg_account.owner != program_id"],
    ] as const) {
      test(`${target} — ${shape}: owner check precedes from_account_info`, async () => {
        const r = await parseAnchor(src);
        expect(r.ok).toBe(true);
        if (!r.ok) return;
        const all = emit(r.ir).files.map((f) => f.content).join("\n");

        // Not loud-refused — it really emits the body (the gap only exists on
        // the un-gated path).
        expect(all).not.toContain("Option<T> optional account field");

        // The owner check is present, in the Some-branch, BEFORE the deserialize.
        expect(all).toContain(ownerExpr);
        const someIdx = all.indexOf("if let Some(cfg_account)");
        const ownerIdx = all.indexOf(ownerExpr);
        const deserIdx = all.indexOf("Config::from_account_info(cfg_account)");
        expect(someIdx).toBeGreaterThanOrEqual(0);
        expect(ownerIdx).toBeGreaterThan(someIdx);
        expect(ownerIdx).toBeLessThan(deserIdx); // owner check BEFORE deserialize
        expect(all).toContain("IncorrectProgramId");
      });
    }
  }
});

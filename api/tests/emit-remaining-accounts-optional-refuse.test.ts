/**
 * G3 / #28 — `ctx.remaining_accounts` alongside an optional account must
 * loud-refuse, not ship a wrong slice offset.
 *
 * An optional account still occupies a positional slot (the caller passes a
 * program_id sentinel for None), but the remaining-accounts offset counted only
 * the NON-optional named accounts, so the loop started one slot early and
 * double-counted the optional (e.g. `treasury.total += bonus.lamports() + r1`).
 * It shipped silently because the parser's `optional_accounts_unsupported`
 * note is warning-severity and promised an unimplemented! stub it never emitted.
 *
 * Fix: emit an `unimplemented!("anvil: …")` stub (caught by the validator's
 * unsafe-marker scan → error → /emit + --strict refuse) instead of the offset.
 */
import { describe, test, expect } from "bun:test";
import { parseAnchor } from "../src/parser/anchor-parser.ts";
import { emitNativeFull } from "../src/emitter/native-emitter.ts";
import { emitPinocchioFull } from "../src/emitter/pinocchio-emitter.ts";
import { checkUnsafeMarkers } from "../src/emitter/output-validator.ts";

const SRC = `
use anchor_lang::prelude::*;
declare_id!("Counter111111111111111111111111111111111111");
#[program]
pub mod g3 {
    use super::*;
    pub fn sweep(ctx: Context<S>) -> Result<()> {
        let mut total: u64 = 0;
        for acc in ctx.remaining_accounts.iter() {
            total += acc.lamports();
        }
        ctx.accounts.treasury.total = total;
        Ok(())
    }
}
#[derive(Accounts)]
pub struct S<'info> {
    #[account(mut)] pub treasury: Account<'info, Treasury>,
    pub bonus: Option<Account<'info, Treasury>>,
}
#[account] pub struct Treasury { pub total: u64 }
`;

describe("G3 — remaining_accounts + optional account loud-refuses", () => {
  for (const [target, emit] of [["native", emitNativeFull], ["pinocchio", emitPinocchioFull]] as const) {
    test(`${target}: emits an unimplemented! stub the validator flags as error`, async () => {
      const r = await parseAnchor(SRC);
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      const out = emit(r.ir).singleFile;
      // the wrong static slice must NOT be emitted
      expect(out).not.toContain("accounts[1..]");
      // a loud anvil stub IS emitted
      expect(out).toContain('unimplemented!("anvil: ctx.remaining_accounts');
      // and the validator escalates it to a hard error
      const issues = checkUnsafeMarkers(out, "instructions/g3.rs");
      expect(issues.some((i) => i.severity === "error")).toBe(true);
    });
  }
});

/**
 * I3 / #40 — an account that is both mutated and `close = dest` must NOT get a
 * trailing State::write.
 *
 * Regression from F5 (close-reassign, 9650aec): the close helper now does
 * realloc(0)/assign(System) on the account, then emitPendingSaves emitted a
 * `State::write(&mut account.data.borrow_mut(), ...)` into the now-0-length
 * buffer → revert, where Anchor commits the close and discards the in-memory
 * mutation. Fix: skip the save for any account carrying a `close` constraint.
 */
import { describe, test, expect } from "bun:test";
import { parseAnchor } from "../src/parser/anchor-parser.ts";
import { emitNativeFull } from "../src/emitter/native-emitter.ts";
import { emitPinocchioFull } from "../src/emitter/pinocchio-emitter.ts";

const SRC = `
use anchor_lang::prelude::*;
declare_id!("Counter111111111111111111111111111111111111");
#[program]
pub mod m {
    use super::*;
    pub fn close_it(ctx: Context<C>) -> Result<()> {
        let s = &mut ctx.accounts.state;
        s.counter = s.counter.checked_add(1).unwrap();
        Ok(())
    }
}
#[derive(Accounts)]
pub struct C<'info> {
    #[account(mut, close = dest)]
    pub state: Account<'info, State>,
    #[account(mut)] pub dest: SystemAccount<'info>,
}
#[account] pub struct State { pub counter: u64 }
`;

describe("I3 — close + mutation skips the pending save", () => {
  for (const [target, emit] of [["native", emitNativeFull], ["pinocchio", emitPinocchioFull]] as const) {
    test(`${target}: the close is emitted but no State::write follows it`, async () => {
      const r = await parseAnchor(SRC);
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      const out = emit(r.ir).singleFile;
      // region = the close_it handler (up to the State struct impl that follows)
      const start = out.indexOf("fn close_it");
      const end = out.indexOf("impl State", start);
      const body = out.slice(start, end > start ? end : start + 2000);
      // the close still happens
      expect(/close_program_account|\.close\(\)/.test(body)).toBe(true);
      // but there is no State save into the closed account's buffer
      expect(/State::write|State::save/.test(body)).toBe(false);
    });
  }
});

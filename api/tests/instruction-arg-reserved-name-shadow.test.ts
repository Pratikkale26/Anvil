/**
 * Reserved-name collision — an instruction arg named after the emitter's own
 * arg-decode locals (`remaining` cursor, `arg_bytes`/`rest` split temps,
 * `__ix_data`) must be renamed so it can't shadow them.
 *
 * Pre-fix (prod-readiness eval 2026-06-21, Finding 2): instruction-parser's
 * collision set was only {program_id, accounts}. An arg `remaining: u16` emitted
 * `let remaining: u16 = …`, shadowing the `let mut remaining: &[u8]` cursor, so
 * the trailing `remaining.is_empty()` / `.split_at()` became `u16.is_empty()`
 * → E0599 — non-compiling Rust the validator stamped "clean". The fix adds the
 * decode locals to the rename set so they become `arg_in_<name>`.
 */
import { describe, test, expect } from "bun:test";
import { parseAnchor } from "../src/parser/anchor-parser.ts";
import { emitPinocchioFull } from "../src/emitter/pinocchio-emitter.ts";
import { emitNativeFull } from "../src/emitter/native-emitter.ts";

const SRC = `use anchor_lang::prelude::*;
declare_id!("Shadow1111111111111111111111111111111111111");
#[program]
pub mod m {
    use super::*;
    pub fn run(ctx: Context<Run>, remaining: u16, rest: u32, arg_bytes: u8) -> Result<()> {
        let acc = &mut ctx.accounts.data;
        acc.total = remaining as u64 + rest as u64 + arg_bytes as u64;
        Ok(())
    }
}
#[account]
pub struct Data { pub total: u64 }
#[derive(Accounts)]
pub struct Run<'info> {
    #[account(mut)]
    pub data: Account<'info, Data>,
}
`;

describe("instruction arg named after a decode local is renamed (no cursor shadow)", () => {
  for (const [target, emit] of [
    ["pinocchio", emitPinocchioFull] as const,
    ["native", emitNativeFull] as const,
  ]) {
    test(`${target}: args collide-renamed to arg_in_*, decode cursor intact`, async () => {
      const r = await parseAnchor(SRC);
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      const out = emit(r.ir);
      const text = out.files.map((f) => f.content).join("\n");

      // The emitter's own decode cursor + split temps are present and intact.
      expect(text).toMatch(/let mut remaining: &\[u8\] = __ix_data;/);
      expect(text).toMatch(/let \(arg_bytes, rest\) = remaining\.split_at\(/);
      expect(text).toMatch(/if !remaining\.is_empty\(\)/);

      // Each colliding arg is renamed to arg_in_<name> at its binding + use.
      expect(text).toMatch(/let arg_in_remaining: u16/);
      expect(text).toMatch(/let arg_in_rest: u32/);
      expect(text).toMatch(/let arg_in_arg_bytes: u8/);
      expect(text).toMatch(/arg_in_remaining as u64/);

      // The bug: an UNrenamed scalar `remaining`/`rest` arg binding that would
      // shadow the cursor / split temp. Must NOT appear.
      expect(text).not.toMatch(/let remaining: u16/);
      expect(text).not.toMatch(/let rest: u32/);
    });
  }
});

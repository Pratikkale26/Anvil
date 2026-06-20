/**
 * I1 / #41 — two `#[account(mut, realloc = …)]` fields aliased to the same
 * pubkey must revert (Anchor's AccountDuplicateReallocs, 3017), not silently
 * realloc the one account twice and last-write-wins.
 *
 * Anchor accumulates realloc'd keys in a per-instruction set and rejects a
 * repeated key before any work. Anvil reallocs each realloc account
 * independently with no cross-account dedup. Fix: a pairwise key-distinctness
 * guard before the realloc preludes (only when 2+ realloc accounts exist).
 */
import { describe, test, expect } from "bun:test";
import { parseAnchor } from "../src/parser/anchor-parser.ts";
import { emitNativeFull } from "../src/emitter/native-emitter.ts";
import { emitPinocchioFull } from "../src/emitter/pinocchio-emitter.ts";

const SRC = (extra: string, body: string) => `
use anchor_lang::prelude::*;
declare_id!("Counter111111111111111111111111111111111111");
#[program]
pub mod m { use super::*; pub fn grow(ctx: Context<Grow>) -> Result<()> { ${body} Ok(()) } }
#[account] pub struct St { pub val: u64 }
#[derive(Accounts)]
pub struct Grow<'info> {
  #[account(mut, realloc = 80, realloc::payer = payer, realloc::zero = false)] pub a: Account<'info, St>,
  ${extra}
  #[account(mut)] pub payer: Signer<'info>,
  pub system_program: Program<'info, System>,
}
`;

async function emit(src: string) {
  const r = await parseAnchor(src);
  expect(r.ok).toBe(true);
  if (!r.ok) throw new Error("parse failed");
  return { native: emitNativeFull(r.ir).singleFile, pino: emitPinocchioFull(r.ir).singleFile };
}

describe("I1 — duplicate-realloc guard", () => {
  test("two realloc accounts → pairwise key-distinctness guard on both targets", async () => {
    const { native, pino } = await emit(SRC(
      `#[account(mut, realloc = 80, realloc::payer = payer, realloc::zero = false)] pub b: Account<'info, St>,`,
      `ctx.accounts.a.val = 1; ctx.accounts.b.val = 2;`,
    ));
    expect(/if \*a\.key == \*b\.key \{/.test(native)).toBe(true);
    expect(native).toContain("ProgramError::InvalidArgument");
    expect(/if \*a\.key\(\) == \*b\.key\(\) \{/.test(pino)).toBe(true);
    expect(pino).toContain("ProgramError::InvalidArgument");
  });

  test("single realloc account → no guard (can't duplicate itself)", async () => {
    const { native, pino } = await emit(SRC("", `ctx.accounts.a.val = 1;`));
    expect(/\.key.*==.*\.key/.test(native)).toBe(false);
    expect(/\.key\(\).*==.*\.key\(\)/.test(pino)).toBe(false);
  });

  // J1 / #48 — Anchor's `dup` annotation EXPLICITLY allows a realloc account to
  // alias another; AccountDuplicateReallocs fires only for UN-annotated
  // collisions. The guard must NOT fire for a `dup` pair, else Anvil reverts a
  // program Anchor accepts (byte-equal DIVERGED on realloc-array.rs).
  test("two realloc accounts, one marked `dup` → NO guard (Anchor allows the alias)", async () => {
    const { native, pino } = await emit(SRC(
      `#[account(mut, realloc = 80, realloc::payer = payer, realloc::zero = false, dup)] pub b: Account<'info, St>,`,
      `ctx.accounts.a.val = 1; ctx.accounts.b.val = 2;`,
    ));
    expect(/\*a\.key == \*b\.key/.test(native)).toBe(false);
    expect(/\*a\.key\(\) == \*b\.key\(\)/.test(pino)).toBe(false);
  });
});

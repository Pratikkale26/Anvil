/**
 * G6 / #32 — a local `let <name> = …` that shadows a Sysvar<Clock> account
 * must not have its field reads rewritten to the Clock::get() syscall.
 *
 * applyClockRentRewrites turned `<clock-account>.epoch` into
 * `Clock::get()?.epoch`, scope-blind — so `let clock = &ctx.accounts.pool;
 * out.v = clock.epoch;` (reading the stored Pool.epoch) was misrouted to the
 * live runtime epoch. Fix: skip any sysvar name shadowed by a local alias.
 * A genuine (non-shadowed) sysvar read must still be rewritten.
 */
import { describe, test, expect } from "bun:test";
import { parseAnchor } from "../src/parser/anchor-parser.ts";
import { emitNativeFull } from "../src/emitter/native-emitter.ts";

async function emit(src: string) {
  const r = await parseAnchor(src);
  expect(r.ok).toBe(true);
  if (!r.ok) throw new Error("parse failed");
  return emitNativeFull(r.ir).singleFile;
}

const HEAD = `
use anchor_lang::prelude::*;
declare_id!("Counter111111111111111111111111111111111111");
`;

describe("G6 — Sysvar<Clock> name-shadow", () => {
  test("shadowed clock (local alias) → field read is NOT routed to Clock::get()", async () => {
    const out = await emit(`${HEAD}
#[program] pub mod m { use super::*;
  pub fn go(ctx: Context<G>) -> Result<()> {
    let clock = &ctx.accounts.pool;
    ctx.accounts.out.v = clock.epoch;
    Ok(())
  }
}
#[derive(Accounts)]
pub struct G<'info> {
  pub clock: Sysvar<'info, Clock>,
  pub pool: Account<'info, Pool>,
  #[account(mut)] pub out: Account<'info, Out>,
}
#[account] pub struct Pool { pub epoch: u64 }
#[account] pub struct Out { pub v: u64 }
`);
    // the out.v assignment must not pull from the Clock syscall
    expect(/out\.v\s*=\s*[^;]*Clock::get/.test(out)).toBe(false);
  });

  test("NON-shadowed Sysvar<Clock> read IS still routed to Clock::get()", async () => {
    const out = await emit(`${HEAD}
#[program] pub mod m { use super::*;
  pub fn go(ctx: Context<G>) -> Result<()> {
    ctx.accounts.out.v = clock.unix_timestamp as u64;
    Ok(())
  }
}
#[derive(Accounts)]
pub struct G<'info> {
  pub clock: Sysvar<'info, Clock>,
  #[account(mut)] pub out: Account<'info, Out>,
}
#[account] pub struct Out { pub v: u64 }
`);
    expect(out).toContain("Clock::get()");
    expect(/unix_timestamp/.test(out)).toBe(true);
  });
});

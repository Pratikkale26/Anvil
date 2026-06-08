/**
 * G1/G2/G5 / #26 — #[derive(InitSpace)] synthesis must size variable-length
 * fields the way Anchor's derive does, or the allocated account buffer is
 * wrong (under-alloc → OOB write on the bigger value; over-alloc → divergent
 * rent).
 *
 * Anchor's Space impls:
 *   - Option<T>   = 1 (discriminant) + T::INIT_SPACE      (was: flat 32)
 *   - enum        = 1 (discriminant) + max(variant payload) (was: flat 1)
 *   - unit enum   = 1                                       (unchanged)
 *
 * The read/write paths already handle the variable on-disk encoding via Borsh;
 * only the synthesized INIT_SPACE / LEN constant was wrong.
 */
import { describe, test, expect } from "bun:test";
import { parseAnchor } from "../src/parser/anchor-parser.ts";
import { emitNativeFull } from "../src/emitter/native-emitter.ts";

async function initSpace(structName: string, extraTypes: string): Promise<number | null> {
  const src = `
use anchor_lang::prelude::*;
declare_id!("Counter111111111111111111111111111111111111");
#[program]
pub mod m { use super::*; pub fn go(ctx: Context<Go>) -> Result<()> { Ok(()) } }
#[derive(Accounts)]
pub struct Go<'info> {
  #[account(init, payer = payer, space = 8 + ${structName}::INIT_SPACE)]
  pub acct: Account<'info, ${structName}>,
  #[account(mut)] pub payer: Signer<'info>,
  pub system_program: Program<'info, System>,
}
${extraTypes}
`;
  const r = await parseAnchor(src);
  expect(r.ok).toBe(true);
  if (!r.ok) return null;
  const out = emitNativeFull(r.ir).singleFile;
  const idx = out.indexOf(`impl ${structName} `);
  const m = out.slice(idx, idx + 300).match(/INIT_SPACE: usize = (\d+)/);
  return m ? Number(m[1]) : null;
}

describe("G1/G2/G5 — InitSpace variable-length field sizing", () => {
  test("Option<T> sizes as 1 + T (not flat 32)", async () => {
    // owner(32) + Option<Pubkey>(33) + Option<i64>(9) + balance(8) + bump(1) = 83
    const n = await initSpace(
      "Vault",
      `#[account] #[derive(InitSpace)]
       pub struct Vault { pub owner: Pubkey, pub delegate: Option<Pubkey>, pub expiry: Option<i64>, pub balance: u64, pub bump: u8 }`,
    );
    expect(n).toBe(83);
  });

  test("Option<[u8; N]> sizes as 1 + N", async () => {
    // x(8) + Option<[u8;64]>(65) + Option<u64>(9) = 82
    const n = await initSpace(
      "Cfg",
      `#[account] #[derive(InitSpace)]
       pub struct Cfg { pub x: u64, pub p: Option<[u8; 64]>, pub q: Option<u64> }`,
    );
    expect(n).toBe(82);
  });

  test("data-carrying enum sizes as 1 + max(variant payload)", async () => {
    // amount(8) + Order[1 + max(Buy=8, Sell=0)=9] + owner(32) = 49
    const n = await initSpace(
      "State",
      `#[account] #[derive(InitSpace)]
       pub struct State { pub amount: u64, pub side: Order, pub owner: Pubkey }
       #[derive(AnchorSerialize, AnchorDeserialize, Clone, InitSpace)]
       pub enum Order { Buy { price: u64 }, Sell }`,
    );
    expect(n).toBe(49);
  });

  test("tuple-variant enum sizes by summed tuple payload", async () => {
    // a(8) + E[1 + max(Two=8+32=40, One=8, Unit=0)=41] = 49
    const n = await initSpace(
      "Holder",
      `#[account] #[derive(InitSpace)]
       pub struct Holder { pub a: u64, pub e: E }
       #[derive(AnchorSerialize, AnchorDeserialize, Clone, InitSpace)]
       pub enum E { One(u64), Two(u64, Pubkey), Unit }`,
    );
    expect(n).toBe(49);
  });

  test("unit-only enum stays a flat 1 byte", async () => {
    // a(8) + Status(1) = 9
    const n = await initSpace(
      "UnitOk",
      `#[account] #[derive(InitSpace)]
       pub struct UnitOk { pub a: u64, pub s: Status }
       #[derive(AnchorSerialize, AnchorDeserialize, Clone, InitSpace)]
       pub enum Status { Active, Inactive }`,
    );
    expect(n).toBe(9);
  });
});

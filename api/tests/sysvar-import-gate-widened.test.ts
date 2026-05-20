// Sysvar use-import gate regression — every text-carrying body kind must
// be scanned.
//
// Before this widening, the Clock/Rent gates only scanned `pass_through`
// and `state_field_assign` for `Clock::get()` / `Rent::get()` mentions.
// `emit!()` event field initializers (kind: "emit", text in .fields) and
// `msg!()` formatted args (kind: "msg") were missed. arjun-sol-vault hit
// this when its DepositEvent referenced Clock::get()?.unix_timestamp: the
// emitted lib.rs was missing `use solana_program::sysvar::clock::Clock`
// and cargo failed with "failed to resolve: use of undeclared type
// `Clock`".
//
// The widened gate uses a per-kind switch — bodyTextHasPattern(re) tests
// every kind whose IR fields carry user-written expression text. Adding
// a NEW such kind requires extending the switch.
import { describe, test, expect } from "bun:test";
import { parseAnchor } from "../src/parser/anchor-parser.ts";
import { emitPinocchioFull } from "../src/emitter/pinocchio-emitter.ts";
import { emitNativeFull } from "../src/emitter/native-emitter.ts";

const CLOCK_IN_EMIT_SRC = `use anchor_lang::prelude::*;
declare_id!("11111111111111111111111111111111");
#[program]
pub mod p {
    use super::*;
    pub fn touch(ctx: Context<F>) -> Result<()> {
        emit!(Tick { ts: Clock::get()?.unix_timestamp });
        Ok(())
    }
}
#[derive(Accounts)]
pub struct F {}
#[event]
pub struct Tick { pub ts: i64 }
`;

const RENT_IN_EMIT_SRC = `use anchor_lang::prelude::*;
declare_id!("11111111111111111111111111111111");
#[program]
pub mod p {
    use super::*;
    pub fn touch(ctx: Context<F>) -> Result<()> {
        emit!(Snap { lamports: Rent::get()?.minimum_balance(0) });
        Ok(())
    }
}
#[derive(Accounts)]
pub struct F {}
#[event]
pub struct Snap { pub lamports: u64 }
`;

async function emit(source: string, target: "pinocchio" | "native"): Promise<string> {
  const r = await parseAnchor(source);
  if (!r.ok) throw new Error(`parse failed: ${r.error}`);
  const out = target === "pinocchio" ? emitPinocchioFull(r.ir) : emitNativeFull(r.ir);
  return out.files.find((f) => f.path === "lib.rs")?.content ?? "";
}

describe("sysvar import gate scans all text-carrying body kinds", () => {
  test("native: Clock::get() inside emit! → use solana_program::sysvar::clock::Clock", async () => {
    const lib = await emit(CLOCK_IN_EMIT_SRC, "native");
    expect(lib).toContain("use solana_program::sysvar::clock::Clock;");
  });
  test("pinocchio: Clock::get() inside emit! → use pinocchio::sysvars::clock::Clock", async () => {
    const lib = await emit(CLOCK_IN_EMIT_SRC, "pinocchio");
    expect(lib).toContain("use pinocchio::sysvars::clock::Clock;");
  });
  test("native: Rent::get() inside emit! → use solana_program::sysvar::rent::Rent", async () => {
    const lib = await emit(RENT_IN_EMIT_SRC, "native");
    expect(lib).toContain("use solana_program::sysvar::rent::Rent;");
  });
  test("pinocchio: Rent::get() inside emit! → use pinocchio::sysvars::rent::Rent", async () => {
    const lib = await emit(RENT_IN_EMIT_SRC, "pinocchio");
    expect(lib).toContain("use pinocchio::sysvars::rent::Rent;");
  });
});

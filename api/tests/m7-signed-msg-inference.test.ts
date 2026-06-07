/**
 * H10 (sweep #4) — Pinocchio msg!() must not sign-corrupt negative integers.
 *
 * The formatted-msg type inference defaulted several ambiguous shapes to u64,
 * so a negative iN value routed through them emitted `u64_to_ascii(x as u64)`
 * → `delta = -1` printed as 18446744073709551615 (Pinocchio only; Native
 * keeps signed Display). Three fixes, none of which may regress the legit u64
 * cases that the existing vesting differential relies on:
 *   1. an explicit `: iN` let annotation is captured and wins (preserves sign)
 *   2. a leading-`-` unsuffixed numeric literal defaults to i64, not u64
 *   3. a bare fn-call return (type genuinely unknown) yields null → the caller
 *      falls back to the legacy literal-only collapse instead of guessing u64
 */
import { describe, test, expect } from "bun:test";
import { parseAnchor } from "../src/parser/anchor-parser.ts";
import {
  inferLocalLetTypes,
  lookupArgKind,
  buildFormatSegments,
} from "../src/emitter/m7-format-msg.ts";
import type { Instruction } from "../src/ir/schema.ts";

async function instrWith(args: string, body: string): Promise<Instruction> {
  const src = `
use anchor_lang::prelude::*;
declare_id!("Counter111111111111111111111111111111111111");
#[program]
pub mod m {
    use super::*;
    pub fn f(ctx: Context<F>${args ? ", " + args : ""}) -> Result<()> {
${body}
        Ok(())
    }
}
#[derive(Accounts)]
pub struct F<'info> { pub signer: Signer<'info> }
`;
  const r = await parseAnchor(src);
  expect(r.ok).toBe(true);
  if (!r.ok) throw new Error("parse failed");
  const ix = r.ir.instructions.find((i) => i.name === "f");
  if (!ix) throw new Error("instruction f not found");
  return ix;
}

describe("H10 — signed msg!() inference", () => {
  test("leading-minus unsuffixed literal resolves to i64, not u64", async () => {
    const ix = await instrWith("", `        msg!("x: {}", -5);`);
    expect(lookupArgKind("-5", ix)).toBe("i64");
    expect(lookupArgKind("5", ix)).toBe("u64");
    // suffix still wins over the sign default
    expect(lookupArgKind("-5i32", ix)).toBe("i32");
    expect(lookupArgKind("-5u64", ix)).toBe("u64");
  });

  test("explicit `: i64` let annotation is captured and preserves sign", async () => {
    const ix = await instrWith(
      "a: i64, b: i64",
      `        let delta: i64 = a.checked_sub(b).unwrap();
        msg!("delta: {}", delta);`,
    );
    const lets = inferLocalLetTypes(ix);
    expect(lets.get("delta")).toBe("i64");
  });

  test("explicit `: u32` annotation honored", async () => {
    const ix = await instrWith(
      "a: u32",
      `        let v: u32 = a + 1;
        msg!("v: {}", v);`,
    );
    expect(inferLocalLetTypes(ix).get("v")).toBe("u32");
  });

  test("bare fn-call return is no longer guessed u64 → null (legacy collapse)", async () => {
    const ix = await instrWith(
      "",
      `        let d = compute_thing();
        msg!("d: {}", d);`,
    );
    // d does not resolve → the msg!() arg can't be typed → buildFormatSegments
    // returns null → handler falls back to legacy collapse (no wrong value).
    expect(inferLocalLetTypes(ix).has("d")).toBe(false);
    expect(buildFormatSegments('"d: {}"', ["d"], ix)).toBeNull();
  });

  test("REGRESSION: unsigned checked-chain on an unresolved receiver stays u64", async () => {
    // Mirrors vesting's `unvested = vesting.total_amount.checked_sub(vested)?`
    // — the receiver head (`acct`) is an account, not an ix arg / known let,
    // so it falls to the u64 default. This must stay u64 (the value IS a u64;
    // the existing vesting differential depends on it being displayed).
    const ix = await instrWith(
      "",
      `        let total = ctx.accounts.signer.lamports();
        let unvested = total.checked_sub(0).unwrap();
        msg!("u: {}", unvested);`,
    );
    // `total` resolves via a method call (lamports) → not typed; `unvested`'s
    // receiver `total` is a known-but-untyped let, so the checked-chain falls
    // to the u64 default rather than null.
    expect(inferLocalLetTypes(ix).get("unvested")).toBe("u64");
  });
});

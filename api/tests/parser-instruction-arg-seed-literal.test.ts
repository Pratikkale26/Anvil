/**
 * #[instruction(...)] arg-name reconciliation must not corrupt byte-string seeds.
 *
 * When the `#[instruction(id: u64)]` attribute name differs from the handler's
 * parameter name, the parser renames `id` -> the handler name everywhere it
 * appears in seeds/constraints (so `id.to_le_bytes()` resolves to the real
 * arg). Pre-fix that rename ran `text.replace(/\bid\b/g, ...)` over the FULL
 * seed text, so it also fired *inside* the literal `b"id"` (the `"` is a
 * non-word char, putting a \b boundary between `"` and `i`) -> `b"identifier"`
 * / `b"_id"`, a corrupted seed prefix and thus a different derived PDA.
 *
 * Fix: rename only the text *between* string/byte-string/char literals.
 */
import { describe, test, expect } from "bun:test";
import { parseAnchor } from "../src/parser/anchor-parser.ts";

const SRC = (handlerArg: string) => `
use anchor_lang::prelude::*;
declare_id!("Counter111111111111111111111111111111111111");
#[program]
pub mod h7 {
    use super::*;
    pub fn create(ctx: Context<Create>, ${handlerArg}: u64) -> Result<()> { Ok(()) }
}
#[derive(Accounts)]
#[instruction(id: u64)]
pub struct Create<'info> {
    #[account(init, payer = payer, space = 8 + 8,
        seeds = [b"id", id.to_le_bytes().as_ref()], bump)]
    pub thing: Account<'info, Thing>,
    #[account(mut)] pub payer: Signer<'info>,
    pub system_program: Program<'info, System>,
}
#[account] pub struct Thing { pub v: u64 }
`;

async function seedsFor(handlerArg: string): Promise<string[]> {
  const r = await parseAnchor(SRC(handlerArg));
  expect(r.ok).toBe(true);
  if (!r.ok) throw new Error("parse failed");
  const acct = r.ir.instructions
    .find((i) => i.name === "create")
    ?.accounts.find((a) => a.name === "thing");
  return acct?.pdaSeeds ?? [];
}

describe("#[instruction] arg rename preserves byte-string seed literals", () => {
  test("renamed arg: b\"id\" literal stays intact, bare id is renamed", async () => {
    const seeds = await seedsFor("identifier");
    // literal seed prefix must be byte-for-byte unchanged
    expect(seeds.some((s) => s.includes('b"id"'))).toBe(true);
    expect(seeds.some((s) => s.includes('b"identifier"'))).toBe(false);
    expect(seeds.some((s) => s.includes('b"_id"'))).toBe(false);
    // the bare arg reference must be renamed to the handler param
    expect(seeds.some((s) => s.includes("identifier.to_le_bytes"))).toBe(true);
    expect(seeds.some((s) => /\bid\.to_le_bytes/.test(s))).toBe(false);
  });

  test("prefix-rename arg (id -> _id): literal still intact", async () => {
    const seeds = await seedsFor("_id");
    expect(seeds.some((s) => s.includes('b"id"'))).toBe(true);
    expect(seeds.some((s) => s.includes('b"_id"'))).toBe(false);
    expect(seeds.some((s) => s.includes("_id.to_le_bytes"))).toBe(true);
  });

  test("matching arg name: seeds unchanged (no rename path)", async () => {
    const seeds = await seedsFor("id");
    expect(seeds.some((s) => s.includes('b"id"'))).toBe(true);
    expect(seeds.some((s) => s.includes("id.to_le_bytes"))).toBe(true);
  });
});

/**
 * Variable-length field deserialization shape gate.
 *
 * Pre-fix the emitter read String / Vec<T> account fields with a fixed
 * `data[offset..offset + size]` slice and advanced `offset` by that
 * fixed `size`. Since Borsh String / Vec are length-prefixed and the
 * account's actual on-chain payload is variable-length, this had two
 * latent bugs:
 *
 *   1. If the on-chain value was shorter than `size`, we slice
 *      OOB-reading whatever followed; offset advanced past valid data.
 *   2. If longer than `size`, Borsh truncated and the account state
 *      desynced for any subsequent field.
 *
 * Fix: pass an open-ended slice `&data[offset..]` to Borsh, let it
 * consume length-prefix + content, advance offset by exactly what
 * Borsh read.
 *
 * This test gates the SHAPE of the emitted read/write — not runtime
 * correctness against a real on-chain account, since none of the
 * demo-programs use String / Vec fields. The shape gate stops the
 * fixed-slice form from regressing back in.
 */
import { describe, test, expect } from "bun:test";
import { parseAnchor } from "../src/parser/anchor-parser.ts";
import { emitNativeFull } from "../src/emitter/native-emitter.ts";
import { emitPinocchioFull } from "../src/emitter/pinocchio-emitter.ts";

const SOURCE_WITH_VARLEN = `
use anchor_lang::prelude::*;

declare_id!("Var111111111111111111111111111111111111111");

#[program]
pub mod varlen_demo {
    use super::*;

    pub fn init(ctx: Context<Init>, name: String, tags: Vec<u8>) -> Result<()> {
        let acc = &mut ctx.accounts.profile;
        acc.name = name;
        acc.tags = tags;
        acc.score = 0;
        Ok(())
    }
}

#[derive(Accounts)]
#[instruction(name: String, tags: Vec<u8>)]
pub struct Init<'info> {
    #[account(init, payer = authority, space = 8 + 4 + 64 + 4 + 32 + 8)]
    pub profile: Account<'info, Profile>,
    #[account(mut)]
    pub authority: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[account]
pub struct Profile {
    pub name: String,
    pub tags: Vec<u8>,
    pub score: u64,
}
`;

describe("variable-length field emit", () => {
  test("native: String/Vec read uses open-ended slice + offset advance from Borsh consumption", async () => {
    const parsed = await parseAnchor(SOURCE_WITH_VARLEN);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const out = emitNativeFull(parsed.ir);
    const text = out.files.map((f) => f.content).join("\n");

    // Open-ended read pattern: NO `offset + ${size}` upper bound.
    // The read() function aliases `data` to `__data_buf` to dodge field-
    // name shadowing (e.g. a field named `data` would shadow the param).
    expect(text).toMatch(/let mut name_bytes:\s*&\[u8\]\s*=\s*&__data_buf\[offset\.\.\];/);
    expect(text).toMatch(/let __name_before\s*=\s*name_bytes\.len\(\);/);
    expect(text).toMatch(/offset\s*\+=\s*__name_before\s*-\s*name_bytes\.len\(\);/);

    expect(text).toMatch(/let mut tags_bytes:\s*&\[u8\]\s*=\s*&__data_buf\[offset\.\.\];/);
    expect(text).toMatch(/let __tags_before\s*=\s*tags_bytes\.len\(\);/);
    expect(text).toMatch(/offset\s*\+=\s*__tags_before\s*-\s*tags_bytes\.len\(\);/);

    // Negative: must NOT contain the old fixed-slice form for these fields.
    // Pre-fix shape was:  &__data_buf[offset..offset + 64]; offset += 64;
    expect(text).not.toMatch(/&__data_buf\[offset\.\.offset\s*\+\s*64\];[\s\S]{0,80}name:/);
  });

  test("native: String/Vec write serializes through to_vec + copies actual byte count", async () => {
    const parsed = await parseAnchor(SOURCE_WITH_VARLEN);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const out = emitNativeFull(parsed.ir);
    const text = out.files.map((f) => f.content).join("\n");

    expect(text).toMatch(/let __name_serialized\s*=\s*::borsh::to_vec\(&value\.name\)/);
    expect(text).toMatch(/__data_buf\[offset\.\.offset\s*\+\s*__name_serialized\.len\(\)\]\.copy_from_slice\(&__name_serialized\);/);
    expect(text).toMatch(/offset\s*\+=\s*__name_serialized\.len\(\);/);

    expect(text).toMatch(/let __tags_serialized\s*=\s*::borsh::to_vec\(&value\.tags\)/);
    expect(text).toMatch(/offset\s*\+=\s*__tags_serialized\.len\(\);/);
  });

  test("pinocchio: String/Vec emit follows the same variable-length shape", async () => {
    const parsed = await parseAnchor(SOURCE_WITH_VARLEN);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const out = emitPinocchioFull(parsed.ir);
    const text = out.files.map((f) => f.content).join("\n");

    expect(text).toMatch(/let mut name_bytes:\s*&\[u8\]\s*=\s*&__data_buf\[offset\.\.\];/);
    expect(text).toMatch(/offset\s*\+=\s*__name_before\s*-\s*name_bytes\.len\(\);/);
    expect(text).toMatch(/let __name_serialized\s*=\s*::borsh::to_vec\(&value\.name\)/);
    expect(text).toMatch(/offset\s*\+=\s*__name_serialized\.len\(\);/);
  });
});

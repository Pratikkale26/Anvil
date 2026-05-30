/**
 * Loud-degradation gate (task #19): `LazyAccount<'info, T>` reaches the
 * zero-copy `.load()/.load_mut()/.load_init()` handlers because it shares that
 * syntax with `AccountLoader`. But T is a Borsh `#[account]` struct, not a
 * bytemuck Pod — the pre-#19 emit produced `bytemuck::from_bytes::<T>(...)`,
 * which fails `E0277` (`T: AnyBitPattern` unsatisfied): loud, but misleading
 * (the user blames their struct, not the unsupported wrapper). Confirmed
 * empirically before this change.
 *
 * Now the three whole-struct load variants emit a marked, non-functional stub
 * (`// ⚠️ Anvil … not yet supported` + `unimplemented!("anvil: …")`) that the
 * output-validator surfaces as an error — same loud-degradation contract as the
 * AccountLoader / carried-helper stubs. Per-field `load_<field>()` accessors are
 * NOT classified through these handlers, so they stay out of scope here.
 */
import { describe, test, expect } from "bun:test";
import { parseAnchor } from "../src/parser/anchor-parser.ts";
import { emitPinocchioFull } from "../src/emitter/pinocchio-emitter.ts";
import { emitNativeFull } from "../src/emitter/native-emitter.ts";
import { validateEmitterOutput } from "../src/emitter/output-validator.ts";

// Whole-struct LazyAccount touching all three load variants. `Data` is a plain
// Borsh `#[account]` struct (NOT `#[account(zero_copy)]`).
const LAZY_SRC = `use anchor_lang::prelude::*;
declare_id!("Lazy11111111111111111111111111111111111111");
#[program]
pub mod m {
    use super::*;
    pub fn init(ctx: Context<Touch>) -> Result<()> {
        let mut s = ctx.accounts.state.load_init()?;
        s.value = 1;
        Ok(())
    }
    pub fn touch(ctx: Context<Touch>) -> Result<()> {
        let mut s = ctx.accounts.state.load_mut()?;
        s.value = 7;
        Ok(())
    }
    pub fn read(ctx: Context<Touch>) -> Result<()> {
        let s = ctx.accounts.state.load()?;
        msg!("{}", s.value);
        Ok(())
    }
}
#[derive(Accounts)]
pub struct Touch<'info> {
    #[account(mut)]
    pub state: LazyAccount<'info, Data>,
    pub signer: Signer<'info>,
}
#[account]
pub struct Data { pub value: u64 }
`;

// Control: a real zero-copy AccountLoader<#[account(zero_copy)] Data>. The Pod
// cast IS correct here — the LazyAccount gate must NOT bleed into this path.
const LOADER_SRC = `use anchor_lang::prelude::*;
declare_id!("Loader111111111111111111111111111111111111");
#[program]
pub mod m {
    use super::*;
    pub fn touch(ctx: Context<Touch>) -> Result<()> {
        let mut s = ctx.accounts.state.load_mut()?;
        s.value = 7;
        Ok(())
    }
}
#[derive(Accounts)]
pub struct Touch<'info> {
    #[account(mut)]
    pub state: AccountLoader<'info, Data>,
    pub signer: Signer<'info>,
}
#[account(zero_copy)]
pub struct Data { pub value: u64 }
`;

describe("LazyAccount .load*() refuses loudly (task #19)", () => {
  test("parser flags the LazyAccount field with isLazy", async () => {
    const r = await parseAnchor(LAZY_SRC);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const refs = r.ir.instructions.flatMap((i) => i.accounts).filter((a) => a.name === "state");
    expect(refs.length).toBeGreaterThan(0);
    for (const a of refs) expect(a.isLazy).toBe(true);
  });

  for (const [target, emit] of [
    ["pinocchio", emitPinocchioFull] as const,
    ["native", emitNativeFull] as const,
  ]) {
    test(`${target}: all three load variants emit a LOUD stub, not a Pod cast`, async () => {
      const r = await parseAnchor(LAZY_SRC);
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      const out = emit(r.ir);
      const text = out.files.map((f) => f.content).join("\n");

      // All three variants refuse loudly with the ⚠️ marker ...
      for (const v of ["load", "load_mut", "load_init"]) {
        expect(text).toMatch(new RegExp(`⚠️ Anvil: LazyAccount::${v} not yet supported`));
        expect(text).toContain(`unimplemented!("anvil: LazyAccount::${v} stub`);
      }
      // ... and the misleading Pod cast on the lazy account's Data is GONE.
      expect(text).not.toMatch(/bytemuck::from_bytes(_mut)?\(&(?:mut )?__state_data/);
      // No interpolation leak.
      expect(text).not.toContain("${MARKER_ANVIL_PREFIX}");

      // The validator surfaces the stub as an ERROR (non-functional), not a
      // weak "review" — the cryptic-E0277 misclassification is now honest.
      const issues = validateEmitterOutput(r.ir, out);
      const err = issues.find(
        (i) => i.severity === "error" && /non-functional|not yet supported|manual port|stub/i.test(i.message),
      );
      expect(err).toBeDefined();
    });
  }

  test("bleed-guard: a real AccountLoader<zero_copy> still emits the Pod cast", async () => {
    const r = await parseAnchor(LOADER_SRC);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // isLazy must NOT be set on a genuine AccountLoader field.
    for (const a of r.ir.instructions.flatMap((i) => i.accounts).filter((a) => a.name === "state")) {
      expect(a.isLazy).toBeUndefined();
    }
    const out = emitPinocchioFull(r.ir);
    const text = out.files.map((f) => f.content).join("\n");
    // The zero-copy Pod cast path is unchanged ...
    expect(text).toMatch(/bytemuck::from_bytes_mut\(&mut __state_data/);
    // ... and no LazyAccount marker leaked in.
    expect(text).not.toMatch(/LazyAccount::load_mut not yet supported/);
  });
});

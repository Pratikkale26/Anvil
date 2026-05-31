/**
 * LazyAccount whole-struct load()/load_mut() (task #19).
 *
 * History: `LazyAccount<'info, T>` reaches the zero-copy `.load*()` handlers
 * because it shares that syntax with `AccountLoader`. The first #19 slice
 * (3a91242) made the mis-emitted bytemuck Pod cast refuse loudly. This slice
 * makes it actually WORK: `LazyAccount<T>` is Borsh-lazy (T is a Borsh
 * `#[account]` struct), so whole-struct `load()/load_mut()` is the *same* Borsh
 * deserialize the mutable `Account<T>` path already emits — `T::from_account_info`
 * + the existing `state_field_assign` write-back (`T::save`). So the lazy handlers
 * now reuse `ensureStateReadStructural` (guarded to generated `#[account]` types;
 * loud stub otherwise), giving load_mut for free with no new write-back seam.
 *
 * Per-field `load_<field>()` accessors are NOT classified through these handlers
 * (the body-classifier regex matches only the bare words load/load_mut/load_init)
 * — still out of scope.
 */
import { describe, test, expect } from "bun:test";
import { parseAnchor } from "../src/parser/anchor-parser.ts";
import { emitPinocchioFull } from "../src/emitter/pinocchio-emitter.ts";
import { emitNativeFull } from "../src/emitter/native-emitter.ts";

// Whole-struct LazyAccount: load_mut (mutate → write-back) + load (read).
// `Data` is a plain Borsh `#[account]` struct (NOT `#[account(zero_copy)]`).
const LAZY_SRC = `use anchor_lang::prelude::*;
declare_id!("Lazy11111111111111111111111111111111111111");
#[program]
pub mod m {
    use super::*;
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
// cast IS correct here — the LazyAccount Borsh reroute must NOT bleed into it.
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

describe("LazyAccount .load*() emits a real Borsh deserialize (task #19)", () => {
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
    test(`${target}: load_mut → Borsh deserialize + write-back; load → deserialize`, async () => {
      const r = await parseAnchor(LAZY_SRC);
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      const out = emit(r.ir);
      const text = out.files.map((f) => f.content).join("\n");

      // load_mut() == the mutable Account<T> path: a Borsh deserialize binding
      // + a write-back driven by the downstream `s.value = 7` state_field_assign.
      // Pinocchio uses from_account_info/save; Native uses read/write — both are
      // the proven Account<T> mutation path for their target.
      expect(text).toMatch(/let mut s = Data::(from_account_info|read)\(/);
      expect(text).toMatch(/Data::(save|write)\(/);
      // load() == an immutable deserialize.
      expect(text).toMatch(/let s = Data::(from_account_info|read)\(/);

      // The misleading Pod cast and the loud stub are BOTH gone for the
      // whole-struct load path.
      expect(text).not.toMatch(/bytemuck::from_bytes(_mut)?\(&(?:mut )?__state_data/);
      expect(text).not.toContain('unimplemented!("anvil: LazyAccount::load');
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
    // ... and no Borsh deserialize leaked into the AccountLoader path.
    expect(text).not.toMatch(/Data::from_account_info/);
  });
});

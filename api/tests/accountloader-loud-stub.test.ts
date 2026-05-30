/**
 * Loud-degradation gate: the G89 `AccountLoader::load/load_mut/load_init`
 * stubs (emitted for zero-copy-state programs — raydium/kamino/drift/invariant)
 * return `unimplemented!()`. They COMPILE (the never-type coerces to any
 * expected Ref<T>/RefMut<T>) but PANIC at runtime. The stubs carried no
 * `⚠️ Anvil` marker, and the output-validator doesn't scan `unimplemented!()`,
 * so a program that loads zero-copy accounts was emitted with silently
 * non-functional `load()` calls. Surfaced scanning invariant-labs/protocol
 * (2026-05-30).
 *
 * The stub impl now carries the `⚠️ Anvil` marker so the validator surfaces it
 * as a non-functional stub — same loud-degradation contract as the
 * cpi_custom / carried-helper paths.
 */
import { describe, test, expect } from "bun:test";
import { parseAnchor } from "../src/parser/anchor-parser.ts";
import { emitPinocchioFull } from "../src/emitter/pinocchio-emitter.ts";
import { emitNativeFull } from "../src/emitter/native-emitter.ts";
import { validateEmitterOutput } from "../src/emitter/output-validator.ts";

const SRC = `use anchor_lang::prelude::*;
declare_id!("AccLoader1111111111111111111111111111111111");
#[program]
pub mod m {
    use super::*;
    pub fn go(ctx: Context<Go>) -> Result<()> {
        let _ = load_value(&ctx.accounts.state)?;
        Ok(())
    }
}
// A free helper carrying AccountLoader in its signature — survives into the
// emit (the zero-copy support can't absorb it), so the G89 AccountLoader
// load/load_mut/load_init stub is generated. This mirrors how real programs
// (invariant, raydium) hit the stub: \`fn admin(loader: &AccountLoader<State>)\`.
fn load_value(loader: &AccountLoader<Data>) -> Result<u64> {
    let d = loader.load()?;
    Ok(d.value)
}
#[derive(Accounts)]
pub struct Go<'info> {
    pub state: AccountLoader<'info, Data>,
    pub signer: Signer<'info>,
}
#[account(zero_copy)]
pub struct Data { pub value: u64 }
`;

describe("AccountLoader::load stub is LOUD (not silent)", () => {
  for (const [target, emit] of [
    ["pinocchio", emitPinocchioFull] as const,
    ["native", emitNativeFull] as const,
  ]) {
    test(`${target}: AccountLoader stub carries ⚠️ marker + validator surfaces it`, async () => {
      const r = await parseAnchor(SRC);
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      const out = emit(r.ir);
      const text = out.files.map((f) => f.content).join("\n");
      // The G89 stub is present ...
      expect(text).toMatch(/unimplemented!\("anvil: AccountLoader::load stub/);
      // ... and now LOUD: the ⚠️ Anvil marker names it, with no interpolation leak.
      expect(text).toMatch(/⚠️ Anvil: AccountLoader/);
      expect(text).not.toContain("${MARKER_ANVIL_PREFIX}");
      // ... and the validator surfaces it as an ERROR (non-functional stub),
      // not a weak "review" warning — the silent-stub gap closed.
      const issues = validateEmitterOutput(r.ir, out);
      const unsafe = issues.find((i) => i.severity === "error" && /unsafe-marker|non-functional/i.test(i.message));
      expect(unsafe).toBeDefined();
    });
  }
});

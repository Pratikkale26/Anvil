/**
 * Loud-degradation gate: a carried user helper whose body uses unsupported
 * patterns (AccountLoader::load, T::DISCRIMINATOR, Self{…}, etc.) is stubbed
 * with unimplemented!(). That stub used to be SILENT — no parser warning, and
 * the output-validator doesn't scan bare unimplemented!() — so a stubbed helper
 * (e.g. a merkle-proof `verify`) would compile but PANIC at runtime with no
 * signal to the user. Surfaced by jito-tip-distribution's `verify` helper
 * during real-world testing (2026-05-29).
 *
 * The stub now carries the `⚠️ Anvil` marker (which the output-validator flags
 * as a non-functional stub) + an emitter warning, mirroring the cpi_custom path.
 */
import { describe, test, expect } from "bun:test";
import { parseAnchor } from "../src/parser/anchor-parser.ts";
import { emitPinocchioFull } from "../src/emitter/pinocchio-emitter.ts";
import { emitNativeFull } from "../src/emitter/native-emitter.ts";
import { validateEmitterOutput } from "../src/emitter/output-validator.ts";

const SRC = `use anchor_lang::prelude::*;
declare_id!("CarriedHe1per11111111111111111111111111111");
#[program]
pub mod m {
    use super::*;
    pub fn go(ctx: Context<Go>) -> Result<()> {
        let _ = load_data(&ctx.accounts.signer.to_account_info());
        Ok(())
    }
}
// Free helper whose body uses an unsupported pattern (AccountLoader::load) —
// the emitter can't port it, so it must be stubbed (and the stub must be loud).
fn load_data(ai: &AccountInfo) -> u64 {
    let _l = AccountLoader::load(ai);
    7
}
#[derive(Accounts)]
pub struct Go<'info> { pub signer: Signer<'info> }
`;

describe("carried helper with unsupported body → LOUD stub (not silent)", () => {
  for (const [target, emit] of [
    ["pinocchio", emitPinocchioFull] as const,
    ["native", emitNativeFull] as const,
  ]) {
    test(`${target}: stub carries ⚠️ Anvil marker + validator surfaces it`, async () => {
      const r = await parseAnchor(SRC);
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      const out = emit(r.ir);
      const text = out.files.map((f) => f.content).join("\n");
      // (1) the helper IS stubbed (named) ...
      expect(text).toMatch(/unimplemented!\("Anvil: carried helper 'load_data'/);
      // (2) ... and the stub is LOUD: the ⚠️ Anvil marker names the helper ...
      expect(text).toMatch(/⚠️ Anvil.*helper 'load_data'/);
      // (3) ... and the output-validator surfaces it (the silent-stub gap closed).
      const issues = validateEmitterOutput(r.ir, out);
      expect(issues.some((i) => /load_data|unsafe-marker|unsupported patterns/i.test(i.message))).toBe(true);
    });
  }
});

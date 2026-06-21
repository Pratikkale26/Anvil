/**
 * #13 — an UNRESOLVABLE #[instruction(discriminator = <opaque>)] override is a
 * loud validator error (not a silent misroute).
 *
 * Anvil honors resolvable overrides (integer / byte-array / byte-string /
 * const-byte-array) via the variable-length router. An override it can't resolve
 * to bytes (opaque const, const fn) silently falls back to the default sha256
 * discriminator — the on-chain dispatch byte then diverges from Anchor. That
 * case now escalates the parser warning to a validator error so --strict refuses.
 * Resolvable overrides must stay clean (no over-refusal).
 */
import { describe, test, expect } from "bun:test";
import { parseAnchor } from "../src/parser/anchor-parser.ts";
import { emitNativeFull } from "../src/emitter/native-emitter.ts";
import { emitPinocchioFull } from "../src/emitter/pinocchio-emitter.ts";
import { validateEmitterOutput } from "../src/emitter/output-validator.ts";

const HEAD = `use anchor_lang::prelude::*;
declare_id!("11111111111111111111111111111111");
`;
const ACCOUNTS = `
#[derive(Accounts)]
pub struct Go<'info> { pub signer: Signer<'info> }
`;

const UNRESOLVABLE = `${HEAD}
const MY_DISC: u64 = 42;
#[program]
pub mod m {
    use super::*;
    #[instruction(discriminator = MY_DISC)]
    pub fn go(ctx: Context<Go>) -> Result<()> { Ok(()) }
}
${ACCOUNTS}`;

const RESOLVABLE = `${HEAD}
#[program]
pub mod m {
    use super::*;
    #[instruction(discriminator = 5)]
    pub fn go(ctx: Context<Go>) -> Result<()> { Ok(()) }
}
${ACCOUNTS}`;

const discErrors = (issues: { severity: string; message: string }[]) =>
  issues.filter((i) => i.severity === "error" && i.message.includes("instruction_discriminator_override_unsupported"));

describe("#13 — unresolvable instruction discriminator override is loud", () => {
  for (const [target, emit] of [
    ["native", emitNativeFull] as const,
    ["pinocchio", emitPinocchioFull] as const,
  ]) {
    test(`${target}: opaque-const discriminator override → validator ERROR`, async () => {
      const r = await parseAnchor(UNRESOLVABLE);
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(discErrors(validateEmitterOutput(r.ir, emit(r.ir))).length).toBeGreaterThan(0);
    });

    test(`${target}: resolvable (integer) discriminator override → NO error`, async () => {
      const r = await parseAnchor(RESOLVABLE);
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(discErrors(validateEmitterOutput(r.ir, emit(r.ir))).length).toBe(0);
    });
  }
});

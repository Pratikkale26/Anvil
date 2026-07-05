/**
 * #35 — declared-program-id entry check parity.
 *
 * Anchor's #[program] entry verifies `*program_id == ID` (the declare_id!
 * address) and reverts with 4100 DeclaredProgramIdMismatch otherwise. Anvil's
 * emit skipped this — a binary deployed at an address ≠ its declare_id! would
 * EXECUTE where Anchor refuses (surfaced by #34's cpi-lever-hand probe). The
 * emit now guards `process_instruction` with the same check (reverting via
 * IncorrectProgramId — byte-equal compares tx OUTCOMES, not error codes/logs,
 * so a revert-for-revert match is what parity needs).
 *
 * Only emitted when the IR carries a program id (declare_id! present); a
 * program without one is unchanged (no ID const to compare against).
 */
import { describe, test, expect } from "bun:test";
import { parseAnchor } from "../src/parser/anchor-parser.ts";
import { emitPinocchioFull } from "../src/emitter/pinocchio-emitter.ts";
import { emitNativeFull } from "../src/emitter/native-emitter.ts";

const WITH_ID = `
use anchor_lang::prelude::*;
declare_id!("Absfps8DboaQrCi71THcW4r1CuhrQLokx6DVufbnDmUZ");
#[program]
pub mod p {
    use super::*;
    pub fn ping(_ctx: Context<Ping>) -> Result<()> { Ok(()) }
}
#[derive(Accounts)]
pub struct Ping<'info> { pub signer: Signer<'info> }
`;

const NO_ID = `
use anchor_lang::prelude::*;
#[program]
pub mod p {
    use super::*;
    pub fn ping(_ctx: Context<Ping>) -> Result<()> { Ok(()) }
}
#[derive(Accounts)]
pub struct Ping<'info> { pub signer: Signer<'info> }
`;

async function emit(src: string) {
  const r = await parseAnchor(src);
  if (!r.ok) throw new Error(`parse failed: ${JSON.stringify(r)}`);
  return {
    pin: emitPinocchioFull(r.ir).files.map((f) => f.content).join("\n"),
    nat: emitNativeFull(r.ir).files.map((f) => f.content).join("\n"),
    programId: r.ir.programId,
  };
}

describe("#35 — process_instruction guards program_id against the declared ID", () => {
  test("with declare_id!: both targets reject a mismatched program id at entry", async () => {
    const { pin, nat, programId } = await emit(WITH_ID);
    expect(programId).toBeTruthy();
    for (const code of [pin, nat]) {
      // The guard sits in process_instruction, before the router dispatch,
      // and reverts on mismatch.
      expect(code).toMatch(/if\s+program_id\s*!=\s*&ID\s*\{[\s\S]*?return Err\(ProgramError::IncorrectProgramId\)/);
    }
  });

  test("without declare_id!: no ID guard (nothing to compare against)", async () => {
    const { pin, nat, programId } = await emit(NO_ID);
    expect(programId).toBeFalsy();
    for (const code of [pin, nat]) {
      expect(code).not.toContain("program_id != &ID");
    }
  });
});

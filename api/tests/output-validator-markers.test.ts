/**
 * Focused unit test for the unsafe-marker error patterns added to
 * output-validator.ts. Each test feeds a synthetic emit output that
 * contains exactly one of the markers and asserts the validator
 * surfaces an error (not just a warning) on the matching line.
 *
 * These are the markers that compile cleanly but silently misbehave on-
 * chain:
 *   - 0u8 /* TODO: decimals *\/   wrong decimals on Token-2022 transfer
 *   - // ⚠️ Anvil: ...           CPI/section stub requiring manual rebuild
 *   - TODO(manual)                explicit "manual rebuild" sentinel
 */
import { describe, it, expect } from "bun:test";
import { validateEmitterOutput } from "../src/emitter/output-validator.js";
import type { SolanaIR, EmitterFile } from "../src/ir/schema.js";

function fakeIr(name = "x"): SolanaIR {
  return {
    name,
    programId: "11111111111111111111111111111111",
    instructions: [],
    accounts: [],
    types: [],
    constants: [],
    errors: [],
    helperFns: [],
    imports: [],
    userTraitImpls: [],
    metadata: {
      sourceFramework: "anchor",
      sourceVersion: null,
      anvilVersion: "0.3.0",
      parsedAt: new Date().toISOString(),
    },
  };
}

function fakeOutput(content: string, path = "lib.rs"): {
  files: EmitterFile[];
  singleFile: string;
  warnings: string[];
} {
  return {
    files: [{ path, content }],
    singleFile: content,
    warnings: [],
  };
}

describe("output-validator unsafe-marker errors", () => {
  it("rejects 0u8 /* TODO: decimals */ fallback (silently-wrong on-chain)", () => {
    const code = `
pub fn transfer_x(_a: &AccountInfo) -> ProgramResult {
    spl_token_2022::instruction::transfer_checked(
        &spl_token_2022::id(),
        &Pubkey::default(),
        &Pubkey::default(),
        &Pubkey::default(),
        &Pubkey::default(),
        &[],
        100,
        0u8 /* TODO: decimals — could not infer from source; verify against the mint */,
    );
    Ok(())
}
`;
    const issues = validateEmitterOutput(fakeIr(), fakeOutput(code));
    const errs = issues.filter((i) => i.severity === "error");
    expect(errs.length).toBeGreaterThan(0);
    expect(errs.some((e) => e.message.includes("decimals fallback"))).toBe(true);
  });

  it("rejects // ⚠️ Anvil: CPI stub", () => {
    const code = `
pub fn x() -> ProgramResult {
    // ⚠️ Anvil: CPI to external program foo::bar — manual rebuild required
    Ok(())
}
`;
    const issues = validateEmitterOutput(fakeIr(), fakeOutput(code));
    const errs = issues.filter((i) => i.severity === "error");
    expect(errs.some((e) => e.message.includes("unsafe-marker"))).toBe(true);
  });

  it("classifies // ⚠️ Anvil: Review section banner as warning (code IS emitted, just flagged)", () => {
    const code = `
pub fn x() -> ProgramResult {
    // ⚠️ Anvil: Review this section — may need manual verification
    Ok(())
}
`;
    const issues = validateEmitterOutput(fakeIr(), fakeOutput(code));
    const errs = issues.filter((i) => i.severity === "error");
    const warns = issues.filter((i) => i.severity === "warning");
    expect(errs.length).toBe(0);
    expect(warns.some((w) => w.message.includes("review marker"))).toBe(true);
  });

  it("rejects // ⚠️ Anvil: ... manual rebuild required (broken-stub family)", () => {
    const code = `
pub fn x() -> ProgramResult {
    // ⚠️ Anvil: Metaplex create_metadata_accounts_v3 CPI — manual rebuild required
    Ok(())
}
`;
    const issues = validateEmitterOutput(fakeIr(), fakeOutput(code));
    const errs = issues.filter((i) => i.severity === "error");
    expect(errs.some((e) => e.message.includes("manual rebuild"))).toBe(true);
  });

  it("rejects TODO(manual) sentinel", () => {
    const code = `
pub fn x() -> ProgramResult {
    let _x = 0; // TODO(manual): rebuild this CPI
    Ok(())
}
`;
    const issues = validateEmitterOutput(fakeIr(), fakeOutput(code));
    const errs = issues.filter((i) => i.severity === "error");
    expect(errs.some((e) => e.message.includes("TODO(manual)"))).toBe(true);
  });

  it("does NOT flag clean output (no markers, no Anchor leakage)", () => {
    const code = `
use solana_program::{account_info::AccountInfo, entrypoint::ProgramResult};
pub fn x(_a: &[AccountInfo]) -> ProgramResult { Ok(()) }
`;
    const issues = validateEmitterOutput(fakeIr(), fakeOutput(code));
    const errs = issues.filter((i) => i.severity === "error");
    expect(errs.length).toBe(0);
  });
});

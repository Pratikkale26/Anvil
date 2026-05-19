/**
 * S8 — programId source resolution for /build/differential.
 *
 * Pre-fix the route's resolution chain ended with the SystemProgram
 * placeholder ("11111111111111111111111111111111") if every source was
 * missing, silently running the scenario against the wrong program.
 * PDA derivation + token mint authority checks would then fail in
 * non-obvious ways, eating a quota slot per attempt.
 *
 * resolveProgramIdSource is the pure helper extracted from the route:
 * - returns the first non-empty source by priority (body > scenario > IR > declare_id!)
 * - returns undefined when nothing is set, so the route can refuse 400
 *   loudly instead of silently defaulting
 */
import { describe, test, expect } from "bun:test";
import { resolveProgramIdSource } from "../src/routes/differential.ts";

describe("S8 — resolveProgramIdSource", () => {
  test("returns programIdBase58 when set", () => {
    const got = resolveProgramIdSource({
      programIdBase58: "Abc123",
      scenarioProgramId: "ScenarioOne",
      irProgramId: "IrOne",
      anchorSource: 'declare_id!("DeclaredOne");',
    });
    expect(got).toBe("Abc123");
  });

  test("falls to scenario.programId when programIdBase58 unset", () => {
    const got = resolveProgramIdSource({
      scenarioProgramId: "ScenarioTwo",
      irProgramId: "IrTwo",
      anchorSource: 'declare_id!("DeclaredTwo");',
    });
    expect(got).toBe("ScenarioTwo");
  });

  test("falls to ir.programId when scenario unset", () => {
    const got = resolveProgramIdSource({
      irProgramId: "IrThree",
      anchorSource: 'declare_id!("DeclaredThree");',
    });
    expect(got).toBe("IrThree");
  });

  test("falls to declare_id! extracted from anchorSource", () => {
    const got = resolveProgramIdSource({
      anchorSource: 'use anchor_lang::prelude::*;\n\ndeclare_id!("DeclaredFour");\n',
    });
    expect(got).toBe("DeclaredFour");
  });

  test("returns undefined when no source resolves (S8 refusal trigger)", () => {
    const got = resolveProgramIdSource({
      anchorSource: "// no declare_id here",
    });
    expect(got).toBeUndefined();
  });

  test("returns undefined for empty anchorSource without declare_id", () => {
    const got = resolveProgramIdSource({ anchorSource: "" });
    expect(got).toBeUndefined();
  });

  test("undefined fields skip cleanly to next source", () => {
    const got = resolveProgramIdSource({
      programIdBase58: undefined,
      scenarioProgramId: undefined,
      irProgramId: undefined,
      anchorSource: 'declare_id!("Fallback");',
    });
    expect(got).toBe("Fallback");
  });

  test("empty-string programIdBase58 is treated as missing (NOT silently used)", () => {
    // Empty string is falsy; the route shouldn't pass it through to
    // PublicKey constructor which would throw. The fix uses `??` so
    // technically empty string slips — but the regex in RequestSchema
    // already rejects empty/short base58. Verify the helper falls
    // through anyway for defense in depth.
    const got = resolveProgramIdSource({
      programIdBase58: "",
      irProgramId: "IrFallback",
      anchorSource: "",
    });
    expect(got).toBe("IrFallback");
  });

  test("malformed declare_id! (no value) returns undefined", () => {
    const got = resolveProgramIdSource({
      anchorSource: "declare_id!();",
    });
    expect(got).toBeUndefined();
  });
});

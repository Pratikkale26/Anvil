/**
 * #27 — `anvil advise` target recommendation. Tests the pure analyzer
 * (adviseTarget) that scores Pinocchio vs Native from the parsed IR + source.
 * Anvil emits both byte-equal, so this is a deploy preference, not correctness.
 */
import { describe, test, expect } from "bun:test";
import { adviseTarget } from "./anvil.ts";
import type { SolanaIR } from "../api/src/ir/schema.js";

// Hand-built IRs — adviseTarget only reads instructions[].{accounts[].name,
// body[].kind}, types, imports, so a structural cast is enough (no schema.parse).
const ix = (name: string, body: Array<{ kind: string }> = []) =>
  ({ name, args: [], accounts: [], body, bodyLocs: [] });
const mkIr = (o: Partial<SolanaIR>): SolanaIR =>
  ({ name: "p", instructions: [], types: [], imports: [], ...o } as unknown as SolanaIR);

describe("adviseTarget (#27)", () => {
  test("small, CPI-free program leans pinocchio (CU + size win)", () => {
    const r = adviseTarget(mkIr({ instructions: [ix("initialize"), ix("increment")] }), "pub fn increment() {}");
    expect(r.lean).toBe("pinocchio");
    expect(r.pinocchioScore).toBeGreaterThan(r.nativeScore);
    expect(r.signals.cpiCount).toBe(0);
  });

  test("Metaplex usage leans native", () => {
    const src = "use mpl_token_metadata::instructions::CreateV1;";
    const r = adviseTarget(mkIr({ instructions: [ix("mint")] }), src);
    expect(r.signals.usesMetaplex).toBe(true);
    expect(r.lean).toBe("native");
    expect(r.nativeScore).toBeGreaterThan(r.pinocchioScore);
  });

  test("large + custom-CPI-heavy program leans native", () => {
    const instructions = [
      ix("a", [{ kind: "cpi_custom" }, { kind: "cpi_custom" }, { kind: "cpi_custom" }]),
      ...Array.from({ length: 9 }, (_, i) => ix(`ix${i}`)),
    ];
    const r = adviseTarget(mkIr({ instructions }), "pub fn a() {}");
    expect(r.signals.customCpiCount).toBe(3);
    expect(r.signals.ixCount).toBe(10);
    expect(r.lean).toBe("native");
  });

  test("returns transparent reasons + the caveat is the command's job", () => {
    const r = adviseTarget(mkIr({ instructions: [ix("go")] }), "pub fn go() {}");
    expect(Array.isArray(r.reasons)).toBe(true);
    expect(r.reasons.length).toBeGreaterThan(0);
  });
});

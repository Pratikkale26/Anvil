/**
 * #27 — /emit cost cap (routes/emit-cost-cap.ts). The shared 8 MB body limit +
 * global per-IP rate limiter bound IR bytes + request rate; this bounds emit
 * COMPUTE so a pathological IR can't pin a worker. Generous caps — a normal
 * program passes; only adversarial instruction/statement counts trip it.
 */
import { describe, test, expect } from "bun:test";
import {
  emitCostCap,
  MAX_EMIT_INSTRUCTIONS,
  MAX_EMIT_BODY_STATEMENTS,
} from "../src/routes/emit-cost-cap.ts";
import type { SolanaIR } from "../src/ir/schema.ts";

function irWith(instructionCount: number, bodyPerIx: number): SolanaIR {
  const body = Array.from({ length: bodyPerIx }, () => ({ kind: "return_ok" as const }));
  return {
    name: "t",
    instructions: Array.from({ length: instructionCount }, (_, i) => ({
      name: `ix${i}`,
      accounts: [],
      args: [],
      body: body.slice(),
    })),
    accounts: [],
    warnings: [],
  } as unknown as SolanaIR;
}

describe("#27 — emit cost cap", () => {
  test("a normal program is well under the caps (not over)", () => {
    const v = emitCostCap(irWith(20, 50)); // 20 ix, 1000 statements
    expect(v.over).toBe(false);
    expect(v.instructions).toBe(20);
    expect(v.bodyStatements).toBe(1000);
  });

  test("exceeding the instruction cap trips it", () => {
    const v = emitCostCap(irWith(MAX_EMIT_INSTRUCTIONS + 1, 0));
    expect(v.over).toBe(true);
    expect(v.instructions).toBe(MAX_EMIT_INSTRUCTIONS + 1);
  });

  test("exceeding the body-statement cap trips it (few instructions, huge bodies)", () => {
    // 2 instructions, each with > half the cap of body statements
    const v = emitCostCap(irWith(2, Math.ceil(MAX_EMIT_BODY_STATEMENTS / 2) + 1));
    expect(v.over).toBe(true);
    expect(v.bodyStatements).toBeGreaterThan(MAX_EMIT_BODY_STATEMENTS);
  });

  test("exactly at the caps is allowed (boundary)", () => {
    expect(emitCostCap(irWith(MAX_EMIT_INSTRUCTIONS, 0)).over).toBe(false);
  });

  test("the largest realistic program (100 ix × 200 stmts = 20k) passes", () => {
    expect(emitCostCap(irWith(100, 200)).over).toBe(false);
  });
});

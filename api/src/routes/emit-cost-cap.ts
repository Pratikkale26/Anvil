/**
 * #27 — /emit cost cap. The shared `express.json({ limit: "8mb" })` bounds the
 * IR's BYTES, and the global per-IP token bucket bounds request RATE — but
 * neither bounds emit COMPUTE, which is roughly O(instruction count × body
 * size). A pathological IR (tens of thousands of trivial instructions, or
 * deeply-populated bodies) can fit well under 8 MB yet pin an emit worker.
 * Mirror /parse's O(source) memory guard (routes/parse.ts, 5 MB → 413) with an
 * O(emit-work) guard here. Bounds are GENEROUS: the largest real Anchor
 * programs (cohort: marginfi/raydium/kamino) are ~100 instructions and a few
 * thousand body statements, an order of magnitude under these caps, so no
 * legitimate program is ever rejected.
 */
import type { SolanaIR } from "../ir/schema.js";

export const MAX_EMIT_INSTRUCTIONS = 512;
export const MAX_EMIT_BODY_STATEMENTS = 50_000;

export interface EmitCostVerdict {
  over: boolean;
  instructions: number;
  bodyStatements: number;
}

/** Pure check: does this IR exceed the emit-cost caps? */
export function emitCostCap(ir: SolanaIR): EmitCostVerdict {
  const instructions = ir.instructions.length;
  let bodyStatements = 0;
  for (const ix of ir.instructions) bodyStatements += ix.body?.length ?? 0;
  return {
    over: instructions > MAX_EMIT_INSTRUCTIONS || bodyStatements > MAX_EMIT_BODY_STATEMENTS,
    instructions,
    bodyStatements,
  };
}

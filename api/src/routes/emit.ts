import { Router } from "express";
import type { SolanaIR } from "../ir/schema.js";

export const emitRoute = Router();

/**
 * POST /emit
 * Body: { ir: SolanaIR, target: "pinocchio" | "quasar" | "native" }
 * Returns: { code: string, cu: CUEstimate[] }
 *
 * NOTE: Full emitters are implemented in Phase 2.
 * This stub validates input and returns a placeholder so Phase 1 wiring works end-to-end.
 */
emitRoute.post("/", (req, res) => {
  const { ir, target } = req.body as {
    ir?: SolanaIR;
    target?: string;
  };

  if (!ir || typeof ir !== "object") {
    res.status(400).json({ error: "Missing required field: ir (SolanaIR object)" });
    return;
  }

  const validTargets = ["pinocchio", "quasar", "native"];
  if (!target || !validTargets.includes(target)) {
    res.status(400).json({
      error: `Invalid target. Must be one of: ${validTargets.join(", ")}`,
    });
    return;
  }

  // Phase 2 will replace this with real emitters.
  // For now, return a placeholder so the web app can be wired up in Phase 3.
  const placeholder = `// Anvil — ${target} emission coming in Phase 2\n// Program: ${ir.name}\n// Instructions: ${ir.instructions.map((i: { name: string }) => i.name).join(", ")}\n\n// This will contain the full ${target} implementation.\n// The IR has been parsed successfully — all ${ir.instructions.length} instructions detected.`;

  res.json({
    code: placeholder,
    cu: ir.metadata.cuEstimates ?? [],
    target,
    programName: ir.name,
  });
});

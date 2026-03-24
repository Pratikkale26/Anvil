import { Router } from "express";
import { SolanaIRSchema, type SolanaIR } from "../ir/schema.js";
import { emitPinocchio } from "../emitter/pinocchio-emitter.js";
import { emitQuasar } from "../emitter/quasar-emitter.js";
import { emitNative } from "../emitter/native-emitter.js";
import { analyzeCU } from "../emitter/cu-analyzer.js";

export const emitRoute = Router();

/**
 * POST /emit
 * Body: { ir: SolanaIR, target: "pinocchio" | "quasar" | "native" }
 * Returns: { code: string, cu: CUEstimate[], target: string, programName: string }
 */
emitRoute.post("/", (req, res) => {
  const { ir: rawIr, target } = req.body as {
    ir?: unknown;
    target?: string;
  };

  if (!rawIr || typeof rawIr !== "object") {
    res.status(400).json({ error: "Missing required field: ir (SolanaIR object)" });
    return;
  }

  const validTargets = ["pinocchio", "quasar", "native"] as const;
  type Target = (typeof validTargets)[number];

  if (!target || !validTargets.includes(target as Target)) {
    res.status(400).json({
      error: `Invalid target. Must be one of: ${validTargets.join(", ")}`,
    });
    return;
  }

  // Validate the IR with Zod
  const parsed = SolanaIRSchema.safeParse(rawIr);
  if (!parsed.success) {
    res.status(422).json({
      error: "Invalid IR schema",
      details: parsed.error.message,
    });
    return;
  }

  const ir: SolanaIR = parsed.data;

  // Run the correct emitter
  let code: string;
  try {
    switch (target as Target) {
      case "pinocchio": code = emitPinocchio(ir); break;
      case "quasar":    code = emitQuasar(ir);    break;
      case "native":    code = emitNative(ir);     break;
    }
  } catch (e) {
    res.status(500).json({
      error: "Emit failed",
      details: e instanceof Error ? e.message : String(e),
    });
    return;
  }

  // Compute CU estimates
  // If fixture already has cuEstimates, use those (more accurate)
  // otherwise run the static analyzer
  const cu = ir.metadata.cuEstimates?.length
    ? ir.metadata.cuEstimates
    : analyzeCU(ir);

  res.json({
    code,
    cu,
    target,
    programName: ir.name,
    instructions: ir.instructions.length,
    accounts: ir.accounts.length,
  });
});

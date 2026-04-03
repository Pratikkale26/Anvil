import { Router } from "express";
import { SolanaIRSchema, type SolanaIR } from "../ir/schema.js";
import { emitPinocchio, emitPinocchioFull } from "../emitter/pinocchio-emitter.js";
import { emitQuasar, emitQuasarFull } from "../emitter/quasar-emitter.js";
import { emitNative, emitNativeFull } from "../emitter/native-emitter.js";
import { analyzeCU } from "../emitter/cu-analyzer.js";
import { validateEmitterOutput } from "../emitter/output-validator.js";

export const emitRoute = Router();

/**
 * POST /emit
 * Body: { ir: SolanaIR, target: "pinocchio" | "quasar" | "native", multiFile?: boolean, strict?: boolean }
 * Returns: {
 *   code: string,                  // single-file combined output (backward compat)
 *   files?: EmitterFile[],         // multi-file output (if multiFile=true)
 *   cu: CUEstimate[],
 *   target: string,
 *   programName: string,
 *   warnings: string[],            // any review warnings
 *   transformReport: {...},         // what was transformed vs passed through
 * }
 */
emitRoute.post("/", (req, res) => {
  const { ir: rawIr, target, multiFile } = req.body as {
    ir?: unknown;
    target?: string;
    multiFile?: boolean;
    strict?: boolean;
  };
  const strict = Boolean((req.body as { strict?: boolean }).strict);

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

  // Run the full emitter to get warnings + transform report
  try {
    const emitters = {
      pinocchio: emitPinocchioFull,
      quasar: emitQuasarFull,
      native: emitNativeFull,
    } as const;

    const emitter = emitters[target as Target];
    const output = emitter(ir);
    const validationIssues = validateEmitterOutput(ir, output);
    const validationErrors = validationIssues.filter((issue) => issue.severity === "error");
    const validationWarnings = validationIssues
      .filter((issue) => issue.severity === "warning")
      .map((issue) => issue.path ? `${issue.path}: ${issue.message}` : issue.message);

    if (strict && validationErrors.length > 0) {
      res.status(422).json({
        error: "Emit validation failed in strict mode",
        details: validationErrors.map((issue) =>
          issue.path ? `${issue.path}: ${issue.message}` : issue.message
        ),
        warnings: validationWarnings,
      });
      return;
    }

    // Compute CU estimates
    const cu = ir.metadata.cuEstimates?.length
      ? ir.metadata.cuEstimates
      : analyzeCU(ir);

    const response: Record<string, unknown> = {
      code: output.singleFile,
      cu,
      target,
      programName: ir.name,
      instructions: ir.instructions.length,
      accounts: ir.accounts.length,
      warnings: [...output.warnings, ...validationWarnings],
      transformReport: output.transformReport,
      validationIssues,
    };

    // Include multi-file output if requested
    if (multiFile) {
      response.files = output.files;
    }

    res.json(response);
  } catch (e) {
    res.status(500).json({
      error: "Emit failed",
      details: e instanceof Error ? e.message : String(e),
    });
  }
});

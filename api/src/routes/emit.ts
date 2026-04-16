import { Router } from "express";
import { SolanaIRSchema, type SolanaIR } from "../ir/schema.js";
import { emitPinocchio, emitPinocchioFull } from "../emitter/pinocchio-emitter.js";
import { emitQuasar, emitQuasarFull } from "../emitter/quasar-emitter.js";
import { emitNative, emitNativeFull } from "../emitter/native-emitter.js";
import { analyzeCU } from "../emitter/cu-analyzer.js";
import { validateEmitterOutput } from "../emitter/output-validator.js";
import { refineOutput } from "../ai/refine.js";
import { buildDeterministicReviewReport } from "../ai/review-report.js";

export const emitRoute = Router();

/**
 * POST /emit
 * Body: { ir: SolanaIR, target: "pinocchio" | "quasar" | "native", multiFile?: boolean, strict?: boolean }
 * Query: ?refine=1 — run single AI refine pass if validator finds issues
 * Returns: {
 *   code: string,                  // single-file combined output (backward compat)
 *   files?: EmitterFile[],         // multi-file output (if multiFile=true)
 *   cu: CUEstimate[],
 *   target: string,
 *   programName: string,
 *   warnings: string[],            // any review warnings
 *   transformReport: {...},         // what was transformed vs passed through
 *   validationIssues: [...],        // deterministic validation results
 *   reviewReport: {...},            // deterministic review findings + fix guidance
 *   refined?: boolean,             // true if AI refine was applied
 *   refineResult?: RefineResponse,  // details of AI refinement (if applied)
 * }
 */
emitRoute.post("/", async (req, res) => {
  const { ir: rawIr, target, multiFile } = req.body as {
    ir?: unknown;
    target?: string;
    multiFile?: boolean;
    strict?: boolean;
  };
  const strict = Boolean((req.body as { strict?: boolean }).strict);
  const refine = req.query.refine === "1";

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
    let validationIssues = validateEmitterOutput(ir, output);
    const validationErrors = validationIssues.filter((issue) => issue.severity === "error");
    const validationWarnings = validationIssues
      .filter((issue) => issue.severity === "warning")
      .map((issue) => issue.path ? `${issue.path}: ${issue.message}` : issue.message);
    let reviewReport = buildDeterministicReviewReport(validationIssues);

    if (strict && validationErrors.length > 0 && !refine) {
      res.status(422).json({
        error: "Emit validation failed in strict mode",
        details: validationErrors.map((issue) =>
          issue.path ? `${issue.path}: ${issue.message}` : issue.message
        ),
        warnings: validationWarnings,
        reviewReport,
      });
      return;
    }

    // Compute CU estimates
    const cu = ir.metadata.cuEstimates?.length
      ? ir.metadata.cuEstimates
      : analyzeCU(ir);

    // Current output state (may be refined below)
    let currentFiles = output.files;
    let currentSingleFile = output.singleFile;
    let refined = false;
    let refineResult = undefined;

    // ─── AI Refine (optional, single call) ─────────────────────────────────
    if (refine && validationErrors.length > 0) {
      try {
        console.log(`[emit][refine] ${validationErrors.length} validation errors found — running AI refine pass.`);
        const result = await refineOutput({
          target: target as Target,
          ir,
          files: output.files.length > 0
            ? output.files
            : [{ path: `${ir.name}.rs`, content: output.singleFile }],
          validationIssues,
        });

        // Apply accepted patches
        const acceptedPatches = result.patches.filter((p) => p.accepted);
        if (acceptedPatches.length > 0) {
          for (const patch of acceptedPatches) {
            currentFiles = currentFiles.map((f) =>
              f.path === patch.filePath ? { ...f, content: patch.patchedContent } : f
            );
            if (currentFiles.length <= 1) {
              currentSingleFile = patch.patchedContent;
            }
          }
          // Re-validate after patching
          validationIssues = validateEmitterOutput(ir, {
            files: currentFiles,
            singleFile: currentSingleFile,
            warnings: output.warnings,
          });
          reviewReport = buildDeterministicReviewReport(validationIssues);
          refined = true;
        }

        refineResult = result;
        console.log(`[emit][refine] ${acceptedPatches.length}/${result.patches.length} patches accepted.`);
      } catch (err) {
        console.error("[emit][refine] AI refine failed:", err instanceof Error ? err.message : String(err));
        // Non-fatal — return the unrefined output with a warning
        validationWarnings.push(`AI refine failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    const response: Record<string, unknown> = {
      code: currentSingleFile,
      cu,
      target,
      programName: ir.name,
      instructions: ir.instructions.length,
      accounts: ir.accounts.length,
      warnings: [...output.warnings, ...validationWarnings],
      transformReport: output.transformReport,
      validationIssues,
      reviewReport,
      refined,
      refineResult: refineResult ?? undefined,
    };

    // Include multi-file output if requested
    if (multiFile) {
      response.files = currentFiles;
    }

    res.json(response);
  } catch (e) {
    res.status(500).json({
      error: "Emit failed",
      details: e instanceof Error ? e.message : String(e),
    });
  }
});

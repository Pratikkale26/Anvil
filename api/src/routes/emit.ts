import { Router } from "express";
import { SolanaIRSchema, type SolanaIR } from "../ir/schema.js";
import { emitPinocchio, emitPinocchioFull } from "../emitter/pinocchio-emitter.js";
import { emitQuasar, emitQuasarFull } from "../emitter/quasar-emitter.js";
import { emitNative, emitNativeFull } from "../emitter/native-emitter.js";
import { analyzeCU } from "../emitter/cu-analyzer.js";
import { validateEmitterOutput } from "../emitter/output-validator.js";
import { refineOutput } from "../ai/refine.js";
import { buildDeterministicReviewReport } from "../ai/review-report.js";
import { AIError } from "../ai/errors.js";
import { AnvilError, ErrorCode } from "../errors.js";

export const emitRoute = Router();

/**
 * POST /emit — Emit target-framework Rust from SolanaIR
 *
 * Body: `{ ir: SolanaIR, target: "pinocchio" | "quasar" | "native", multiFile?: boolean, strict?: boolean }`
 * Query: `?refine=1` — run a single AI refine pass if the validator finds issues
 *
 * @returns
 * ```json
 * {
 *   "code": "string",
 *   "files": [{ "path": "lib.rs", "content": "..." }],
 *   "cu": [{ "instruction": "initialize", "anchor": 5000 }],
 *   "target": "pinocchio",
 *   "programName": "my_program",
 *   "warnings": [],
 *   "transformReport": { "transformedCount": 4, "passedThroughCount": 1, "details": [] },
 *   "validationIssues": [],
 *   "reviewReport": {},
 *   "refined": false
 * }
 * ```
 *
 * Error codes: 2000-2003
 *
 * @example
 * ```
 * // Request
 * POST /emit
 * Content-Type: application/json
 *
 * { "ir": { "name": "counter", ... }, "target": "pinocchio" }
 *
 * // Error (400)
 * { "error": "Missing required field: ir", "code": 2000 }
 * ```
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
    const err = new AnvilError(
      ErrorCode.INVALID_IR,
      "Missing required field: ir (SolanaIR object)",
    );
    res.status(err.statusCode).json(err.toJSON());
    return;
  }

  const validTargets = ["pinocchio", "quasar", "native"] as const;
  type Target = (typeof validTargets)[number];

  if (!target || !validTargets.includes(target as Target)) {
    const err = new AnvilError(
      ErrorCode.INVALID_TARGET,
      `Invalid target. Must be one of: ${validTargets.join(", ")}`,
    );
    res.status(err.statusCode).json(err.toJSON());
    return;
  }

  // Validate the IR with Zod
  const parsed = SolanaIRSchema.safeParse(rawIr);
  if (!parsed.success) {
    const err = new AnvilError(
      ErrorCode.INVALID_IR,
      "Invalid IR schema",
      parsed.error.message,
      422,
    );
    res.status(err.statusCode).json(err.toJSON());
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
    let reviewReport = buildDeterministicReviewReport(validationIssues, ir, target as Target);

    if (strict && validationErrors.length > 0 && !refine) {
      const err = new AnvilError(
        ErrorCode.VALIDATION_FAILED,
        "Emit validation failed in strict mode",
        validationErrors.map((issue) =>
          issue.path ? `${issue.path}: ${issue.message}` : issue.message
        ).join("; "),
        422,
      );
      res.status(err.statusCode).json({
        ...err.toJSON(),
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
    let refineError: { category: string; message: string } | undefined = undefined;

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
          reviewReport = buildDeterministicReviewReport(validationIssues, ir, target as Target);
          refined = true;
        }

        refineResult = result;
        console.log(`[emit][refine] ${acceptedPatches.length}/${result.patches.length} patches accepted.`);
      } catch (err) {
        console.error("[emit][refine] AI refine failed:", err instanceof Error ? err.message : String(err));
        // Non-fatal — return the unrefined output with a structured warning the
        // UI can render with the right call-to-action (configure key, retry, etc.).
        if (err instanceof AIError) {
          validationWarnings.push(`AI refine unavailable (${err.category}): ${err.message}`);
          refineError = { category: err.category, message: err.message };
        } else {
          const message = err instanceof Error ? err.message : String(err);
          validationWarnings.push(`AI refine failed: ${message}`);
          refineError = { category: "unknown", message };
        }
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
      refineError,
    };

    // Include multi-file output if requested
    if (multiFile) {
      response.files = currentFiles;
    }

    res.json(response);
  } catch (e) {
    const err = new AnvilError(
      ErrorCode.EMIT_FAILED,
      "Emit failed",
      e instanceof Error ? e.message : String(e),
      500,
    );
    res.status(err.statusCode).json(err.toJSON());
  }
});

import { Router } from "express";
import { SolanaIRSchema, type SolanaIR } from "../ir/schema.js";
import { emitPinocchio, emitPinocchioFull } from "../emitter/pinocchio-emitter.js";
import { emitQuasar, emitQuasarFull } from "../emitter/quasar-emitter.js";
import { emitNative, emitNativeFull } from "../emitter/native-emitter.js";
import { analyzeCU } from "../emitter/cu-analyzer.js";
import { validateEmitterOutput } from "../emitter/output-validator.js";
import { refineOutput } from "../ai/refine.js";
import { RejectedAttemptSchema, type RejectedAttempt } from "../ai/refine-schemas.js";
import { checkSpendCap, recordSpend } from "../ai/spend-tracker.js";
import { buildDeterministicReviewReport } from "../ai/review-report.js";
import { AIError } from "../ai/errors.js";
import { buildProjectScaffold } from "../emitter/project-scaffold.js";
import { AnvilError, ErrorCode } from "../errors.js";
import { metrics } from "../metrics.js";
import { z } from "zod";

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
    projectScaffold?: boolean;
  };
  const strict = Boolean((req.body as { strict?: boolean }).strict);
  const refine = req.query.refine === "1";
  // projectScaffold: when true the response includes Cargo.toml + README.md
  // + .gitignore + anvil-manifest.json, and the emitted .rs files are
  // rewritten to live under src/ so the whole thing is `cargo build`-able.
  const projectScaffold = Boolean((req.body as { projectScaffold?: boolean }).projectScaffold);

  // Optional retry-with-feedback: when the client is retrying after a prior
  // refine rejected one or more patches, they can forward those rejected
  // attempts so the model gets to see what went wrong and picks a different
  // approach. Bounded and validated — invalid shapes are just dropped.
  let previousAttempts: RejectedAttempt[] | undefined;
  const rawAttempts = (req.body as { previousAttempts?: unknown }).previousAttempts;
  if (Array.isArray(rawAttempts) && rawAttempts.length > 0) {
    const parsedAttempts = z.array(RejectedAttemptSchema).safeParse(rawAttempts);
    if (parsedAttempts.success) previousAttempts = parsedAttempts.data;
  }

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
    metrics.recordEmit(target, validationErrors.length);
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
      // Per-IP daily spend cap. Hit-cap path returns the deterministic emit
      // with a structured refineError so the caller doesn't lose their work.
      const callerIp = req.ip ?? req.socket.remoteAddress ?? "unknown";
      const spendCheck = checkSpendCap(callerIp);
      if (!spendCheck.allowed) {
        const message =
          spendCheck.reason ??
          `Daily AI spend cap of $${spendCheck.capUsd.toFixed(2)} per IP reached.`;
        console.warn(
          `[emit][refine] daily AI spend cap hit ip=${callerIp} todayUsd=${spendCheck.todayUsd.toFixed(4)} cap=${spendCheck.capUsd.toFixed(2)}`,
        );
        validationWarnings.push(`AI refine unavailable: ${message}`);
        refineError = { category: "daily_cap_hit", message };
        metrics.recordRefineError("daily_cap_hit");
        res.setHeader("Retry-After", String(spendCheck.retryAfterSec));
      } else try {
        const retryNote = previousAttempts ? ` (retry with ${previousAttempts.length} prior rejection(s))` : "";
        console.log(`[emit][refine] ${validationErrors.length} validation errors found — running AI refine pass${retryNote}.`);
        const result = await refineOutput({
          target: target as Target,
          ir,
          files: output.files.length > 0
            ? output.files
            : [{ path: `${ir.name}.rs`, content: output.singleFile }],
          validationIssues,
          previousAttempts,
        });

        // Cached calls cost $0 — record but don't move the budget needle.
        recordSpend(callerIp, result.cached ? 0 : (result.usage?.estimatedCostUsd ?? 0));

        // Apply accepted patches
        const acceptedPatches = result.patches.filter((p) => p.accepted);
        const rejectedCount = result.patches.length - acceptedPatches.length;
        metrics.recordRefineCall({
          cached: result.cached ?? false,
          accepted: acceptedPatches.length,
          rejected: rejectedCount,
        });
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
          metrics.recordRefineError(err.category);
        } else {
          const message = err instanceof Error ? err.message : String(err);
          validationWarnings.push(`AI refine failed: ${message}`);
          refineError = { category: "unknown", message };
          metrics.recordRefineError("unknown");
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

    // Include multi-file output if requested.
    //
    // multiFile alone → decomposed files for UI browsing (paths are bare,
    //   e.g., `lib.rs`, `state.rs`, `instructions/mod.rs`). Internal validate
    //   and refine pipelines operate on these paths, so refine patches stay
    //   aligned with what the UI shows.
    // multiFile + projectScaffold → a cargo-buildable project: every emitted
    //   source file is placed under `src/`, paired with the target-specific
    //   scaffold (Cargo.toml, README.md, .cargo/config.toml, rust-toolchain,
    //   deploy script, manifest). The decomposed multi-file Rust itself is
    //   what ships — post the `pub fn` visibility fixes in the emitter, the
    //   cross-module `use crate::helpers::*;` / `pub use instructions::*;`
    //   re-exports resolve cleanly, so users get a real modular project
    //   instead of a fat single lib.rs.
    if (multiFile) {
      if (projectScaffold) {
        const scaffold = buildProjectScaffold(ir, target as Target);
        const srcFiles = currentFiles.map((f) => ({
          path: `src/${f.path}`,
          content: f.content,
        }));
        response.files = [...scaffold, ...srcFiles];
        response.projectScaffold = true;
      } else {
        response.files = currentFiles;
      }
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

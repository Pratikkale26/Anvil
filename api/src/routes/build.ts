import { Router } from "express";
import { z } from "zod";
import { runBuild, type BuildTarget, type BuildFile, type BuildDiagnostic } from "../build/build-runner.js";
import { AnvilError, ErrorCode } from "../errors.js";
import { metrics } from "../metrics.js";
import { SolanaIRSchema, type SolanaIR } from "../ir/schema.js";
import { refineOutput } from "../ai/refine.js";
import { AIError } from "../ai/errors.js";
import type { ValidationIssue } from "../emitter/output-validator.js";

export const buildRoute = Router();

const BuildFileSchema = z.object({
  path: z.string().min(1).max(512),
  content: z.string().max(2_000_000), // 2 MB hard cap per file
});

const BuildRequestSchema = z.object({
  target: z.enum(["pinocchio", "native", "quasar"]),
  files: z.array(BuildFileSchema).min(1).max(64),
  programName: z.string().min(1).max(128),
});

const AutoFixRequestSchema = z.object({
  target: z.enum(["pinocchio", "native", "quasar"]),
  files: z.array(BuildFileSchema).min(1).max(64),
  programName: z.string().min(1).max(128),
  ir: z.unknown(), // validated below with SolanaIRSchema
  maxIterations: z.number().int().min(1).max(5).optional(),
  maxCostUsd: z.number().min(0).max(2).optional(),
});

/**
 * POST /build — Verify-build for already-emitted Rust.
 *
 * Body:
 *   {
 *     target: "pinocchio" | "native" | "quasar",
 *     files: [{ path: "lib.rs", content: "..." }, ...],
 *     programName: "my_program"
 *   }
 *
 * Response:
 *   {
 *     ok: boolean,
 *     durationMs: number,
 *     errors: [{ filePath, line, column, code, message, spanText }],
 *     warnings: [...same shape...],
 *     stderrTail: string
 *   }
 *
 * Backs the upcoming "Verify build" button in the workbench. Runs
 * `cargo check --message-format=json` against the supplied files in a
 * persistent per-target scratch dir so deps stay warm across calls.
 *
 * Quasar builds are unsupported (quasar-lang 0.0 is too early); the route
 * returns 422 with a clear message rather than attempting to spawn cargo.
 */
buildRoute.post("/", async (req, res) => {
  const parsed = BuildRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    const err = new AnvilError(
      ErrorCode.VALIDATION_FAILED,
      "Invalid /build request",
      parsed.error.message,
      400,
    );
    res.status(err.statusCode).json(err.toJSON());
    return;
  }

  const { target, files, programName } = parsed.data;

  try {
    const result = await runBuild(target as BuildTarget, files, programName);

    if (result.unsupported) {
      // Quasar today. 422 = the request was well-formed but the target
      // can't be acted on right now.
      metrics.recordBuild({ target, ok: false, durationMs: result.durationMs });
      res.status(422).json({
        ok: false,
        durationMs: result.durationMs,
        errors: result.errors,
        warnings: result.warnings,
        stderrTail: result.stderrTail,
        unsupported: result.unsupported,
      });
      return;
    }

    metrics.recordBuild({ target, ok: result.ok, durationMs: result.durationMs });
    res.json({
      ok: result.ok,
      durationMs: result.durationMs,
      errors: result.errors,
      warnings: result.warnings,
      stderrTail: result.stderrTail,
    });
  } catch (e) {
    const err = new AnvilError(
      ErrorCode.INTERNAL_ERROR,
      "Build runner failed",
      e instanceof Error ? e.message : String(e),
      500,
    );
    metrics.recordBuild({ target, ok: false, durationMs: 0 });
    res.status(err.statusCode).json(err.toJSON());
  }
});

/**
 * Convert one rustc diagnostic to the ValidationIssue shape the AI refine
 * pipeline expects. Strips the leading `src/` from filePath so it lines up
 * with the emitter's bare path keys (`lib.rs`, `state.rs`, `instructions/X.rs`).
 */
function diagnosticToValidationIssue(d: BuildDiagnostic): ValidationIssue {
  return {
    severity: "error",
    message: d.code ? `[${d.code}] ${d.message}` : d.message,
    path: d.filePath.replace(/^src\//, ""),
    line: d.line,
  };
}

/**
 * POST /build/auto-fix — verify-build with AI repair loop.
 *
 * For each iteration: cargo check → if errors, feed them as ValidationIssues
 * to refineOutput → apply accepted patches → cargo check again. Bounded by
 * maxIterations and maxCostUsd. Stops early on green build, no progress
 * (zero patches accepted), refine error, or budget exhaustion.
 *
 * The build endpoint files use `src/<rel>` paths; the refine pipeline uses
 * bare paths (`lib.rs`, `state.rs`). diagnosticToValidationIssue strips
 * the prefix; we add it back when applying patches.
 */
buildRoute.post("/auto-fix", async (req, res) => {
  const parsed = AutoFixRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    const err = new AnvilError(
      ErrorCode.VALIDATION_FAILED,
      "Invalid /build/auto-fix request",
      parsed.error.message,
      400,
    );
    res.status(err.statusCode).json(err.toJSON());
    return;
  }

  const irParsed = SolanaIRSchema.safeParse(parsed.data.ir);
  if (!irParsed.success) {
    const err = new AnvilError(
      ErrorCode.INVALID_IR,
      "Invalid IR in /build/auto-fix",
      irParsed.error.message,
      422,
    );
    res.status(err.statusCode).json(err.toJSON());
    return;
  }

  const { target, files: initialFiles, programName } = parsed.data;
  const ir: SolanaIR = irParsed.data;
  const maxIterations = parsed.data.maxIterations ?? 3;
  const maxCostUsd = parsed.data.maxCostUsd ?? 0.50;

  if (target === "quasar") {
    res.status(422).json({
      ok: false,
      stoppedReason: "unsupported_target",
      iterations: [],
      finalFiles: initialFiles,
      finalOk: false,
      totalDurationMs: 0,
      totalCostUsd: 0,
      message: "Quasar auto-fix is not supported; quasar-lang is too early for cargo check.",
    });
    return;
  }

  const t0 = Date.now();
  let currentFiles: BuildFile[] = [...initialFiles];
  let totalCostUsd = 0;
  type Iteration = {
    iteration: number;
    buildResult: { ok: boolean; durationMs: number; errors: BuildDiagnostic[]; warnings: BuildDiagnostic[] };
    refine?: { acceptedPatches: number; rejectedPatches: number; rationale: string; estimatedCostUsd: number };
    refineError?: { category: string; message: string };
  };
  const iterations: Iteration[] = [];
  let stoppedReason: "green" | "max_iterations" | "cost_cap" | "no_progress" | "refine_error" = "max_iterations";

  for (let i = 0; i < maxIterations; i++) {
    const buildRes = await runBuild(target as BuildTarget, currentFiles, programName);
    metrics.recordBuild({ target, ok: buildRes.ok, durationMs: buildRes.durationMs });

    const iter: Iteration = {
      iteration: i,
      buildResult: {
        ok: buildRes.ok,
        durationMs: buildRes.durationMs,
        errors: buildRes.errors,
        warnings: buildRes.warnings,
      },
    };
    iterations.push(iter);

    if (buildRes.ok) {
      stoppedReason = "green";
      break;
    }
    if (totalCostUsd >= maxCostUsd) {
      stoppedReason = "cost_cap";
      break;
    }

    // Strip the `src/` prefix so refine sees the bare paths it generated.
    const refineFiles = currentFiles.map((f) => ({
      path: f.path.replace(/^src\//, ""),
      content: f.content,
    }));
    const validationIssues = buildRes.errors.map(diagnosticToValidationIssue);

    try {
      const refineRes = await refineOutput({
        target: target as BuildTarget,
        ir,
        files: refineFiles,
        validationIssues,
        // These came from cargo check — flag so the prompt tells the model
        // to trust the file/line/code as ground truth (vs the heuristic
        // validator path, which can be noisier and is the prompt default).
        issueSource: "cargo",
      });

      const accepted = refineRes.patches.filter((p) => p.accepted);
      const rejected = refineRes.patches.length - accepted.length;
      iter.refine = {
        acceptedPatches: accepted.length,
        rejectedPatches: rejected,
        rationale: refineRes.rationale,
        estimatedCostUsd: refineRes.usage?.estimatedCostUsd ?? 0,
      };
      totalCostUsd += refineRes.usage?.estimatedCostUsd ?? 0;

      if (accepted.length === 0) {
        stoppedReason = "no_progress";
        break;
      }

      // Re-add `src/` prefix when reapplying patches to the build-side files.
      const acceptedByPath = new Map(accepted.map((p) => [p.filePath, p.patchedContent]));
      currentFiles = currentFiles.map((f) => {
        const stripped = f.path.replace(/^src\//, "");
        const patched = acceptedByPath.get(stripped);
        return patched != null ? { ...f, content: patched } : f;
      });
    } catch (err) {
      iter.refineError =
        err instanceof AIError
          ? { category: err.category, message: err.message }
          : { category: "unknown", message: err instanceof Error ? err.message : String(err) };
      stoppedReason = "refine_error";
      break;
    }
  }

  const lastIter = iterations[iterations.length - 1];
  const finalOk = !!lastIter?.buildResult.ok;
  const totalDurationMs = Date.now() - t0;

  res.json({
    ok: finalOk,
    stoppedReason,
    iterations,
    finalFiles: currentFiles,
    finalOk,
    totalDurationMs,
    totalCostUsd,
  });
});

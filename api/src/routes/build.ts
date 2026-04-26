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

  // Streaming mode: ?stream=1 → respond as text/event-stream, emit one SSE
  // event per phase (iteration-start, build-result, refine-start,
  // refine-result/refine-error, done). Detected here AFTER body validation
  // so a bad payload still gets a clean 400/422 JSON.
  const wantsStream = req.query.stream === "1" || req.query.stream === "true";

  if (target === "quasar") {
    // Symmetric across both modes — quasar is unsupported either way. For
    // the stream path we still emit a `done` event so clients have a clean
    // terminator, and use 422 in both cases.
    const payload = {
      ok: false,
      stoppedReason: "unsupported_target" as const,
      iterations: [],
      finalFiles: initialFiles,
      finalOk: false,
      totalDurationMs: 0,
      totalCostUsd: 0,
      message: "Quasar auto-fix is not supported; quasar-lang is too early for cargo check.",
    };
    if (wantsStream) {
      res.status(422);
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");
      res.flushHeaders();
      res.write(`event: done\ndata: ${JSON.stringify(payload)}\n\n`);
      res.end();
    } else {
      res.status(422).json(payload);
    }
    return;
  }

  // SSE writer when streaming, no-op otherwise. emit() runs after each
  // distinct phase so the client can render iteration cards in real time.
  if (wantsStream) {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders();
  }
  const emit = (type: string, data: unknown) => {
    if (!wantsStream) return;
    if (res.writableEnded) return;
    res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  // Best-effort client-disconnect detection. On Node the various close
  // signals (req.aborted, req.close, res.close) interact in surprising
  // ways with bun's HTTP client and can fire spuriously while the loop
  // is mid-iteration. We watch `req.aborted` instead — this only flips
  // true when the client side actually tears down the connection. If it
  // turns out unreliable in practice we just lose the early-bail-on-
  // disconnect optimization; the loop is bounded by maxIterations
  // anyway, so worst case we run one extra cargo check.
  let clientClosed = false;
  if (wantsStream) {
    req.on("aborted", () => {
      clientClosed = true;
    });
  }

  const t0 = Date.now();
  let currentFiles: BuildFile[] = [...initialFiles];
  let totalCostUsd = 0;
  // Revert-on-regression bookkeeping. Track the lowest-error state we've
  // seen so a refine round that strictly worsens the build can be rolled
  // back rather than committed. Mirrors sweep-realworld.ts behavior so the
  // production /build/auto-fix path inherits the same accept-gate semantics
  // as the offline sweep harness.
  let bestFiles: BuildFile[] = [...initialFiles];
  let bestErrorCount = Number.POSITIVE_INFINITY;
  type Iteration = {
    iteration: number;
    buildResult: { ok: boolean; durationMs: number; errors: BuildDiagnostic[]; warnings: BuildDiagnostic[] };
    refine?: { acceptedPatches: number; rejectedPatches: number; rationale: string; estimatedCostUsd: number };
    refineError?: { category: string; message: string };
    reverted?: boolean;
  };
  const iterations: Iteration[] = [];
  let stoppedReason:
    | "green"
    | "max_iterations"
    | "cost_cap"
    | "no_progress"
    | "refine_error"
    | "client_closed"
    | "regression_reverted" = "max_iterations";

  for (let i = 0; i < maxIterations; i++) {
    if (clientClosed) {
      stoppedReason = "client_closed";
      break;
    }

    emit("iteration-start", { iteration: i });

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

    emit("build-result", {
      iteration: i,
      ok: buildRes.ok,
      durationMs: buildRes.durationMs,
      errors: buildRes.errors,
      warnings: buildRes.warnings,
    });

    if (buildRes.ok) {
      bestFiles = currentFiles;
      bestErrorCount = 0;
      stoppedReason = "green";
      break;
    }

    // Revert-on-regression: if this iteration's cargo check is strictly
    // worse than the best state we've seen, the previous refine round
    // hurt more than helped. Roll currentFiles back to bestFiles and stop.
    // (i === 0 always sets the baseline since bestErrorCount is +Infinity.)
    if (buildRes.errors.length > bestErrorCount) {
      currentFiles = [...bestFiles];
      iter.reverted = true;
      emit("reverted", { iteration: i, errorCount: buildRes.errors.length, bestErrorCount });
      stoppedReason = "regression_reverted";
      break;
    }
    bestFiles = [...currentFiles];
    bestErrorCount = buildRes.errors.length;

    if (totalCostUsd >= maxCostUsd) {
      stoppedReason = "cost_cap";
      break;
    }
    if (clientClosed) {
      stoppedReason = "client_closed";
      break;
    }

    // Strip the `src/` prefix so refine sees the bare paths it generated.
    const refineFiles = currentFiles.map((f) => ({
      path: f.path.replace(/^src\//, ""),
      content: f.content,
    }));
    const validationIssues = buildRes.errors.map(diagnosticToValidationIssue);

    emit("refine-start", { iteration: i });

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

      emit("refine-result", {
        iteration: i,
        acceptedPatches: accepted.length,
        rejectedPatches: rejected,
        rationale: refineRes.rationale,
        estimatedCostUsd: refineRes.usage?.estimatedCostUsd ?? 0,
      });

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
      const errPayload =
        err instanceof AIError
          ? { category: err.category, message: err.message }
          : { category: "unknown", message: err instanceof Error ? err.message : String(err) };
      iter.refineError = errPayload;
      emit("refine-error", { iteration: i, ...errPayload });
      stoppedReason = "refine_error";
      break;
    }
  }

  const lastIter = iterations[iterations.length - 1];
  const finalOk = !!lastIter?.buildResult.ok;
  const totalDurationMs = Date.now() - t0;

  // Hand back the lowest-error state we observed, not the live currentFiles.
  // On a clean green run these are identical. On regression_reverted they
  // differ — currentFiles was already reverted above, so this is a no-op
  // there too, but keeping it explicit means the contract is clear: callers
  // always get the best-seen state.
  const finalFiles = bestErrorCount === 0 ? currentFiles : bestFiles;

  const finalPayload = {
    ok: finalOk,
    stoppedReason,
    iterations,
    finalFiles,
    finalOk,
    totalDurationMs,
    totalCostUsd,
  };

  if (wantsStream) {
    emit("done", finalPayload);
    if (!res.writableEnded) res.end();
  } else {
    res.json(finalPayload);
  }
});

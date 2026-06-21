import { Router } from "express";
import { z } from "zod";
import { readFileSync } from "node:fs";
import { PublicKey } from "@solana/web3.js";
import {
  runBuild,
  runBuildStreaming,
  QueueFullError,
  QueueWaitTimeoutError,
  PerIpQueueFullError,
  queueStats,
  type BuildTarget,
  type BuildMode,
  type BuildFile,
  type BuildDiagnostic,
  type CargoCancelHandle,
} from "../build/build-runner.js";
import { AnvilError, ErrorCode } from "../errors.js";
import { metrics } from "../metrics.js";
import { SolanaIRSchema, type SolanaIR } from "../ir/schema.js";
import { refineOutput } from "../ai/refine.js";
import { AIError } from "../ai/errors.js";
import { checkSpendCap, recordSpend, shouldRefuseDueToSpendBackend } from "../ai/spend-tracker.js";
import type { ValidationIssue } from "../emitter/output-validator.js";
import { ScenarioSchema, lintScenario, type Scenario } from "../ir/scenario.js";
import { buildBothSos, differentialAvailable, validateAnchorExtraDeps } from "../build/differential-build.js";
import { isRuntimeVerified } from "../ai/runtime-verified.js";
import { buildProjectScaffold } from "../emitter/project-scaffold.js";
import {
  resolveScenarioContext,
  runScenarioOnSo,
  compareScenarioRuns,
} from "../build/scenario-runner.js";

export const buildRoute = Router();

const BuildFileSchema = z.object({
  path: z.string().min(1).max(512),
  content: z.string().max(2_000_000), // 2 MB hard cap per file
});

// File-count cap. Bumped from 64 to 256 (2026-05-20) to admit larger
// real-world projects whose flattened emit exceeds 64 files (e.g.
// kamino-klend = 69 emit files). Defense-in-depth still bounded by the
// 2 MB per-file content cap × 256 = ~512 MB worst case, well under any
// realistic memory pressure on the API worker for a single request.
// Combined with /parse's 5 MB source cap, this puts a real ceiling on
// pipeline work without rejecting legitimate large programs.
const MAX_FILES_PER_REQUEST = 256;

const BuildRequestSchema = z.object({
  target: z.enum(["pinocchio", "native"]),
  files: z.array(BuildFileSchema).min(1).max(MAX_FILES_PER_REQUEST),
  programName: z.string().min(1).max(128),
  // 3-tier UX:
  //   "check"     — fastest, type-only (workbench's "Quick Check" button)
  //   "build"     — default, catches linker + codegen ("Verify Build" button)
  //   "build-sbf" — strictest, produces deployable .so ("Verify Deploy" or `?strict=1`)
  mode: z.enum(["check", "build", "build-sbf"]).optional(),
});

const AutoFixRequestSchema = z.object({
  target: z.enum(["pinocchio", "native"]),
  files: z.array(BuildFileSchema).min(1).max(MAX_FILES_PER_REQUEST),
  programName: z.string().min(1).max(128),
  ir: z.unknown(), // validated below with SolanaIRSchema
  maxIterations: z.number().int().min(1).max(5).optional(),
  maxCostUsd: z.number().min(0).max(2).optional(),
  /**
   * Optional byte-equal differential gate. When supplied, AFTER each
   * cargo-green iteration the auto-fix loop runs the AI-emitted .so
   * through the same scenario as an Anchor reference build and
   * byte-compares post-scenario state. Patches that compile but
   * silently change runtime semantics (account-byte divergence,
   * lamport divergence, owner reassignment) get flagged as
   * `differential_diverge` ValidationIssues and fed back into the
   * next refine iteration — turning the gate from "compiles" into
   * "compiles AND runtime-equivalent to Anchor."
   *
   * Mirrors the `/build/differential` endpoint contract; see that
   * route for the per-field semantics. Re-uses buildBothSos +
   * scenario-runner so cache hits are shared across the two paths.
   */
  differential: z
    .object({
      anchorSource: z.string().min(1).max(5_000_000),
      scenario: z.unknown(), // validated with ScenarioSchema
      anchorExtraDeps: z.string().max(50_000).optional(),
      anchorLangFeatures: z.array(z.string().max(64)).max(16).optional(),
      programIdBase58: z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/).optional(),
    })
    .optional(),
});

/**
 * POST /build — Verify-build for already-emitted Rust.
 *
 * Body:
 *   {
 *     target: "pinocchio" | "native",
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
 * Backs the "Verify Build" button in the workbench.
 *
 * Default mode runs `cargo build --message-format=json` against the
 * supplied files in a persistent per-target scratch dir so deps stay warm
 * across calls. This catches type errors AND linker / codegen issues that
 * `cargo check` would miss (e.g. duplicate `entrypoint!` collisions).
 *
 * Strict mode (body `mode: "build-sbf"` OR `?strict=1`) runs
 * `cargo build-sbf` to produce an actual Solana .so — the only thing that
 * proves the program will load into a validator. ~10x slower than default;
 * use sparingly (CLI `--strict`, pre-deploy verification).
 */
/**
 * GET /build/queue — current depth + ETA for each (target, mode) pair.
 *
 * A client about to enqueue a build can call this first to render the
 * expected wait time before paying it. Same data is also embedded in the
 * BuildResult.queue field on every successful build response, so the
 * common case (single-shot build) doesn't need a separate roundtrip;
 * this endpoint is for pre-flight UX.
 */
buildRoute.get("/queue", (_req, res) => {
  res.json(queueStats());
});

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

  const { target, files, programName, mode: bodyMode } = parsed.data;

  // ?strict=1 is the alternate way to request build-sbf for users who
  // would rather not change their request body shape. Body `mode` wins
  // if both are set. ?stream=1 routes to the SSE endpoint below.
  const queryStrict = req.query?.strict === "1" || req.query?.strict === "true";
  const queryStream = req.query?.stream === "1" || req.query?.stream === "true";
  const mode: BuildMode = bodyMode ?? (queryStrict ? "build-sbf" : "build");

  // Caller IP is used for the per-IP build-sbf concurrency cap below.
  // Behind a reverse proxy we trust req.ip (set by Express trust-proxy);
  // fall through to the raw socket address if not set.
  const callerIp = req.ip ?? req.socket.remoteAddress ?? "unknown";

  if (queryStream) {
    return handleStreamingBuild(req, res, target as BuildTarget, files, programName, mode, callerIp);
  }

  try {
    const result = await runBuild(target as BuildTarget, files, programName, mode, { callerIp });

    if (result.unsupported) {
      // The runner can still surface an `unsupported` result for things like
      // a missing cargo / cargo-build-sbf toolchain on the host. 422 = the
      // request was well-formed but the build couldn't run.
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
    // QueueFullError → 503 (transient overload), QueueWaitTimeoutError → 504
    // (we did try, but the backlog was too deep to honor the wait budget).
    if (e instanceof QueueFullError) {
      metrics.recordBuild({ target, ok: false, durationMs: 0 });
      res.status(503).setHeader("Retry-After", "5").json(
        new AnvilError(ErrorCode.RATE_LIMITED, "Build queue full — try again shortly", e.message, 503).toJSON(),
      );
      return;
    }
    if (e instanceof PerIpQueueFullError) {
      // 429 = rate-limited (per-caller cap), distinct from 503 (global
      // backlog). Retry-After hints the user wait until one of their
      // earlier builds finishes (build-sbf is 30s-2min wall time).
      metrics.recordBuild({ target, ok: false, durationMs: 0 });
      res.status(429).setHeader("Retry-After", "30").json(
        new AnvilError(ErrorCode.RATE_LIMITED, `Per-IP build-sbf cap (${e.cap}) reached — wait for one of your earlier builds to finish`, e.message, 429).toJSON(),
      );
      return;
    }
    if (e instanceof QueueWaitTimeoutError) {
      metrics.recordBuild({ target, ok: false, durationMs: 0 });
      res.status(504).json(
        new AnvilError(ErrorCode.INTERNAL_ERROR, "Build queue wait exceeded budget", e.message, 504).toJSON(),
      );
      return;
    }
    const message = e instanceof Error ? e.message : String(e);
    // safeRelativePath() in the build runner throws Error for path-
    // traversal, absolute, or empty paths — those are caller errors,
    // not server errors. Map to 400 instead of generic 500.
    const isInputError =
      /file path must be (a non-empty string|relative)/i.test(message) ||
      /file path may not contain '\.\.'/i.test(message) ||
      /at least one file is required/i.test(message);
    const code = isInputError ? ErrorCode.VALIDATION_FAILED : ErrorCode.INTERNAL_ERROR;
    const status = isInputError ? 400 : 500;
    const err = new AnvilError(code, isInputError ? "Invalid file path" : "Build runner failed", message, status);
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
 * For each iteration: cargo build → if errors, feed them as ValidationIssues
 * to refineOutput → apply accepted patches → cargo build again. Bounded by
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

  // Differential gate setup — validate the scenario + program ID up front
  // so a malformed payload fails before any AI is spent. The differential
  // check itself runs after each green cargo iteration.
  type DifferentialCfg = {
    anchorSource: string;
    scenario: Scenario;
    anchorExtraDeps?: string;
    anchorLangFeatures?: string[];
    programId: PublicKey;
  };
  // B5 — opt-out flag. When the body carries the `differential` field, the
  // gate runs by default; `?with_differential=0` (or `false`) lets a caller
  // skip the gate without restructuring the body. Mirrors the README's
  // documented `?with_differential=1` shape but inverts the default since
  // having an Anchor source + scenario in-flight already signals intent.
  const withDifferentialQuery = String(req.query.with_differential ?? "").toLowerCase();
  const differentialDisabled = withDifferentialQuery === "0" || withDifferentialQuery === "false";

  let differentialCfg: DifferentialCfg | null = null;
  if (parsed.data.differential && !differentialDisabled) {
    if (!differentialAvailable()) {
      const e = new AnvilError(
        ErrorCode.VALIDATION_FAILED,
        "Differential gate requested but cargo-build-sbf or anchor CLI not on PATH.",
        undefined,
        422,
      );
      res.status(e.statusCode).json(e.toJSON());
      return;
    }
    const sParsed = ScenarioSchema.safeParse(parsed.data.differential.scenario);
    if (!sParsed.success) {
      const e = new AnvilError(
        ErrorCode.VALIDATION_FAILED,
        "Invalid scenario in differential gate",
        sParsed.error.message,
        422,
      );
      res.status(e.statusCode).json(e.toJSON());
      return;
    }
    const lintErrors = lintScenario(sParsed.data).filter((i) => i.severity === "error");
    if (lintErrors.length > 0) {
      res.status(422).json({
        error: "Scenario lint failed",
        code: ErrorCode.VALIDATION_FAILED,
        lintIssues: lintErrors,
      });
      return;
    }
    // Resolve programId — same priority order as /build/differential.
    const declareIdMatch = parsed.data.differential.anchorSource.match(
      /\bdeclare_id!\s*\(\s*"([^"]+)"\s*\)/,
    );
    let programId: PublicKey;
    try {
      programId = new PublicKey(
        parsed.data.differential.programIdBase58
          ?? sParsed.data.programId
          ?? ir.programId
          ?? declareIdMatch?.[1]
          ?? "11111111111111111111111111111111",
      );
    } catch (err) {
      const e = new AnvilError(
        ErrorCode.VALIDATION_FAILED,
        "Invalid programId base58 in differential gate",
        String(err),
        400,
      );
      res.status(e.statusCode).json(e.toJSON());
      return;
    }
    // B1 — refuse off-allowlist anchorExtraDeps at the route boundary
    // before entering the auto-fix loop. The defensive check inside
    // buildAnchor() also throws, but doing it here means the caller sees
    // a clean 400 instead of a SCENARIO_FAILED feedback message that
    // would land as a synthetic ValidationIssue to refine (the AI can't
    // fix allowlist refusal, so feeding it would waste a refine round).
    try {
      validateAnchorExtraDeps(parsed.data.differential.anchorExtraDeps ?? "");
    } catch (err) {
      if (err instanceof AnvilError) {
        res.status(err.statusCode).json(err.toJSON());
        return;
      }
      throw err;
    }
    differentialCfg = {
      anchorSource: parsed.data.differential.anchorSource,
      scenario: sParsed.data,
      anchorExtraDeps: parsed.data.differential.anchorExtraDeps,
      anchorLangFeatures: parsed.data.differential.anchorLangFeatures,
      programId,
    };
  }

  // Streaming mode: ?stream=1 → respond as text/event-stream, emit one SSE
  // event per phase (iteration-start, build-result, refine-start,
  // refine-result/refine-error, done). Detected here AFTER body validation
  // so a bad payload still gets a clean 400/422 JSON.
  const wantsStream = req.query.stream === "1" || req.query.stream === "true";

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
  // anyway, so worst case we run one extra cargo build.
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
  type DifferentialOutcome = {
    verdict: "BYTE_EQUAL" | "BYTE_EQUAL_WITH_WARNINGS" | "DIVERGED" | "SCENARIO_FAILED";
    accountDiffs: { name: string; status: string; firstDiffByte?: number }[];
    durationMs: number;
  };
  type Iteration = {
    iteration: number;
    buildResult: { ok: boolean; durationMs: number; errors: BuildDiagnostic[]; warnings: BuildDiagnostic[] };
    refine?: { acceptedPatches: number; rejectedPatches: number; rationale: string; estimatedCostUsd: number };
    refineError?: { category: string; message: string };
    reverted?: boolean;
    differential?: DifferentialOutcome;
  };
  const iterations: Iteration[] = [];
  let stoppedReason:
    | "green"
    | "differential_byte_equal"
    | "max_iterations"
    | "cost_cap"
    | "no_progress"
    | "refine_error"
    | "client_closed"
    | "regression_reverted"
    | "daily_spend_cap_hit"
    | "spend_backend_degraded" = "max_iterations";

  const callerIp = req.ip ?? req.socket.remoteAddress ?? "unknown";

  for (let i = 0; i < maxIterations; i++) {
    if (clientClosed) {
      stoppedReason = "client_closed";
      break;
    }

    emit("iteration-start", { iteration: i });

    const buildRes = await runBuild(target as BuildTarget, currentFiles, programName, "build", { callerIp });
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
      // If no differential gate requested, compile-green is the terminal
      // condition — break here and return. Otherwise fall through to the
      // byte-equal check; only BYTE_EQUAL counts as fully green.
      if (!differentialCfg) {
        stoppedReason = "green";
        break;
      }
      const diffOutcome = await runDifferentialCheck(
        differentialCfg,
        target as BuildTarget,
        currentFiles,
        programName,
        ir,
      );
      iter.differential = diffOutcome;
      emit("differential-result", { iteration: i, ...diffOutcome });
      // B4 — BYTE_EQUAL_WITH_WARNINGS exits the loop too. The bytes match,
      // so further refining would just churn; but the verdict surfaces the
      // sanity warnings (partial_compare_scope, zero_mutation) the loop
      // shouldn't suppress. Downstream consumers gate strict-mode on the
      // exact verdict value rather than on a boolean.
      if (
        diffOutcome.verdict === "BYTE_EQUAL" ||
        diffOutcome.verdict === "BYTE_EQUAL_WITH_WARNINGS"
      ) {
        stoppedReason = "differential_byte_equal";
        break;
      }
      // DIVERGED or SCENARIO_FAILED: synthesize ValidationIssues to feed
      // back into the next refine. The cargo build is GREEN at this point,
      // so we can't reuse buildRes.errors; instead append synthetic issues
      // describing the runtime divergence.
      const syntheticIssues = differentialDivergenceIssues(diffOutcome);
      if (syntheticIssues.length === 0) {
        // Pathological — verdict says diverged but nothing to feed back.
        // Stop the loop and surface the verdict as the final outcome.
        stoppedReason = "no_progress";
        break;
      }
      // Replace the empty cargo-error issue list with the synthetic ones
      // so the refine call below has something to act on.
      buildRes.errors.push(...syntheticIssues.map((iss) => ({
        filePath: iss.path ?? "",
        line: iss.line ?? 0,
        column: 0,
        code: "differential_diverge",
        message: iss.message,
        spanText: "",
        severity: "error" as const,
      })));
      // Fall through to the existing refine path with the synthetic issues
      // packed into buildRes.errors.
    }

    // Revert-on-regression: if this iteration's cargo build is strictly
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

    // B3 — backend-health gate. When Redis (cross-replica spend store) is
    // degraded in prod, stop the auto-fix loop and report — silent fallback
    // to in-memory would let multi-replica deploys overrun the cap.
    const backendCheck = shouldRefuseDueToSpendBackend();
    if (backendCheck.refuse) {
      console.warn(`[build][auto-fix] spend backend degraded — halting loop ip=${callerIp}`);
      iter.refineError = { category: "backend_degraded", message: backendCheck.reason! };
      emit("refine-error", { iteration: i, category: "backend_degraded", message: iter.refineError.message });
      stoppedReason = "spend_backend_degraded";
      break;
    }

    // Per-IP daily AI spend cap. Stops the auto-fix loop before the next
    // refine call if this IP has burned through its daily budget. Different
    // from cost_cap (per-request) — this enforces aggregate-per-day.
    const spendCheck = await checkSpendCap(callerIp);
    if (!spendCheck.allowed) {
      console.warn(
        `[build][auto-fix] daily AI spend cap hit ip=${callerIp} todayUsd=${spendCheck.todayUsd.toFixed(4)} cap=${spendCheck.capUsd.toFixed(2)}`,
      );
      iter.refineError = {
        category: "daily_cap_hit",
        message: spendCheck.reason ?? "Daily AI spend cap reached.",
      };
      emit("refine-error", { iteration: i, category: "daily_cap_hit", message: iter.refineError.message });
      stoppedReason = "daily_spend_cap_hit";
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
        // These came from cargo build — flag so the prompt tells the model
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
      // Cached calls cost $0 — record but don't move the per-IP budget.
      recordSpend(callerIp, refineRes.cached ? 0 : (refineRes.usage?.estimatedCostUsd ?? 0));

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
  // finalOk = cargo-green AND (no differential gate OR differential
  // verdict is BYTE_EQUAL). A diverged-but-cargo-green run is NOT
  // green from the gate's perspective; callers (workbench badge,
  // CI) need that distinction to decide whether to deploy.
  const cargoGreen = !!lastIter?.buildResult.ok;
  const differentialOk =
    !differentialCfg ||
    lastIter?.differential?.verdict === "BYTE_EQUAL";
  const finalOk = cargoGreen && differentialOk;
  const totalDurationMs = Date.now() - t0;

  // Telemetry: surface the loop outcome to /metrics. iterations.length is
  // the number of cargo+refine cycles run (1-based for display; the
  // counter itself is run-count, not iters-to-green directly — for green
  // runs that's the same number).
  metrics.recordAutoFixRun({
    stoppedReason,
    iterations: iterations.length,
    reverted: stoppedReason === "regression_reverted",
    reachedGreen: stoppedReason === "green",
  });

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
    // Surface the latest differential outcome at the top level so callers
    // don't have to scan iterations[]. Undefined when the gate wasn't
    // requested. The workbench's "AI-patched + byte-equal verified" badge
    // reads this directly.
    differentialVerdict: differentialCfg
      ? lastIter?.differential?.verdict ?? "NOT_RUN"
      : undefined,
    // Explicit deploy-safety signal: true ONLY when a byte-equal differential
    // actually ran and passed. A cargo-green run with no differential gate is
    // NOT runtime-verified — consumers must not show it as "verified".
    runtimeVerified: isRuntimeVerified({
      cargoGreen,
      differentialRan: !!differentialCfg,
      verdict: lastIter?.differential?.verdict,
    }),
  };

  if (wantsStream) {
    emit("done", finalPayload);
    if (!res.writableEnded) res.end();
  } else {
    res.json(finalPayload);
  }
});

/**
 * SSE-streaming variant of POST /build, dispatched when the route handler
 * sees `?stream=1`. Same input shape; output is a stream of events:
 *
 *   event: build_started   { mode, target }
 *   event: cargo_message   { line: <one --message-format=json line> }
 *   event: build_done      { ok, errors, warnings, durationMs, stderrTail }
 *   event: build_error     { message }   (on failure pre-cargo)
 *   event: cancelled       {}            (on client disconnect)
 *
 * Cancel-on-disconnect: when the SSE client closes, we SIGTERM the cargo
 * subprocess via the cancel handle so we don't waste server CPU on a
 * build no one is waiting for.
 */
async function handleStreamingBuild(
  req: import("express").Request,
  res: import("express").Response,
  target: BuildTarget,
  files: BuildFile[],
  programName: string,
  mode: BuildMode,
  callerIp: string,
): Promise<void> {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  // Disable buffering on Vercel / nginx so the client gets events live.
  res.setHeader("X-Accel-Buffering", "no");
  // Flush headers immediately so EventSource considers the stream open.
  if (typeof (res as { flushHeaders?: () => void }).flushHeaders === "function") {
    (res as { flushHeaders: () => void }).flushHeaders();
  }

  const emit = (event: string, payload: unknown) => {
    if (res.writableEnded) return;
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
  };

  const cancelRef: { current: CargoCancelHandle | null } = { current: null };
  let clientGone = false;
  // `res.on("close")` fires when the response stream closes — both on
  // normal `res.end()` and on premature disconnect. We treat it as
  // "client disconnected" only if `res.writableEnded` is false at that
  // point: end() flips writableEnded → true before emitting close, while
  // a real disconnect leaves it false. Without this guard, every
  // successful build gets a spurious `cancelled` event under bun's HTTP
  // stack because req.on("close") fires on normal completion too.
  res.on("close", () => {
    if (!res.writableEnded) {
      clientGone = true;
      cancelRef.current?.cancel();
    }
  });

  emit("build_started", { mode, target });

  try {
    const result = await runBuildStreaming(target, files, programName, mode, {
      onLine: (line) => emit("cargo_message", { line }),
      cancelHandle: cancelRef,
      callerIp,
    });

    if (clientGone) {
      emit("cancelled", {});
    } else {
      metrics.recordBuild({ target, ok: result.ok, durationMs: result.durationMs });
      emit("build_done", {
        ok: result.ok,
        errors: result.errors,
        warnings: result.warnings,
        durationMs: result.durationMs,
        stderrTail: result.stderrTail,
        unsupported: result.unsupported,
      });
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : "build failed";
    emit("build_error", { message: msg });
  } finally {
    if (!res.writableEnded) res.end();
  }
}

/**
 * Run the byte-equal differential check on the current iteration's
 * cargo-green Anvil emit. Returns a compact verdict + per-account diff
 * summary suitable for both the iteration record and synthetic
 * ValidationIssue feedback to the next refine call.
 *
 * Reuses buildBothSos so SO-level cache hits are shared with the
 * /build/differential endpoint when both run during the same session.
 */
async function runDifferentialCheck(
  cfg: {
    anchorSource: string;
    scenario: Scenario;
    anchorExtraDeps?: string;
    anchorLangFeatures?: string[];
    programId: PublicKey;
  },
  target: BuildTarget,
  currentFiles: BuildFile[],
  programName: string,
  ir: SolanaIR,
): Promise<{
  verdict: "BYTE_EQUAL" | "BYTE_EQUAL_WITH_WARNINGS" | "DIVERGED" | "SCENARIO_FAILED";
  accountDiffs: { name: string; status: string; firstDiffByte?: number }[];
  durationMs: number;
}> {
  const t0 = Date.now();
  // Strip src/ prefix from build files; the differential build pipeline
  // expects bare paths (matches /emit's output shape).
  const anvilEmittedFiles = currentFiles.map((f) => ({
    path: f.path.replace(/^src\//, ""),
    content: f.content,
  }));
  // Synthesise scaffold from IR + target — same pattern as /build/differential.
  const anvilScaffoldFiles = buildProjectScaffold(ir, target);

  try {
    const artifacts = await buildBothSos({
      anchorSource: cfg.anchorSource,
      anvilEmittedFiles,
      anvilScaffoldFiles,
      anchorExtraDeps: cfg.anchorExtraDeps,
      anchorLangFeatures: cfg.anchorLangFeatures,
      programName,
      ir,
      programIdBase58: cfg.programId.toBase58(),
    });
    const ctx = resolveScenarioContext(cfg.scenario, cfg.programId);
    const anchorSo = readFileSync(artifacts.anchorSoPath);
    const anchorRun = runScenarioOnSo(cfg.scenario, ir, anchorSo, ctx);
    const anvilSo = readFileSync(artifacts.anvilSoPath);
    const anvilRun = runScenarioOnSo(cfg.scenario, ir, anvilSo, ctx);
    const verdict = compareScenarioRuns(cfg.scenario, ir, anchorRun, anvilRun, Date.now() - t0);
    return {
      verdict: verdict.verdict,
      accountDiffs: verdict.accountDiffs.map((d) => ({
        name: d.name,
        status: d.status,
        firstDiffByte: d.firstDiffByte,
      })),
      durationMs: Date.now() - t0,
    };
  } catch (err) {
    // Build/scenario failure is itself a divergence — surface it so the
    // refine loop can react. SCENARIO_FAILED maps to "Anvil built but
    // crashed during the scenario run"; the message lands as a synthetic
    // ValidationIssue downstream.
    const message = err instanceof Error ? err.message : String(err);
    return {
      verdict: "SCENARIO_FAILED",
      accountDiffs: [{ name: "<scenario>", status: `failed: ${message}` }],
      durationMs: Date.now() - t0,
    };
  }
}

/**
 * Translate a divergence verdict into ValidationIssues the refine loop
 * can act on. Each AccountDiff becomes one issue with a human-readable
 * message naming the account + status (data/lamports/owner/missing).
 * The path is unset because divergence isn't tied to a single source
 * file — refine treats path-less issues as program-level concerns.
 */
function differentialDivergenceIssues(outcome: {
  verdict: string;
  accountDiffs: { name: string; status: string; firstDiffByte?: number }[];
}): ValidationIssue[] {
  // B4 — both green-ish verdicts skip feedback. WITH_WARNINGS doesn't
  // need refine attention: the bytes match, the warnings are about the
  // scope of comparison not the correctness of emit.
  if (outcome.verdict === "BYTE_EQUAL" || outcome.verdict === "BYTE_EQUAL_WITH_WARNINGS") return [];
  if (outcome.accountDiffs.length === 0) {
    return [{
      severity: "error",
      message:
        `[differential_diverge] runtime byte-equal compare failed (verdict=${outcome.verdict}) ` +
        `but no per-account diff surfaced. The Anvil-emitted .so may have crashed mid-scenario; ` +
        `re-emit may need the scenario's account-init prelude to match Anchor's.`,
    }];
  }
  return outcome.accountDiffs.map((d) => ({
    severity: "error" as const,
    message:
      `[differential_diverge] account ${d.name} ${d.status}` +
      (d.firstDiffByte !== undefined ? ` at byte ${d.firstDiffByte}` : "") +
      `. Anvil's emit produced different post-scenario state than Anchor's reference. ` +
      `The cargo build is green, so this is a runtime-semantics regression: the patches ` +
      `that landed compile but change the program's observable behavior.`,
  }));
}

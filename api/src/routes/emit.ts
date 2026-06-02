import { Router } from "express";
import { SolanaIRSchema, type SolanaIR } from "../ir/schema.js";
import { emitPinocchio, emitPinocchioFull } from "../emitter/pinocchio-emitter.js";
import { emitNative, emitNativeFull } from "../emitter/native-emitter.js";
import { analyzeCU } from "../emitter/cu-analyzer.js";
import { validateEmitterOutput } from "../emitter/output-validator.js";
import { auditPassthrough } from "../emitter/passthrough-audit.js";
import { emitCostCap, MAX_EMIT_INSTRUCTIONS, MAX_EMIT_BODY_STATEMENTS } from "./emit-cost-cap.js";
import { refineOutput, REFINE_PROMPT_VERSION } from "../ai/refine.js";
import { RejectedAttemptSchema, type RejectedAttempt } from "../ai/refine-schemas.js";
import { checkSpendCap, recordSpend, shouldRefuseDueToSpendBackend } from "../ai/spend-tracker.js";
import { buildDeterministicReviewReport } from "../ai/review-report.js";
import { AIError } from "../ai/errors.js";
import { buildProjectScaffold } from "../emitter/project-scaffold.js";
import { AnvilError, ErrorCode } from "../errors.js";
import { metrics } from "../metrics.js";
import { z } from "zod";
import {
  runBuild,
  QueueFullError,
  QueueWaitTimeoutError,
  PerIpQueueFullError,
  type BuildTarget,
  type BuildFile,
} from "../build/build-runner.js";

export const emitRoute = Router();

/**
 * POST /emit — Emit target-framework Rust from SolanaIR
 *
 * Body: `{ ir: SolanaIR, target: "pinocchio" | "native", multiFile?: boolean, strict?: boolean }`
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
  // ?gate=cargo (B2 backend) — run `cargo check` against the emit before
  // returning. The validator is a fast heuristic; cargo is ground truth.
  // The CLI's --cargo-check (default-on) wraps the same cargo-gate module
  // via spawnSync; here we use the existing runBuild path so the route
  // inherits the build queue, per-IP cap, and sandbox layer. Returns
  // `cargoGate: { ok, errors, warnings, durationMs }` on the response so
  // the workbench can render a verdict next to the validator output.
  const gateCargo = req.query.gate === "cargo";
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

  const validTargets = ["pinocchio", "native"] as const;
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

  // #27 — emit-cost cap. The 8 MB body limit bounds IR bytes; this bounds emit
  // COMPUTE (~O(instruction count × body size)) so a pathological IR can't pin
  // a worker. Mirrors /parse's O(source) guard. See routes/emit-cost-cap.ts.
  const cost = emitCostCap(ir);
  if (cost.over) {
    const err = new AnvilError(
      ErrorCode.SOURCE_TOO_LARGE,
      `IR too large to emit (${cost.instructions} instructions / ${cost.bodyStatements} body statements; caps ${MAX_EMIT_INSTRUCTIONS} / ${MAX_EMIT_BODY_STATEMENTS})`,
      undefined,
      413,
    );
    res.status(err.statusCode).json(err.toJSON());
    return;
  }

  // Run the full emitter to get warnings + transform report
  try {
    const emitters = {
      pinocchio: emitPinocchioFull,
      native: emitNativeFull,
    } as const;

    const emitter = emitters[target as Target];
    const output = emitter(ir);
    let validationIssues = validateEmitterOutput(ir, output);

    // B2 — wire pass_through audit into the API surface. CLI strict mode
    // already runs auditPassthrough() in cli/anvil.ts (the live dev entry —
    // NOT cli/src/, which is a gitignored prepack copy); the
    // workbench's /emit response previously got no signal for Anchor-only
    // constructs hiding inside complex pass_through statements. Without
    // this, an `anchor_spl::*` import buried in a let-else / closure /
    // match arm survives the post-emit regex sweep and ships an Anchor
    // dependency to the user as "compiled output". Merge audit findings
    // into validationIssues so they pick up strict-mode refusal + show
    // in the workbench validation panel alongside output-validator issues.
    const passthroughFindings = auditPassthrough(ir);
    if (passthroughFindings.length > 0) {
      const asValidationIssues = passthroughFindings.map((f) => ({
        severity: f.severity,
        message: `[passthrough-audit] ${f.message} — snippet: ${f.snippet}`,
        path: f.path,
      }));
      validationIssues = [...validationIssues, ...asValidationIssues];
    }

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
      // B3 — when Redis (cross-replica spend store) is unhealthy in prod,
      // refuse the AI-billable call. Silent fallback to in-memory would
      // multiply the effective per-IP cap by the replica count. Mirror of
      // RATELIMIT_REDIS_LOUD_FAIL behavior in index.ts.
      const backendCheck = shouldRefuseDueToSpendBackend();
      if (backendCheck.refuse) {
        console.warn(`[emit][refine] spend backend degraded — refusing AI call. ip=${callerIp}`);
        validationWarnings.push(`AI refine unavailable: spend backend degraded.`);
        refineError = { category: "backend_degraded", message: backendCheck.reason! };
        metrics.recordRefineError("backend_degraded");
        res.setHeader("Retry-After", "5");
      } else {
        const spendCheck = await checkSpendCap(callerIp);
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
          promptVersion: REFINE_PROMPT_VERSION,
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
          // Multi-file path: regenerate the single-file view by concatenating
          // patched files so the "Single" tab in the workbench reflects the
          // accepted patches. Without this the Single tab stays at the pre-
          // refine emit while the Files tab shows post-refine content — users
          // perceive this as "refine deleted everything except lib.rs."
          if (currentFiles.length > 1) {
            currentSingleFile = currentFiles
              .map((f) => `// ─── ${f.path} ─────────────────────────────────────────────\n${f.content}`)
              .join("\n\n");
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
      } // close: else (B3 — backend healthy branch)
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

    // ── ?gate=cargo: cargo check accept gate (B2 backend) ──
    if (gateCargo) {
      // runBuild owns the scratch project — it writes its own Cargo.toml
      // (target-specific, hard-coded deps) and unwraps file paths into
      // scratchDir/src/. We pass the bare emitted files (paths like
      // "lib.rs", "instructions/mod.rs") without any src/ prefix or
      // scaffold; runBuild handles both. This matches routes/build.ts
      // which calls runBuild with the same shape.
      const gateFiles: BuildFile[] = currentFiles.map((f) => ({
        path: f.path,
        content: f.content,
      }));
      const callerIp = req.ip ?? req.socket.remoteAddress ?? "unknown";
      try {
        const r = await runBuild(
          target as BuildTarget,
          gateFiles,
          ir.name,
          "check",
          { callerIp },
        );
        response.cargoGate = {
          ok: r.ok,
          durationMs: r.durationMs,
          errors: r.errors,
          warnings: r.warnings,
          stderrTail: r.stderrTail,
          unsupported: r.unsupported,
        };
        // Mirror cargo errors into validationIssues so existing UI paths
        // that aggregate validator + cargo signals see a unified list.
        // Marked with a `cargo:` prefix so callers can distinguish.
        if (!r.ok) {
          const cargoIssues = r.errors.map((e) => ({
            severity: "error" as const,
            message: `cargo: ${e.message}`,
            path: e.filePath || undefined,
            line: e.line || undefined,
          }));
          response.validationIssues = [
            ...(response.validationIssues as typeof validationIssues),
            ...cargoIssues,
          ];
        }
      } catch (e) {
        // Queue full / timeout / per-IP cap: surface as a non-fatal
        // cargoGate.error so the caller knows the gate didn't run.
        // The emit itself is still valid; the user can retry the gate.
        if (
          e instanceof QueueFullError
          || e instanceof PerIpQueueFullError
          || e instanceof QueueWaitTimeoutError
        ) {
          response.cargoGate = {
            ok: false,
            durationMs: 0,
            errors: [],
            warnings: [],
            stderrTail: "",
            queueError: e instanceof QueueFullError
              ? "queue_full"
              : e instanceof PerIpQueueFullError
                ? "per_ip_cap"
                : "wait_timeout",
            queueMessage: e.message,
          };
        } else {
          throw e;
        }
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

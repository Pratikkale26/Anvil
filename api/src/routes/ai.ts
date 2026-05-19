import { Router } from "express";
import type { Response } from "express";
import { z } from "zod";
import { RefineRequestSchema } from "../ai/refine-schemas.js";
import { refineOutput } from "../ai/refine.js";
import { type SolanaIR, SolanaIRSchema } from "../ir/schema.js";
import { buildDeterministicReviewReport } from "../ai/review-report.js";
import { checkSpendCap, recordSpend, shouldRefuseDueToSpendBackend } from "../ai/spend-tracker.js";
import { AIError } from "../ai/errors.js";
import { AnvilError, ErrorCode } from "../errors.js";
import { diagnoseDifferentialFailure } from "../ai/diagnose-differential.js";

export const aiRoute = Router();

function createProgressLogger(routeName: string) {
  const requestId = `${routeName}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
  const log = (step: string, message: string) => {
    console.log(`[AI][${requestId}][${step}] ${message}`);
  };
  return { requestId, log };
}

function writeStreamChunk(res: Response, payload: Record<string, unknown>) {
  res.write(`${JSON.stringify(payload)}\n`);
}

/**
 * POST /ai/refine
 *
 * Single unified AI endpoint. Takes emitter output + validation issues,
 * makes exactly 1 LLM call to fix them, returns patched files.
 *
 * Body: { target, files, validationIssues, ir? }
 * Query: ?stream=1 for NDJSON streaming progress
 */
aiRoute.post("/refine", async (req, res) => {
  // Parse and validate request
  // S6 — error responses use AnvilError so clients (workbench, CLI)
  // parse a consistent { error, code, status, details } shape instead
  // of the prior plain `{ error, details }` which lacked the `code`
  // field downstream parsers expect.
  const body = req.body as Record<string, unknown>;
  const refineData = RefineRequestSchema.safeParse(body);
  if (!refineData.success) {
    res.status(422).json(
      new AnvilError(
        ErrorCode.VALIDATION_FAILED,
        "Invalid refine request",
        refineData.error.message,
        422,
      ).toJSON(),
    );
    return;
  }

  // IR is REQUIRED for the refine endpoint.
  //
  // Pre-fix this route accepted requests without an `ir` field and built
  // a fake empty SolanaIR shell. refineOutput then re-ran the validator
  // against that shell, so cross-file checks were vacuous: a patch that
  // breaks instructions/foo.rs by removing a `pub use` from lib.rs passed
  // silently. The endpoint claimed "validated" while the gate had degraded
  // to "structural pre-check + same-file content check."
  //
  // Now: missing or malformed `ir` returns 422 with a clear explanation.
  // Callers that want a structural-only check can use a different code
  // path (or build a minimal IR themselves and own the trade-off).
  if (!body.ir) {
    res.status(422).json(
      new AnvilError(
        ErrorCode.VALIDATION_FAILED,
        "Missing required field: ir",
        "POST /ai/refine requires the SolanaIR for cross-file accept-gate validation. Without it the validator can only check the patched file in isolation — a patch that breaks an unrelated file would pass silently. Send the IR returned by /parse or /emit alongside files + validationIssues.",
        422,
      ).toJSON(),
    );
    return;
  }
  const irParsed = SolanaIRSchema.safeParse(body.ir);
  if (!irParsed.success) {
    res.status(422).json(
      new AnvilError(
        ErrorCode.VALIDATION_FAILED,
        "Invalid IR",
        irParsed.error.message,
        422,
      ).toJSON(),
    );
    return;
  }
  const ir: SolanaIR = irParsed.data;

  const { requestId, log } = createProgressLogger("refine");
  const stream = req.query.stream === "1";
  const callerIp = req.ip ?? req.socket.remoteAddress ?? "unknown";

  // Per-IP daily AI spend cap. /emit?refine=1 and /build/auto-fix already
  // enforce this; /ai/refine — a publicly mounted route — was bypassing it,
  // so a scripted attacker could burn the AI budget while the documented-
  // gate routes were closed. Mirror the same shape: 429 + Retry-After when
  // capped, recordSpend post-call (0 on cache hit so the budget doesn't
  // move on free responses).
  // B3 — spend-tracker backend degradation guard. In prod with Redis
  // configured, a Redis outage means the per-IP counter can't be enforced
  // across replicas; silent fallback inflates the effective cap by
  // replica count. 503 + Retry-After until Redis recovers (operator can
  // opt back into the old silent-fallback via ANVIL_SPEND_REDIS_FALLBACK=1).
  const backendCheck = shouldRefuseDueToSpendBackend();
  if (backendCheck.refuse) {
    console.warn(`[ai/refine] spend backend degraded — refusing call ip=${callerIp}`);
    res.setHeader("Retry-After", "5");
    res.status(503).json({
      error: "AI spend backend temporarily unavailable",
      details: backendCheck.reason,
      category: "backend_degraded",
      retryAfterSec: 5,
    });
    return;
  }

  const spendCheck = await checkSpendCap(callerIp);
  if (!spendCheck.allowed) {
    const message = spendCheck.reason ?? `Daily AI spend cap of $${spendCheck.capUsd.toFixed(2)} per IP reached.`;
    console.warn(
      `[ai/refine] daily AI spend cap hit ip=${callerIp} todayUsd=${spendCheck.todayUsd.toFixed(4)} cap=${spendCheck.capUsd.toFixed(2)}`,
    );
    res.setHeader("Retry-After", String(spendCheck.retryAfterSec));
    res.status(429).json({
      error: "AI spend cap hit",
      details: message,
      category: "daily_cap_hit",
      retryAfterSec: spendCheck.retryAfterSec,
    });
    return;
  }

  if (stream) {
    res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Transfer-Encoding", "chunked");
    writeStreamChunk(res, { type: "status", requestId, step: "accepted", message: "AI refine request accepted." });
  }

  try {
    log("start", `Starting AI refine for ${refineData.data.validationIssues.length} issue(s).`);

    const result = await refineOutput(
      {
        target: refineData.data.target,
        ir,
        files: refineData.data.files,
        validationIssues: refineData.data.validationIssues,
      },
      (step, message) => {
        log(step, message);
        if (stream) writeStreamChunk(res, { type: "status", requestId, step, message });
      },
    );
    // Record spend immediately on success — cached calls are $0 so they
    // don't move the budget needle, but we still want the calls counter
    // to tick (visibility for /metrics, doesn't enforce).
    recordSpend(callerIp, result.cached ? 0 : (result.usage?.estimatedCostUsd ?? 0));

    const reviewReport = buildDeterministicReviewReport(
      refineData.data.validationIssues,
      ir,
      refineData.data.target,
    );

    const accepted = result.patches.filter((p) => p.accepted).length;
    log("done", `Completed AI refine: ${accepted}/${result.patches.length} patches accepted.`);

    if (stream) {
      writeStreamChunk(res, { type: "result", requestId, data: { ...result, reviewReport } });
      res.end();
      return;
    }
    res.json({ ...result, reviewReport });
  } catch (error) {
    log("error", error instanceof Error ? error.message : String(error));
    // Categorized AIError → stable HTTP status. Pre-fix every error landed
    // as 500, so callers couldn't distinguish quota-exceeded (retryable
    // tomorrow) from invalid-key (config) from server-5xx (retry now).
    const isAI = error instanceof AIError;
    const status = isAI
      ? error.category === "missing_key" || error.category === "invalid_key"
        ? 503
        : error.category === "rate_limited"
          ? 429
          : error.category === "timeout"
            ? 504
            : 502
      : 500;
    const body: Record<string, unknown> = {
      error: "AI refine failed",
      details: error instanceof Error ? error.message : String(error),
    };
    if (isAI) body.category = error.category;
    if (stream) {
      writeStreamChunk(res, { type: "error", requestId, ...body });
      res.end();
      return;
    }
    res.status(status).json(body);
  }
});

// Per-field caps for diagnose-differential. Same rationale as
// RefineRequestSchema: an 8 MB body cap doesn't bound the prompt size
// when individual fields are unbounded. Cap snippets at ~10 KB (well
// above realistic instruction-handler size), hex strings at 8 KB
// (5 KB Anchor account is plenty for diagnosis), and the nested
// anchor/anvil field diffs to bounded JSON-stringify size via the
// boundedJson refinement so an adversary can't nest pathologically.
const DD_SNIPPET_MAX = 10_000;
const DD_HEX_MAX = 8_000;
const DD_NAME_MAX = 256;
const DD_FIELD_DIFF_VALUE_MAX_BYTES = 4_000;
const DD_FIELD_COUNT_MAX = 200;

const boundedJsonValue = z.unknown().refine(
  (v) => {
    try {
      return JSON.stringify(v).length <= DD_FIELD_DIFF_VALUE_MAX_BYTES;
    } catch {
      return false;
    }
  },
  { message: `field diff value exceeds ${DD_FIELD_DIFF_VALUE_MAX_BYTES} bytes when JSON-serialized` },
);

export const DiagnoseDifferentialRequestSchema = z.object({
  target: z.enum(["pinocchio", "native"]).optional(),
  divergence: z.object({
    accountName: z.string().min(1).max(DD_NAME_MAX),
    accountType: z.string().max(DD_NAME_MAX).optional(),
    fieldDiffs: z
      .array(
        z.object({
          field: z.string().max(DD_NAME_MAX),
          anchor: boundedJsonValue,
          anvil: boundedJsonValue,
          equal: z.boolean(),
          sourceLink: z
            .object({
              instruction: z.string().max(DD_NAME_MAX),
              line: z.number(),
              column: z.number(),
            })
            .optional(),
        }),
      )
      .max(DD_FIELD_COUNT_MAX)
      .optional(),
    firstDiffByte: z.number().optional(),
    anchorHex: z.string().max(DD_HEX_MAX).optional(),
    anvilHex: z.string().max(DD_HEX_MAX).optional(),
  }),
  sourceSnippet: z.string().max(DD_SNIPPET_MAX).optional(),
  emittedSnippet: z.string().max(DD_SNIPPET_MAX).optional(),
  accountFields: z
    .array(
      z.object({
        name: z.string().max(DD_NAME_MAX),
        type: z.string().max(DD_NAME_MAX),
      }),
    )
    .max(DD_FIELD_COUNT_MAX)
    .optional(),
});

aiRoute.post("/diagnose-differential", async (req, res) => {
  const body = req.body as Record<string, unknown>;
  const parsed = DiagnoseDifferentialRequestSchema.safeParse(body);
  if (!parsed.success) {
    // S6 — AnvilError wrapper for client-side parsability.
    res.status(422).json(
      new AnvilError(
        ErrorCode.VALIDATION_FAILED,
        "Invalid diagnose-differential request",
        parsed.error.message,
        422,
      ).toJSON(),
    );
    return;
  }

  const { requestId, log } = createProgressLogger("diagnose-differential");
  const callerIp = req.ip ?? req.socket.remoteAddress ?? "unknown";

  // B3 — same backend-health gate as /ai/refine. Spend tracking can't be
  // trusted across replicas while Redis is degraded; refuse with 503
  // rather than silently overcharging via per-replica fallback.
  const backendCheck = shouldRefuseDueToSpendBackend();
  if (backendCheck.refuse) {
    console.warn(`[ai/diagnose-differential] spend backend degraded — refusing ip=${callerIp}`);
    res.setHeader("Retry-After", "5");
    res.status(503).json({
      error: "AI spend backend temporarily unavailable",
      details: backendCheck.reason,
      category: "backend_degraded",
      retryAfterSec: 5,
    });
    return;
  }

  const spendCheck = await checkSpendCap(callerIp);
  if (!spendCheck.allowed) {
    const message =
      spendCheck.reason ??
      `Daily AI spend cap of $${spendCheck.capUsd.toFixed(2)} per IP reached.`;
    console.warn(
      `[ai/diagnose-differential] daily AI spend cap hit ip=${callerIp} todayUsd=${spendCheck.todayUsd.toFixed(4)} cap=${spendCheck.capUsd.toFixed(2)}`,
    );
    res.setHeader("Retry-After", String(spendCheck.retryAfterSec));
    res.status(429).json({
      error: "AI spend cap hit",
      details: message,
      category: "daily_cap_hit",
      retryAfterSec: spendCheck.retryAfterSec,
    });
    return;
  }

  try {
    log("start", `Diagnosing divergence on account ${parsed.data.divergence.accountName}.`);
    const result = await diagnoseDifferentialFailure(parsed.data);
    recordSpend(callerIp, result.usage?.estimatedCostUsd ?? 0);
    log("done", `Category=${result.response.category} confidence=${result.response.confidence}.`);
    res.json({ requestId, ...result });
  } catch (error) {
    log("error", error instanceof Error ? error.message : String(error));
    const isAI = error instanceof AIError;
    const status = isAI
      ? error.category === "missing_key" || error.category === "invalid_key"
        ? 503
        : error.category === "rate_limited"
          ? 429
          : error.category === "timeout"
            ? 504
            : 502
      : 500;
    const out: Record<string, unknown> = {
      error: "AI diagnose-differential failed",
      details: error instanceof Error ? error.message : String(error),
    };
    if (isAI) out.category = error.category;
    res.status(status).json(out);
  }
});

import { Router } from "express";
import type { Response } from "express";
import { z } from "zod";
import { RefineRequestSchema } from "../ai/refine-schemas.js";
import { refineOutput } from "../ai/refine.js";
import { type SolanaIR, SolanaIRSchema } from "../ir/schema.js";
import { buildDeterministicReviewReport } from "../ai/review-report.js";
import { checkSpendCap, recordSpend } from "../ai/spend-tracker.js";
import { AIError } from "../ai/errors.js";
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
  const body = req.body as Record<string, unknown>;
  const refineData = RefineRequestSchema.safeParse(body);
  if (!refineData.success) {
    res.status(422).json({ error: "Invalid refine request", details: refineData.error.message });
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
    res.status(422).json({
      error: "Missing required field: ir",
      details:
        "POST /ai/refine requires the SolanaIR for cross-file accept-gate validation. Without it the validator can only check the patched file in isolation — a patch that breaks an unrelated file would pass silently. Send the IR returned by /parse or /emit alongside files + validationIssues.",
    });
    return;
  }
  const irParsed = SolanaIRSchema.safeParse(body.ir);
  if (!irParsed.success) {
    res.status(422).json({
      error: "Invalid IR",
      details: irParsed.error.message,
    });
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

const DiagnoseDifferentialRequestSchema = z.object({
  target: z.enum(["pinocchio", "native"]).optional(),
  divergence: z.object({
    accountName: z.string(),
    accountType: z.string().optional(),
    fieldDiffs: z
      .array(
        z.object({
          field: z.string(),
          anchor: z.unknown(),
          anvil: z.unknown(),
          equal: z.boolean(),
          sourceLink: z
            .object({
              instruction: z.string(),
              line: z.number(),
              column: z.number(),
            })
            .optional(),
        }),
      )
      .optional(),
    firstDiffByte: z.number().optional(),
    anchorHex: z.string().optional(),
    anvilHex: z.string().optional(),
  }),
  sourceSnippet: z.string().optional(),
  emittedSnippet: z.string().optional(),
  accountFields: z
    .array(z.object({ name: z.string(), type: z.string() }))
    .optional(),
});

aiRoute.post("/diagnose-differential", async (req, res) => {
  const body = req.body as Record<string, unknown>;
  const parsed = DiagnoseDifferentialRequestSchema.safeParse(body);
  if (!parsed.success) {
    res.status(422).json({
      error: "Invalid diagnose-differential request",
      details: parsed.error.message,
    });
    return;
  }

  const { requestId, log } = createProgressLogger("diagnose-differential");
  const callerIp = req.ip ?? req.socket.remoteAddress ?? "unknown";

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

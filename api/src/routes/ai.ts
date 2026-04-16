import { Router } from "express";
import type { Response } from "express";
import { RefineRequestSchema } from "../ai/refine-schemas.js";
import { refineOutput } from "../ai/refine.js";
import { type SolanaIR, SolanaIRSchema } from "../ir/schema.js";
import { buildDeterministicReviewReport } from "../ai/review-report.js";

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

  // IR is optional for the refine endpoint — used for acceptance re-validation
  let ir: SolanaIR | undefined;
  if (body.ir) {
    const irParsed = SolanaIRSchema.safeParse(body.ir);
    if (irParsed.success) {
      ir = irParsed.data;
    }
  }

  const { requestId, log } = createProgressLogger("refine");
  const stream = req.query.stream === "1";

  if (stream) {
    res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Transfer-Encoding", "chunked");
    writeStreamChunk(res, { type: "status", requestId, step: "accepted", message: "AI refine request accepted." });
  }

  try {
    log("start", `Starting AI refine for ${refineData.data.validationIssues.length} issue(s).`);

    // Build a minimal IR for acceptance checks if not provided
    const fallbackIR: SolanaIR = ir ?? {
      name: "unknown",
      instructions: [],
      accounts: [],
      errors: [],
      types: [],
      helperFns: [],
      constants: [],
      imports: [],
      metadata: {
        sourceFramework: "anchor" as const,
        anvilVersion: "0.2.0",
        parsedAt: new Date().toISOString(),
      },
    };

    const result = await refineOutput(
      {
        target: refineData.data.target,
        ir: fallbackIR,
        files: refineData.data.files,
        validationIssues: refineData.data.validationIssues,
      },
      (step, message) => {
        log(step, message);
        if (stream) writeStreamChunk(res, { type: "status", requestId, step, message });
      },
    );
    const reviewReport = buildDeterministicReviewReport(refineData.data.validationIssues);

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
    if (stream) {
      writeStreamChunk(res, {
        type: "error",
        requestId,
        error: "AI refine failed",
        details: error instanceof Error ? error.message : String(error),
      });
      res.end();
      return;
    }
    res.status(500).json({
      error: "AI refine failed",
      details: error instanceof Error ? error.message : String(error),
    });
  }
});

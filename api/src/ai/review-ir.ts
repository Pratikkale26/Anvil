import { getAIProvider } from "./config.js";
import { writeProvenance, sha256 } from "./provenance.js";
import type { ReviewIRRequest, ReviewIRResponse } from "./schemas.js";
import { ReviewIRModelResponseSchema } from "./schemas.js";
import {
  buildReviewIRPrompt,
  REVIEW_IR_PROMPT_VERSION,
  REVIEW_IR_RESPONSE_JSON_SCHEMA,
} from "./prompts/review-ir.js";

export async function reviewIR(input: ReviewIRRequest): Promise<ReviewIRResponse> {
  const { provider, reviewModel } = getAIProvider();
  const prompt = buildReviewIRPrompt(input);
  const raw = await provider.generateStructured({
    schema: REVIEW_IR_RESPONSE_JSON_SCHEMA,
    prompt,
    model: reviewModel,
  });
  const parsed = ReviewIRModelResponseSchema.parse(raw);

  const provenance = {
    timestamp: new Date().toISOString(),
    provider: provider.name,
    model: reviewModel,
    promptVersion: REVIEW_IR_PROMPT_VERSION,
    sourceHash: sha256(input.source),
    irHash: sha256(JSON.stringify(input.ir)),
    target: input.target ?? null,
    selectedFile: null,
    accepted: null,
    findingsSummary: parsed.findings.map((finding) => `${finding.severity}:${finding.title}`),
  } as const;

  writeProvenance(provenance);

  return {
    findings: parsed.findings,
    confidence: parsed.overallConfidence,
    summary: parsed.summary,
    promptVersion: REVIEW_IR_PROMPT_VERSION,
    provider: provider.name,
    model: reviewModel,
    provenance,
  };
}


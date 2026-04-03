import { getAIProvider } from "./config.js";
import { writeProvenance, sha256 } from "./provenance.js";
import type { ReviewOutputRequest, ReviewOutputResponse } from "./schemas.js";
import { ReviewOutputModelResponseSchema } from "./schemas.js";
import {
  buildReviewOutputPrompt,
  REVIEW_OUTPUT_PROMPT_VERSION,
  REVIEW_OUTPUT_RESPONSE_JSON_SCHEMA,
} from "./prompts/review-output.js";

export async function reviewOutput(input: ReviewOutputRequest): Promise<ReviewOutputResponse> {
  const { provider, reviewModel } = getAIProvider();
  const prompt = buildReviewOutputPrompt(input);
  const raw = await provider.generateStructured({
    schema: REVIEW_OUTPUT_RESPONSE_JSON_SCHEMA,
    prompt,
    model: reviewModel,
  });
  const parsed = ReviewOutputModelResponseSchema.parse(raw);

  const provenance = {
    timestamp: new Date().toISOString(),
    provider: provider.name,
    model: reviewModel,
    promptVersion: REVIEW_OUTPUT_PROMPT_VERSION,
    sourceHash: sha256(input.source),
    irHash: sha256(JSON.stringify(input.ir)),
    target: input.target,
    selectedFile: null,
    accepted: null,
    findingsSummary: parsed.findings.map((finding) => `${finding.filePath ?? "unknown"}:${finding.title}`),
  } as const;

  writeProvenance(provenance);

  return {
    findings: parsed.findings,
    confidence: parsed.overallConfidence,
    summary: parsed.summary,
    promptVersion: REVIEW_OUTPUT_PROMPT_VERSION,
    provider: provider.name,
    model: reviewModel,
    provenance,
  };
}


import { z } from "zod";

/**
 * Refine request: emitter output + deterministic validation issues to fix.
 */
export const RefineRequestSchema = z.object({
  target: z.enum(["pinocchio", "native"]),
  files: z.array(z.object({ path: z.string(), content: z.string() })).min(1),
  validationIssues: z.array(z.object({
    severity: z.enum(["error", "warning"]),
    message: z.string(),
    path: z.string().optional(),
    line: z.number().optional(),
  })).min(1),
});
export type RefineRequest = z.infer<typeof RefineRequestSchema>;

export const AIFindingSchema = z.object({
  severity: z.enum(["error", "warning", "info"]),
  filePath: z.string().optional(),
  title: z.string(),
  explanation: z.string(),
  suggestedFix: z.string(),
});
export type AIFinding = z.infer<typeof AIFindingSchema>;

/**
 * Hard upper bound on patch size. 200 KB is ~7000 lines of dense Rust —
 * larger than any single emitted file we produce in practice. Larger
 * `patchedContent` is either a hallucination (model dumped its training
 * data) or an attempt to OOM the server. Cap at the schema layer so the
 * cache write + tree-sitter parse never get an oversized blob.
 */
const PATCH_MAX_BYTES = 200_000;

/**
 * A single file patch from the AI.
 */
export const RefinePatchSchema = z.object({
  filePath: z.string().min(1).max(512),
  patchedContent: z
    .string()
    .max(PATCH_MAX_BYTES, `patchedContent exceeds ${PATCH_MAX_BYTES} bytes`)
    // Strip ASCII control chars (except tab/LF/CR) — bytes a real Rust file
    // never contains. Some models occasionally insert NUL or BEL bytes that
    // confuse downstream tools. Refuse early.
    .refine(
      (s) => !/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(s),
      "patchedContent contains control characters",
    ),
});
export type RefinePatch = z.infer<typeof RefinePatchSchema>;

/**
 * A prior rejected patch attempt, fed back into the next refine prompt so the
 * model can see what went wrong and try a different approach. Content is
 * deliberately truncated to keep the context + cache footprint bounded.
 */
export const RejectedAttemptSchema = z.object({
  filePath: z.string(),
  acceptanceReason: z.string(),
  patchedContentPreview: z.string(),
});
export type RejectedAttempt = z.infer<typeof RejectedAttemptSchema>;

/**
 * Raw model response for refine.
 */
export const RefineModelResponseSchema = z.object({
  rationale: z.string(),
  findings: z.array(AIFindingSchema).default([]),
  // Empty patches is a valid response — the prompt allows the model to return
  // `patches: []` when it can't fix without fabricating symbols. Don't reject.
  patches: z.array(RefinePatchSchema),
});
export type RefineModelResponse = z.infer<typeof RefineModelResponseSchema>;

/**
 * Per-call usage breakdown surfaced for cost transparency.
 * cacheReadTokens > 0 indicates a prompt-cache hit (10× cheaper input tokens).
 */
export const ProviderUsageSchema = z.object({
  inputTokens: z.number(),
  outputTokens: z.number(),
  cacheCreationTokens: z.number(),
  cacheReadTokens: z.number(),
  /** Best-effort USD estimate using current Sonnet 4 pricing. */
  estimatedCostUsd: z.number().optional(),
});
export type ProviderUsage = z.infer<typeof ProviderUsageSchema>;

/**
 * Before/after error counts so the UI can render a clear delta and decide
 * whether the refine actually helped.
 */
export const ErrorDeltaSchema = z.object({
  before: z.number(),
  after: z.number(),
});
export type ErrorDelta = z.infer<typeof ErrorDeltaSchema>;

/**
 * Full refine response returned to the client.
 */
export const RefineResponseSchema = z.object({
  rationale: z.string(),
  findings: z.array(AIFindingSchema).default([]),
  patches: z.array(z.object({
    filePath: z.string(),
    originalContent: z.string(),
    patchedContent: z.string(),
    accepted: z.boolean(),
    acceptanceReason: z.string(),
  })),
  summary: z.string(),
  aiCallMade: z.boolean(),
  cacheKey: z.string().optional(),
  cached: z.boolean().optional(),
  usage: ProviderUsageSchema.optional(),
  errorDelta: ErrorDeltaSchema.optional(),
});
export type RefineResponse = z.infer<typeof RefineResponseSchema>;

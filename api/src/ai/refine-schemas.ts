import { z } from "zod";

/**
 * Refine request: emitter output + deterministic validation issues to fix.
 */
export const RefineRequestSchema = z.object({
  target: z.enum(["pinocchio", "quasar", "native"]),
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
 * A single file patch from the AI.
 */
export const RefinePatchSchema = z.object({
  filePath: z.string(),
  patchedContent: z.string(),
});
export type RefinePatch = z.infer<typeof RefinePatchSchema>;

/**
 * Raw model response for refine.
 */
export const RefineModelResponseSchema = z.object({
  rationale: z.string(),
  findings: z.array(AIFindingSchema).default([]),
  patches: z.array(RefinePatchSchema).min(1),
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

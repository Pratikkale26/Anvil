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
  patches: z.array(RefinePatchSchema).min(1),
});
export type RefineModelResponse = z.infer<typeof RefineModelResponseSchema>;

/**
 * Full refine response returned to the client.
 */
export const RefineResponseSchema = z.object({
  rationale: z.string(),
  patches: z.array(z.object({
    filePath: z.string(),
    originalContent: z.string(),
    patchedContent: z.string(),
    accepted: z.boolean(),
    acceptanceReason: z.string(),
  })),
  summary: z.string(),
  aiCallMade: z.boolean(),
});
export type RefineResponse = z.infer<typeof RefineResponseSchema>;

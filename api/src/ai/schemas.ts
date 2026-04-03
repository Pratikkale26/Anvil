import { z } from "zod";
import { SolanaIRSchema } from "../ir/schema.js";

export const AIProviderNameSchema = z.enum(["gemini"]);
export type AIProviderName = z.infer<typeof AIProviderNameSchema>;

export const AITargetSchema = z.enum(["pinocchio", "quasar", "native"]).optional();
export type AITarget = z.infer<typeof AITargetSchema>;

export const AIReviewSeveritySchema = z.enum(["info", "warning", "error"]);
export type AIReviewSeverity = z.infer<typeof AIReviewSeveritySchema>;

export const AIFixCategorySchema = z.enum([
  "constraint",
  "type",
  "cpi",
  "pda",
  "state",
  "serialization",
  "account_validation",
  "helper",
  "cleanup",
  "other",
]);
export type AIFixCategory = z.infer<typeof AIFixCategorySchema>;

export const AIReviewFindingSchema = z.object({
  id: z.string(),
  severity: AIReviewSeveritySchema,
  title: z.string(),
  summary: z.string(),
  filePath: z.string().optional(),
  instructionName: z.string().optional(),
  fixCategory: AIFixCategorySchema,
  confidence: z.number().min(0).max(1),
  evidence: z.array(z.string()).default([]),
  suggestedAction: z.string().optional(),
});
export type AIReviewFinding = z.infer<typeof AIReviewFindingSchema>;

export const AIProvenanceSchema = z.object({
  timestamp: z.string(),
  provider: AIProviderNameSchema,
  model: z.string(),
  promptVersion: z.string(),
  sourceHash: z.string(),
  irHash: z.string(),
  target: z.enum(["pinocchio", "quasar", "native"]).nullable(),
  selectedFile: z.string().nullable(),
  accepted: z.boolean().nullable(),
  findingsSummary: z.array(z.string()).default([]),
});
export type AIProvenance = z.infer<typeof AIProvenanceSchema>;

export const ReviewIRRequestSchema = z.object({
  source: z.string().min(1),
  ir: SolanaIRSchema,
  target: z.enum(["pinocchio", "quasar", "native"]).optional(),
});
export type ReviewIRRequest = z.infer<typeof ReviewIRRequestSchema>;

export const ReviewOutputRequestSchema = z.object({
  source: z.string().min(1),
  ir: SolanaIRSchema,
  target: z.enum(["pinocchio", "quasar", "native"]),
  files: z.array(z.object({ path: z.string(), content: z.string() })).min(1),
  singleFile: z.string().optional(),
});
export type ReviewOutputRequest = z.infer<typeof ReviewOutputRequestSchema>;

export const RepairModeSchema = z.enum([
  "review_only",
  "repair_scoped",
  "fallback_rewrite_scoped",
]);
export type RepairMode = z.infer<typeof RepairModeSchema>;

export const RepairOutputRequestSchema = z.object({
  source: z.string().min(1),
  ir: SolanaIRSchema,
  target: z.enum(["pinocchio", "quasar", "native"]),
  files: z.array(z.object({ path: z.string(), content: z.string() })).min(1),
  selectedFinding: AIReviewFindingSchema,
  selectedFilePath: z.string(),
  mode: RepairModeSchema,
});
export type RepairOutputRequest = z.infer<typeof RepairOutputRequestSchema>;

export const ReviewIRModelResponseSchema = z.object({
  overallConfidence: z.number().min(0).max(1),
  summary: z.string(),
  findings: z.array(AIReviewFindingSchema).default([]),
});

export const ReviewOutputModelResponseSchema = z.object({
  overallConfidence: z.number().min(0).max(1),
  summary: z.string(),
  findings: z.array(AIReviewFindingSchema).default([]),
});

export const RepairOutputModelResponseSchema = z.object({
  filePath: z.string(),
  patchedContent: z.string(),
  rationale: z.string(),
  usedFallbackRewrite: z.boolean().default(false),
  findingsAddressed: z.array(z.string()).default([]),
});

export const ReviewIRResponseSchema = z.object({
  findings: z.array(AIReviewFindingSchema),
  confidence: z.number().min(0).max(1),
  summary: z.string(),
  promptVersion: z.string(),
  provider: AIProviderNameSchema,
  model: z.string(),
  provenance: AIProvenanceSchema,
});
export type ReviewIRResponse = z.infer<typeof ReviewIRResponseSchema>;

export const ReviewOutputResponseSchema = z.object({
  findings: z.array(AIReviewFindingSchema),
  confidence: z.number().min(0).max(1),
  summary: z.string(),
  promptVersion: z.string(),
  provider: AIProviderNameSchema,
  model: z.string(),
  provenance: AIProvenanceSchema,
});
export type ReviewOutputResponse = z.infer<typeof ReviewOutputResponseSchema>;

export const RepairOutputResponseSchema = z.object({
  filePath: z.string(),
  originalContent: z.string(),
  patchedContent: z.string(),
  rationale: z.string(),
  usedFallbackRewrite: z.boolean(),
  accepted: z.boolean(),
  acceptanceReason: z.string(),
  validationIssues: z.array(z.object({
    severity: z.enum(["error", "warning"]),
    message: z.string(),
    path: z.string().optional(),
  })),
  promptVersion: z.string(),
  provider: AIProviderNameSchema,
  model: z.string(),
  provenance: AIProvenanceSchema,
});
export type RepairOutputResponse = z.infer<typeof RepairOutputResponseSchema>;


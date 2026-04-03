import type { ReviewIRRequest } from "../schemas.js";

export const REVIEW_IR_PROMPT_VERSION = "review-ir.v1";

export function buildReviewIRPrompt(input: ReviewIRRequest): string {
  return [
    "You are reviewing Anvil compiler IR for a Solana transpiler.",
    "Return JSON only. Do not include markdown, prose outside JSON, or code fences.",
    "Focus on semantic and compiler-quality issues only.",
    "Find missing constraints, wrong arg/account types, missed CPI patterns, PDA issues, risky pass-through, or likely mismatches between source and IR.",
    "Prefer high-signal findings. Do not invent issues without evidence.",
    "",
    "Rules:",
    "- findings must be instruction/file scoped when possible",
    "- use severity info/warning/error",
    "- confidence must be between 0 and 1",
    "- suggestedAction must be short and concrete",
    "",
    `Target: ${input.target ?? "generic"}`,
    "Source:",
    input.source,
    "",
    "IR JSON:",
    JSON.stringify(input.ir, null, 2),
  ].join("\n");
}

export const REVIEW_IR_RESPONSE_JSON_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    overallConfidence: { type: "number" },
    summary: { type: "string" },
    findings: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          severity: { type: "string", enum: ["info", "warning", "error"] },
          title: { type: "string" },
          summary: { type: "string" },
          filePath: { type: "string" },
          instructionName: { type: "string" },
          fixCategory: {
            type: "string",
            enum: ["constraint", "type", "cpi", "pda", "state", "serialization", "account_validation", "helper", "cleanup", "other"],
          },
          confidence: { type: "number" },
          evidence: { type: "array", items: { type: "string" } },
          suggestedAction: { type: "string" },
        },
        required: ["id", "severity", "title", "summary", "fixCategory", "confidence", "evidence"],
      },
    },
  },
  required: ["overallConfidence", "summary", "findings"],
};


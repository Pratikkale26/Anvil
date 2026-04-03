import type { ReviewOutputRequest } from "../schemas.js";

export const REVIEW_OUTPUT_PROMPT_VERSION = "review-output.v1";

export function buildReviewOutputPrompt(input: ReviewOutputRequest): string {
  const filesBlock = input.files
    .map((file) => `FILE: ${file.path}\n${file.content}`)
    .join("\n\n");

  return [
    "You are reviewing emitted Solana Rust code produced by the Anvil compiler.",
    "Return JSON only. No markdown, no prose outside JSON, no code fences.",
    "Find concrete compile blockers, framework API misuse, semantic mismatches, missing saves, signer seed problems, unsafe remnants, dead helper issues, and validation/security gaps.",
    "Tie findings to file paths whenever possible.",
    "Do not suggest multi-file fixes unless the issue is clearly localized to the selected file.",
    "",
    `Target: ${input.target}`,
    "Source:",
    input.source,
    "",
    "IR JSON:",
    JSON.stringify(input.ir, null, 2),
    "",
    "Generated files:",
    filesBlock,
  ].join("\n");
}

export const REVIEW_OUTPUT_RESPONSE_JSON_SCHEMA: Record<string, unknown> = {
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


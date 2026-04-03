import type { RepairOutputRequest } from "../schemas.js";

export const REPAIR_OUTPUT_PROMPT_VERSION = "repair-output.v1";

export function buildRepairOutputPrompt(input: RepairOutputRequest): string {
  const targetFile = input.files.find((file) => file.path === input.selectedFilePath);
  if (!targetFile) {
    throw new Error(`Selected file '${input.selectedFilePath}' was not found in generated files`);
  }

  return [
    "You are repairing one generated Rust file from the Anvil Solana compiler.",
    "Return JSON only. No markdown, no prose outside JSON, no code fences.",
    "Patch only the selected file. Do not rename the file. Do not change unrelated behavior.",
    "Keep the output target-framework correct.",
    "Remove compile blockers and semantic issues tied to the selected finding when possible.",
    "Fallback rewrite is allowed only for this file.",
    "",
    `Target: ${input.target}`,
    `Mode: ${input.mode}`,
    `Selected file: ${input.selectedFilePath}`,
    "Selected finding JSON:",
    JSON.stringify(input.selectedFinding, null, 2),
    "",
    "Source:",
    input.source,
    "",
    "IR JSON:",
    JSON.stringify(input.ir, null, 2),
    "",
    `Original file (${targetFile.path}):`,
    targetFile.content,
  ].join("\n");
}

export const REPAIR_OUTPUT_RESPONSE_JSON_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    filePath: { type: "string" },
    patchedContent: { type: "string" },
    rationale: { type: "string" },
    usedFallbackRewrite: { type: "boolean" },
    findingsAddressed: { type: "array", items: { type: "string" } },
  },
  required: ["filePath", "patchedContent", "rationale", "usedFallbackRewrite", "findingsAddressed"],
};


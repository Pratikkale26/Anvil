import { evaluateScopedRepairAcceptance } from "./acceptance.js";
import { getAIProvider, isFallbackRewriteEnabled } from "./config.js";
import { writeProvenance, sha256 } from "./provenance.js";
import type { RepairOutputRequest, RepairOutputResponse } from "./schemas.js";
import { RepairOutputModelResponseSchema } from "./schemas.js";
import {
  buildRepairOutputPrompt,
  REPAIR_OUTPUT_PROMPT_VERSION,
  REPAIR_OUTPUT_RESPONSE_JSON_SCHEMA,
} from "./prompts/repair-output.js";

export async function repairOutput(input: RepairOutputRequest): Promise<RepairOutputResponse> {
  if (input.mode === "fallback_rewrite_scoped" && !isFallbackRewriteEnabled()) {
    throw new Error("Fallback rewrite is disabled by configuration");
  }

  const targetFile = input.files.find((file) => file.path === input.selectedFilePath);
  if (!targetFile) {
    throw new Error(`Selected file '${input.selectedFilePath}' was not found in generated files`);
  }

  const { provider, repairModel } = getAIProvider();
  const prompt = buildRepairOutputPrompt(input);
  const raw = await provider.generateStructured({
    schema: REPAIR_OUTPUT_RESPONSE_JSON_SCHEMA,
    prompt,
    model: repairModel,
  });
  const parsed = RepairOutputModelResponseSchema.parse(raw);

  const acceptance = evaluateScopedRepairAcceptance({
    ir: input.ir,
    originalFiles: input.files,
    selectedFilePath: input.selectedFilePath,
    patchedFilePath: parsed.filePath,
    patchedContent: parsed.patchedContent,
  });

  const provenance = {
    timestamp: new Date().toISOString(),
    provider: provider.name,
    model: repairModel,
    promptVersion: REPAIR_OUTPUT_PROMPT_VERSION,
    sourceHash: sha256(input.source),
    irHash: sha256(JSON.stringify(input.ir)),
    target: input.target,
    selectedFile: input.selectedFilePath,
    accepted: acceptance.accepted,
    findingsSummary: [input.selectedFinding.title, ...parsed.findingsAddressed],
  };

  writeProvenance(provenance);

  return {
    filePath: parsed.filePath,
    originalContent: targetFile.content,
    patchedContent: parsed.patchedContent,
    rationale: parsed.rationale,
    usedFallbackRewrite: parsed.usedFallbackRewrite,
    accepted: acceptance.accepted,
    acceptanceReason: acceptance.reason,
    validationIssues: acceptance.validationIssues,
    promptVersion: REPAIR_OUTPUT_PROMPT_VERSION,
    provider: provider.name,
    model: repairModel,
    provenance,
  };
}

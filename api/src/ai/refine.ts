import { getAIProvider } from "./config.js";
import { validateEmitterOutput, type ValidationIssue } from "../emitter/output-validator.js";
import type { SolanaIR, EmitterFile } from "../ir/schema.js";
import { RefineModelResponseSchema } from "./refine-schemas.js";
import type { RefineResponse } from "./refine-schemas.js";
import {
  buildRefinePrompt,
  REFINE_PROMPT_VERSION,
  REFINE_RESPONSE_JSON_SCHEMA,
} from "./prompts/refine.js";

export { REFINE_PROMPT_VERSION };

export type RefineInput = {
  target: "pinocchio" | "quasar" | "native";
  ir: SolanaIR;
  files: EmitterFile[];
  validationIssues: ValidationIssue[];
};

/**
 * Unified AI refinement — makes exactly ONE LLM call.
 *
 * 1. Builds a focused prompt containing ONLY the problematic code sections
 * 2. Sends to Gemini Flash for targeted patches
 * 3. Validates the patched output using the deterministic validator
 * 4. Returns the result (accepted/rejected per file)
 */
export async function refineOutput(
  input: RefineInput,
  onProgress?: (step: string, message: string) => void,
): Promise<RefineResponse> {
  const { provider, repairModel } = getAIProvider();

  onProgress?.("build_prompt", "Building focused refine prompt.");
  const prompt = buildRefinePrompt({
    target: input.target,
    validationIssues: input.validationIssues,
    files: input.files,
  });


  onProgress?.("ai_call", `Sending to ${repairModel} (${(prompt.length / 1024).toFixed(1)}KB prompt).`);
  const raw = await provider.generateStructured({
    schema: REFINE_RESPONSE_JSON_SCHEMA,
    prompt,
    model: repairModel,
    onProgress,
  });

  onProgress?.("validate", "Validating AI response.");
  const parsed = RefineModelResponseSchema.parse(raw);

  // Evaluate each patch
  const patches: RefineResponse["patches"] = [];
  for (const patch of parsed.patches) {
    const originalFile = input.files.find((f) => f.path === patch.filePath);
    if (!originalFile) {
      patches.push({
        filePath: patch.filePath,
        originalContent: "",
        patchedContent: patch.patchedContent,
        accepted: false,
        acceptanceReason: `File '${patch.filePath}' not found in original output.`,
      });
      continue;
    }

    // Apply the patch and re-validate
    const patchedFiles = input.files.map((f) =>
      f.path === patch.filePath ? { ...f, content: patch.patchedContent } : f
    );
    const patchedOutput = { files: patchedFiles, singleFile: "", warnings: [] };
    const patchedIssues = validateEmitterOutput(input.ir, patchedOutput)
      .filter((i) => i.path === patch.filePath);

    const originalIssues = input.validationIssues.filter((i) => i.path === patch.filePath);
    const originalErrors = originalIssues.filter((i) => i.severity === "error");
    const patchedErrors = patchedIssues.filter((i) => i.severity === "error");

    // Accept if patch doesn't make things worse
    const issueKey = (issue: ValidationIssue) => `${issue.severity}:${issue.message}`;
    const originalKeys = new Set(originalIssues.map(issueKey));
    const newIssues = patchedIssues.filter((i) => !originalKeys.has(issueKey(i)));
    const newErrors = newIssues.filter((i) => i.severity === "error");

    if (newErrors.length > 0) {
      patches.push({
        filePath: patch.filePath,
        originalContent: originalFile.content,
        patchedContent: patch.patchedContent,
        accepted: false,
        acceptanceReason: `Patch introduced ${newErrors.length} new error(s).`,
      });
    } else if (patchedErrors.length > originalErrors.length) {
      patches.push({
        filePath: patch.filePath,
        originalContent: originalFile.content,
        patchedContent: patch.patchedContent,
        accepted: false,
        acceptanceReason: `Patch increased errors from ${originalErrors.length} to ${patchedErrors.length}.`,
      });
    } else {
      patches.push({
        filePath: patch.filePath,
        originalContent: originalFile.content,
        patchedContent: patch.patchedContent,
        accepted: true,
        acceptanceReason: `Patch accepted: ${originalErrors.length - patchedErrors.length} error(s) fixed, no new errors.`,
      });
    }
  }

  const accepted = patches.filter((p) => p.accepted).length;
  const total = patches.length;

  onProgress?.("complete", `Refine completed: ${accepted}/${total} patches accepted.`);

  return {
    rationale: parsed.rationale,
    patches,
    summary: `${accepted}/${total} patches accepted`,
    aiCallMade: true,
  };
}

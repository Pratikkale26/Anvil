import { getAIProvider } from "./config.js";
import { validateEmitterOutput, type ValidationIssue } from "../emitter/output-validator.js";
import type { SolanaIR, EmitterFile } from "../ir/schema.js";
import { RefineModelResponseSchema } from "./refine-schemas.js";
import type { RefineResponse } from "./refine-schemas.js";
import { createAICacheKey, readAICache, writeAICache } from "./cache.js";
import { getParser } from "../parser/ts-init.js";
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
 * 2. Sends to the configured repair model for targeted patches
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

  const cacheKey = createAICacheKey({
    version: REFINE_PROMPT_VERSION,
    provider: provider.name,
    model: repairModel,
    target: input.target,
    files: input.files,
    validationIssues: input.validationIssues,
  });

  const cached = await readAICache(cacheKey);
  if (cached) {
    onProgress?.("cache_hit", `Using cached AI refine result ${cacheKey.slice(0, 12)}.`);
    return {
      ...cached,
      aiCallMade: false,
      cached: true,
      cacheKey,
    };
  }

  onProgress?.("ai_call", `Sending to ${repairModel} (${(prompt.length / 1024).toFixed(1)}KB prompt).`);
  const { value: raw, usage } = await provider.generateStructured({
    schema: REFINE_RESPONSE_JSON_SCHEMA,
    prompt,
    model: repairModel,
    onProgress,
  });

  onProgress?.("validate", "Validating AI response.");
  const parsed = RefineModelResponseSchema.parse(raw);

  // Best-effort USD estimate. Sonnet 4 published pricing as of 2026-04:
  //   $3/M input, $15/M output, cache write 1.25× input, cache read 0.1× input.
  // Other models will mis-report — surfaced as "estimated" not exact.
  const estimatedCostUsd =
    (usage.inputTokens * 3 +
      usage.outputTokens * 15 +
      usage.cacheCreationTokens * 3.75 +
      usage.cacheReadTokens * 0.3) /
    1_000_000;

  // Init tree-sitter once for structural pre-checks. Patches whose patchedContent
  // doesn't parse as valid Rust (unbalanced braces, broken expressions) are
  // rejected upfront — the regex validator can miss these and let malformed code
  // through the accept gate.
  const tsParser = await getParser();

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

    // Structural pre-check: reject before re-validation if the patched content
    // doesn't parse as syntactically valid Rust. hasError covers both ERROR
    // nodes (malformed productions) and MISSING nodes (unclosed delimiters).
    const tree = tsParser.parse(patch.patchedContent);
    if (tree && tree.rootNode.hasError) {
      patches.push({
        filePath: patch.filePath,
        originalContent: originalFile.content,
        patchedContent: patch.patchedContent,
        accepted: false,
        acceptanceReason: "Patch contains invalid Rust syntax (unbalanced delimiters or malformed expression).",
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

  // Compute the global error delta — sum across files, since some patches may
  // have fixed file A while others touched file B. The per-patch loop above
  // already validated file-by-file, but the user-facing number is the total.
  const beforeErrors = input.validationIssues.filter((i) => i.severity === "error").length;
  const acceptedFilesByPath = new Map(
    patches.filter((p) => p.accepted).map((p) => [p.filePath, p.patchedContent]),
  );
  const finalFiles = input.files.map((f) =>
    acceptedFilesByPath.has(f.path) ? { ...f, content: acceptedFilesByPath.get(f.path)! } : f,
  );
  const afterIssues = validateEmitterOutput(input.ir, {
    files: finalFiles,
    singleFile: "",
    warnings: [],
  });
  const afterErrors = afterIssues.filter((i) => i.severity === "error").length;

  onProgress?.(
    "complete",
    `Refine completed: ${accepted}/${total} patches accepted, errors ${beforeErrors} → ${afterErrors}.`,
  );

  const result: RefineResponse = {
    rationale: parsed.rationale,
    findings: parsed.findings,
    patches,
    summary: `${accepted}/${total} patches accepted · errors ${beforeErrors} → ${afterErrors}`,
    aiCallMade: true,
    cacheKey,
    cached: false,
    usage: { ...usage, estimatedCostUsd },
    errorDelta: { before: beforeErrors, after: afterErrors },
  };

  await writeAICache(cacheKey, result);

  return result;
}

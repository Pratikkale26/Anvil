/**
 * AI-driven diagnosis for byte-equal differential failures.
 *
 * The differential pipeline produces a DIVERGED ScenarioVerdict with
 * per-field diffs + source-link click-through. This module takes that
 * verdict + the surrounding IR/source/emit and asks the AI provider to
 * produce a categorised diagnosis: source-pattern (user-fixable),
 * anvil-emit-bug (maintainer-fixable), wire-format-mismatch (scenario-
 * fixable), or clock-or-sysvar-drift (pin clock).
 *
 * Reuses the existing AI provider plumbing from ai/refine.ts. No new
 * model config; the same repair model handles diagnosis (cheap; the
 * structured response is small).
 */
import { getAIProvider } from "./config.js";
import { z } from "zod";
import {
  buildDiagnoseDifferentialPrompt,
  DIAGNOSE_DIFFERENTIAL_PROMPT_VERSION,
  type DiagnoseDifferentialInput,
} from "./prompts/diagnose-differential.js";
import { AIError } from "./errors.js";
import { estimateCostUsd } from "./model-pricing.js";

export { DIAGNOSE_DIFFERENTIAL_PROMPT_VERSION };

export const DiagnoseDifferentialResponseSchema = z.object({
  category: z.enum(["source-pattern", "anvil-emit-bug", "wire-format-mismatch", "clock-or-sysvar-drift"]),
  confidence: z.enum(["high", "medium", "low"]),
  diagnosis: z.string().min(1),
  evidenceCited: z.string().min(1),
  suggestedSourcePatch: z.object({
    filePath: z.string(),
    originalSnippet: z.string(),
    patchedSnippet: z.string(),
    explanation: z.string(),
  }).nullable(),
  maintainerNote: z.string(),
});

export type DiagnoseDifferentialResponse = z.infer<typeof DiagnoseDifferentialResponseSchema>;

const DIAGNOSE_DIFFERENTIAL_JSON_SCHEMA = {
  type: "object",
  required: ["category", "confidence", "diagnosis", "evidenceCited", "suggestedSourcePatch", "maintainerNote"],
  properties: {
    category: { type: "string", enum: ["source-pattern", "anvil-emit-bug", "wire-format-mismatch", "clock-or-sysvar-drift"] },
    confidence: { type: "string", enum: ["high", "medium", "low"] },
    diagnosis: { type: "string" },
    evidenceCited: { type: "string" },
    suggestedSourcePatch: {
      type: ["object", "null"],
      properties: {
        filePath: { type: "string" },
        originalSnippet: { type: "string" },
        patchedSnippet: { type: "string" },
        explanation: { type: "string" },
      },
      required: ["filePath", "originalSnippet", "patchedSnippet", "explanation"],
      additionalProperties: false,
    },
    maintainerNote: { type: "string" },
  },
  additionalProperties: false,
};

export interface DiagnoseDifferentialResult {
  response: DiagnoseDifferentialResponse;
  promptVersion: string;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    estimatedCostUsd?: number;
  };
  cached?: boolean;
}

export async function diagnoseDifferentialFailure(
  input: DiagnoseDifferentialInput,
): Promise<DiagnoseDifferentialResult> {
  const { provider, repairModel } = getAIProvider();
  const prompt = buildDiagnoseDifferentialPrompt(input);

  const { value: raw, usage } = await provider.generateStructured({
    schema: DIAGNOSE_DIFFERENTIAL_JSON_SCHEMA as never,
    prompt,
    model: repairModel,
  });

  const parsed = DiagnoseDifferentialResponseSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue ? `${issue.path.join(".") || "root"}: ${issue.message}` : parsed.error.message;
    throw new AIError(
      `AI diagnosis didn't match expected schema (${where}).`,
      "zod_parse_failed",
    );
  }

  const estimatedCostUsd = estimateCostUsd(repairModel, usage);

  return {
    response: parsed.data,
    promptVersion: DIAGNOSE_DIFFERENTIAL_PROMPT_VERSION,
    usage: {
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      estimatedCostUsd,
    },
  };
}

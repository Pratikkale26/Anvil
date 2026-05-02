import { getAIProvider } from "./config.js";
import { validateEmitterOutput, type ValidationIssue } from "../emitter/output-validator.js";
import type { SolanaIR, EmitterFile } from "../ir/schema.js";
import { RefineModelResponseSchema, type RejectedAttempt } from "./refine-schemas.js";
import type { RefineResponse } from "./refine-schemas.js";
import { createAICacheKey, readAICache, writeAICache } from "./cache.js";
import { getParser } from "../parser/ts-init.js";
import { AIError } from "./errors.js";
import {
  buildRefinePrompt,
  REFINE_PROMPT_VERSION,
  REFINE_RESPONSE_JSON_SCHEMA,
} from "./prompts/refine.js";
import { estimateCostUsd } from "./model-pricing.js";

export { REFINE_PROMPT_VERSION };

/**
 * Bumped when the post-AI patch evaluation logic changes (accept gate,
 * structural pre-check, line-delta cap). Folded into the cache key so a
 * logic change invalidates entries even when the prompt didn't change —
 * otherwise stale cached responses re-surface old accept/reject decisions
 * that the new logic would compute differently.
 *
 * v1: tree-sitter syntax pre-check + validator no-new-errors clause
 * v2: line-delta cap (max(5, 2 × issuesAddressed)) added before validator
 */
const REFINE_EVALUATOR_VERSION = "evaluator.v2";

export type RefineInput = {
  target: "pinocchio" | "quasar" | "native";
  ir: SolanaIR;
  files: EmitterFile[];
  validationIssues: ValidationIssue[];
  /**
   * Optional: rejected attempts from a prior refine call on the same IR.
   * The prompt will mention them so the model doesn't repeat the same mistake.
   * Changing this also changes the cache key → retry after rejection bypasses
   * the cache instead of returning the same unhelpful result.
   */
  previousAttempts?: RejectedAttempt[];
  /**
   * Where the issues came from: Anvil's heuristic validator (default) or
   * cargo check (rustc). Cargo-sourced issues get a prefix block in the
   * prompt and a distinct cache key — same files+issues from the two paths
   * must not share a cached AI response because the prompts differ.
   */
  issueSource?: "validator" | "cargo";
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

  const issueSource = input.issueSource ?? "validator";

  onProgress?.("build_prompt", "Building focused refine prompt.");
  const prompt = buildRefinePrompt({
    target: input.target,
    validationIssues: input.validationIssues,
    files: input.files,
    previousAttempts: input.previousAttempts,
    issueSource,
  });

  const cacheKey = createAICacheKey({
    version: REFINE_PROMPT_VERSION,
    evaluator: REFINE_EVALUATOR_VERSION,
    provider: provider.name,
    model: repairModel,
    target: input.target,
    files: input.files,
    validationIssues: input.validationIssues,
    previousAttempts: input.previousAttempts ?? [],
    issueSource,
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
  const schemaResult = RefineModelResponseSchema.safeParse(raw);
  if (!schemaResult.success) {
    // Distinct from malformed_response (non-JSON / garbage body). Here we got
    // valid JSON back but it didn't match our expected shape — usually missing
    // `patches` or wrong field types. Retryable: same prompt with a cache
    // miss (via retry-with-feedback or prompt-version bump) often succeeds.
    const issue = schemaResult.error.issues[0];
    const where = issue ? `${issue.path.join(".") || "root"}: ${issue.message}` : schemaResult.error.message;
    throw new AIError(
      `AI response didn't match the expected JSON schema (${where}).`,
      "zod_parse_failed",
    );
  }
  const parsed = schemaResult.data;

  // Per-model USD estimate. Pricing table lives in `model-pricing.ts` so a
  // model swap (Sonnet → Opus, or vendor change) updates exactly one place
  // instead of drifting silently. Unknown models fall back to Sonnet-class
  // pricing with a one-time console warning.
  const estimatedCostUsd = estimateCostUsd(repairModel, usage);

  // Init tree-sitter once for structural pre-checks. Patches whose patchedContent
  // doesn't parse as valid Rust (unbalanced braces, broken expressions) are
  // rejected upfront — the regex validator can miss these and let malformed code
  // through the accept gate.
  const tsParser = await getParser();

  // Sort patches by filePath so accept/reject ordering is deterministic if the
  // model returns patches in different orders on retry.
  const sortedPatches = [...parsed.patches].sort((a, b) =>
    a.filePath.localeCompare(b.filePath),
  );

  // Running state: starts as the original files, gains each accepted patch.
  // Subsequent patches are validated against this running state so patch B
  // sees patch A's fix — and a patch that breaks a *different* file is
  // rejected even if the file it modifies looks clean on its own.
  let runningFiles: EmitterFile[] = [...input.files];
  const issueKey = (issue: ValidationIssue) =>
    `${issue.severity}:${issue.path ?? ""}:${issue.message}`;
  const beforeErrors = input.validationIssues.filter((i) => i.severity === "error").length;

  // Per-file count of issues actually addressed by the model. Used for the
  // line-delta accept gate: a patch should only need ~2× the issue count in
  // line-delta to fix what was asked. Anything larger is the model rewriting
  // unrelated code, which has empirically tripped the validator's no-new-
  // errors clause far more than it has helped.
  const issuesByPath = new Map<string, number>();
  for (const issue of input.validationIssues) {
    if (issue.severity !== "error") continue;
    const k = issue.path ?? "";
    issuesByPath.set(k, (issuesByPath.get(k) ?? 0) + 1);
  }

  // Evaluate each patch
  const patches: RefineResponse["patches"] = [];
  for (const patch of sortedPatches) {
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

    // Line-delta accept gate. The model's prompt asks for "minimal edit"
    // (~2× line-delta per issue addressed); empirically Sonnet 4.6 ignores
    // this and over-edits — counter test showed Δlines=-40 fixing a 1-line
    // corruption, with 4 collateral validator errors. The validator's
    // no-new-errors clause was catching this AFTER the fact, but with a
    // generic 'introduced N new errors' rejection that doesn't tell the
    // user the patch was structurally too large.
    //
    // Now: enforce the line-delta cap deterministically — same threshold
    // the prompt asks for (max(5, 2 * issuesAddressed)). Patches over the
    // cap are rejected here with a clearer reason BEFORE the validator
    // runs. Future model upgrades that DO honor minimal-edit fall through
    // unchanged; the cap only fires on actual over-edit.
    const issuesAddressed = issuesByPath.get(patch.filePath) ?? 0;
    const origLineCount = originalFile.content.split("\n").length;
    const patchedLineCount = patch.patchedContent.split("\n").length;
    const deltaLines = Math.abs(patchedLineCount - origLineCount);
    const maxAllowedDelta = Math.max(5, 2 * issuesAddressed);
    if (deltaLines > maxAllowedDelta) {
      patches.push({
        filePath: patch.filePath,
        originalContent: originalFile.content,
        patchedContent: patch.patchedContent,
        accepted: false,
        acceptanceReason: `Patch over-edits: |Δlines|=${deltaLines} exceeds cap of ${maxAllowedDelta} (max(5, 2 × ${issuesAddressed} issues addressed)). The prompt asks for a minimal edit; this patch rewrites more than the listed issues require.`,
      });
      continue;
    }

    // Validate globally — applying this patch to the running state and checking
    // the full output, not just this one file. Catches cross-file breakage
    // (e.g. a patch in instructions/mod.rs that removes a `pub use` lib.rs depends on).
    const runningIssues = validateEmitterOutput(input.ir, {
      files: runningFiles,
      singleFile: "",
      warnings: [],
    });
    const candidateFiles = runningFiles.map((f) =>
      f.path === patch.filePath ? { ...f, content: patch.patchedContent } : f,
    );
    const candidateIssues = validateEmitterOutput(input.ir, {
      files: candidateFiles,
      singleFile: "",
      warnings: [],
    });

    const runningKeys = new Set(runningIssues.map(issueKey));
    const newIssues = candidateIssues.filter((i) => !runningKeys.has(issueKey(i)));
    const newErrors = newIssues.filter((i) => i.severity === "error");
    const runningErrors = runningIssues.filter((i) => i.severity === "error").length;
    const candidateErrors = candidateIssues.filter((i) => i.severity === "error").length;

    if (newErrors.length > 0) {
      const offendingPaths = Array.from(new Set(newErrors.map((e) => e.path).filter(Boolean)));
      const where = offendingPaths.length === 1 && offendingPaths[0] === patch.filePath
        ? ""
        : offendingPaths.length > 0
          ? ` (in ${offendingPaths.join(", ")})`
          : "";
      patches.push({
        filePath: patch.filePath,
        originalContent: originalFile.content,
        patchedContent: patch.patchedContent,
        accepted: false,
        acceptanceReason: `Patch introduced ${newErrors.length} new error(s)${where}.`,
      });
    } else if (candidateErrors > runningErrors) {
      patches.push({
        filePath: patch.filePath,
        originalContent: originalFile.content,
        patchedContent: patch.patchedContent,
        accepted: false,
        acceptanceReason: `Patch increased total errors from ${runningErrors} to ${candidateErrors}.`,
      });
    } else {
      patches.push({
        filePath: patch.filePath,
        originalContent: originalFile.content,
        patchedContent: patch.patchedContent,
        accepted: true,
        acceptanceReason: `Patch accepted: ${runningErrors - candidateErrors} error(s) fixed, no regressions.`,
      });
      // Commit to running state so subsequent patches see this fix.
      runningFiles = candidateFiles;
    }
  }

  const accepted = patches.filter((p) => p.accepted).length;
  const total = patches.length;
  // Aggregate over-edit signal: total |Δlines| across all returned patches
  // (rejected + accepted). Used for production telemetry — model drift
  // toward over-editing is visible as a rising aggregate even when the
  // cap is doing its job and rejecting before validation.
  const totalDeltaLines = sortedPatches.reduce((sum, p) => {
    const orig = input.files.find((f) => f.path === p.filePath);
    if (!orig) return sum;
    return sum + Math.abs(p.patchedContent.split("\n").length - orig.content.split("\n").length);
  }, 0);
  const overEditRejections = patches.filter(
    (p) => !p.accepted && p.acceptanceReason.startsWith("Patch over-edits"),
  ).length;

  // Final global count — runningFiles already has every accepted patch applied
  // in order, so this is just one validate on the final state.
  const afterIssues = validateEmitterOutput(input.ir, {
    files: runningFiles,
    singleFile: "",
    warnings: [],
  });
  const afterErrors = afterIssues.filter((i) => i.severity === "error").length;

  onProgress?.(
    "complete",
    `Refine completed: ${accepted}/${total} patches accepted, errors ${beforeErrors} → ${afterErrors}.`,
  );

  // Sentry breadcrumb — best-effort, only when DSN is set. Lets you grep
  // production for "did this prompt-version regress accept-rate?" without
  // full transaction tracing. Lazy-loaded so SENTRY_DSN-unset deploys
  // never resolve the @sentry/node import.
  if (process.env.SENTRY_DSN) {
    try {
      const Sentry = await import("@sentry/node");
      Sentry.addBreadcrumb({
        category: "ai.refine",
        level: "info",
        message: `refine ${accepted}/${total} accepted · errors ${beforeErrors}→${afterErrors}`,
        data: {
          target: input.target,
          promptVersion: REFINE_PROMPT_VERSION,
          model: repairModel,
          provider: provider.name,
          fileCount: input.files.length,
          issueCount: input.validationIssues.length,
          issueSource,
          patchesProposed: total,
          patchesAccepted: accepted,
          errorsBefore: beforeErrors,
          errorsAfter: afterErrors,
          inputTokens: usage?.inputTokens,
          outputTokens: usage?.outputTokens,
          cacheReadTokens: usage?.cacheReadTokens,
          estimatedCostUsd,
          // Over-edit signal — track at telemetry level so model drift toward
          // larger patches is visible even when the line-delta gate rejects
          // them. Promoted from the differential-with-ai diagnostic log so
          // production refines surface this without re-instrumenting.
          totalDeltaLines,
          overEditRejections,
        },
      });
    } catch { /* breadcrumb is best-effort; never fail the refine on it */ }
  }

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

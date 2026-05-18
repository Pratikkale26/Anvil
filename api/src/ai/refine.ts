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
 * v3: item-count structural pre-check (drop > 1 top-level pub item rejects)
 */
const REFINE_EVALUATOR_VERSION = "evaluator.v3";

/**
 * Top-level Rust item counter — used by the accept gate's structural
 * pre-check. Counts pub fn / pub struct / pub enum / pub trait /
 * pub const / impl / use at the start of a line. Nested items inside
 * fn bodies are excluded by anchoring on /^/m.
 *
 * Exported for unit testing.
 */
const TOP_LEVEL_ITEM_REGEX = /^[\s]*(?:pub(?:\s*\([^)]+\))?\s+)?(?:fn|struct|enum|trait|const|impl|use)\b/gm;
export function countTopLevelItems(src: string): number {
  const m = src.match(TOP_LEVEL_ITEM_REGEX);
  return m ? m.length : 0;
}

/**
 * Decide accept/reject for a single patch via the deterministic gates.
 * Returns null when the gates pass (patch falls through to the validator
 * stage) or a rejection reason when the patch should be rejected.
 *
 * Gate order:
 *   1. file-not-found    → patch references an unknown file
 *   2. tree-sitter parse → patch isn't valid Rust syntax
 *   3. item-count        → patch dropped > 1 top-level pub item
 *   4. line-delta cap    → |Δlines| > max(5, 2 × issuesAddressed)
 *
 * Pure function — no I/O, deterministic per input. Easy to unit-test.
 */
export function evaluatePatchGates(input: {
  patchedContent: string;
  originalContent: string | null;
  issuesAddressed: number;
  parseHasError: boolean;
}): { reject: false } | { reject: true; reason: string } {
  if (input.originalContent === null) {
    return { reject: true, reason: "File not found in original output." };
  }
  if (input.parseHasError) {
    return {
      reject: true,
      reason: "Patch contains invalid Rust syntax (unbalanced delimiters or malformed expression).",
    };
  }
  const origItems = countTopLevelItems(input.originalContent);
  const patchedItems = countTopLevelItems(input.patchedContent);
  if (origItems - patchedItems > 1) {
    return {
      reject: true,
      reason: `Patch dropped ${origItems - patchedItems} top-level item(s) (was ${origItems}, now ${patchedItems}). The model removed pub fn / pub struct / impl / use that the validation issues didn't reference. Tree-sitter accepts this as legal Rust — but those items are likely referenced by sibling files, and the dropped surface is almost always over-edit, not a fix.`,
    };
  }
  const origLines = input.originalContent.split("\n").length;
  const patchedLines = input.patchedContent.split("\n").length;
  const deltaLines = Math.abs(patchedLines - origLines);
  const maxAllowedDelta = Math.max(5, 2 * input.issuesAddressed);
  if (deltaLines > maxAllowedDelta) {
    return {
      reject: true,
      reason: `Patch over-edits: |Δlines|=${deltaLines} exceeds cap of ${maxAllowedDelta} (max(5, 2 × ${input.issuesAddressed} issues addressed)). The prompt asks for a minimal edit; this patch rewrites more than the listed issues require.`,
    };
  }
  return { reject: false };
}

export type RefineInput = {
  target: "pinocchio" | "native";
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

  // Baseline pre-check (audit task #79): if any input file fails to
  // tree-sitter parse, the error-delta accept gate downstream has no
  // trustworthy baseline. A model-returned patch could pass tree-sitter
  // on its own output, drop the regex-detectable errors to zero, and
  // slip through with garbage semantics — the gate would see
  // `errors_after (0) < errors_before` and accept. Refuse upfront so
  // the user fixes the input first AND we don't spend on a doomed
  // LLM call. Has to run before the API request, not just before the
  // accept loop.
  const baselineParser = await getParser();
  for (const file of input.files) {
    const inputTree = baselineParser.parse(file.content);
    if (inputTree?.rootNode.hasError) {
      throw new Error(
        `refine baseline: input file '${file.path}' has tree-sitter parse errors. ` +
        `The error-delta accept gate requires a parseable baseline; fix the syntax ` +
        `first, then retry refine. (If unexpected, the file may have been corrupted ` +
        `by a prior partial fix — re-run anvil compile from the original source.)`,
      );
    }
  }

  onProgress?.("build_prompt", "Building focused refine prompt.");
  const prompt = await buildRefinePrompt({
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
  // through the accept gate. (Baseline parse-check fired at the top of the
  // function; this parser instance handles per-patch checks below.)
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

  // Evaluate each patch — first the deterministic gates (file-not-found,
  // tree-sitter parse, item-count, line-delta), then the validator's
  // no-new-errors clause for what falls through.
  const patches: RefineResponse["patches"] = [];
  for (const patch of sortedPatches) {
    const originalFile = input.files.find((f) => f.path === patch.filePath);
    const tree = originalFile ? tsParser.parse(patch.patchedContent) : null;
    const gateResult = evaluatePatchGates({
      patchedContent: patch.patchedContent,
      originalContent: originalFile?.content ?? null,
      issuesAddressed: issuesByPath.get(patch.filePath) ?? 0,
      parseHasError: !!tree?.rootNode.hasError,
    });
    if (gateResult.reject) {
      patches.push({
        filePath: patch.filePath,
        originalContent: originalFile?.content ?? "",
        patchedContent: patch.patchedContent,
        accepted: false,
        acceptanceReason: gateResult.reason,
      });
      continue;
    }
    // After this point originalFile is guaranteed defined (gate would have
    // rejected otherwise) — but TS doesn't know, so re-derive.
    if (!originalFile) continue;

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
  const itemCountRejections = patches.filter(
    (p) => !p.accepted && p.acceptanceReason.startsWith("Patch dropped"),
  ).length;
  // Surface to /metrics via metrics.recordRefineOverEdit. Lazy-import to
  // avoid a circular dep (refine -> metrics -> nothing, but metrics is
  // imported by routes that import refine; the dynamic import here keeps
  // the module graph clean).
  void (async () => {
    try {
      const { metrics } = await import("../metrics.js");
      metrics.recordRefineOverEdit({
        totalDeltaLines,
        rejectionsByLineDelta: overEditRejections,
        rejectionsByItemCount: itemCountRejections,
      });
    } catch {
      // best-effort; metrics is optional
    }
  })();

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

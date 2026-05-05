/**
 * Prompt for /ai/diagnose-differential — explain a byte-equal divergence
 * to the user + suggest a source patch when one is appropriate.
 *
 * Input shape (built from a DIVERGED ScenarioVerdict + the surrounding IR):
 *   - the diverging account's per-field diff (anchor side vs anvil side)
 *   - the IR statement that wrote that field (state_field_assign with
 *     source link, when known)
 *   - the original Anchor source snippet for the diverging instruction
 *   - the Anvil-emitted Pinocchio/Native source for the same handler
 *
 * Output: a human-readable diagnosis + an OPTIONAL source-side patch
 * the user could apply (when the divergence is plausibly caused by a
 * source-level pattern Anvil can't transpile correctly — e.g. a manual
 * borsh layout that doesn't match Anchor's auto-derive). When the
 * divergence is on Anvil's side (Anvil's emit produced wrong bytes for
 * a correctly-written source), the response says so explicitly and
 * marks the suggestion category as "anvil-emit-bug" — that's a flag for
 * the maintainer, not a fix the user can apply.
 */

export const DIAGNOSE_DIFFERENTIAL_PROMPT_VERSION = "diagnose-differential.v1";

export const DIAGNOSE_DIFFERENTIAL_SYSTEM_RULES = [
  "You are diagnosing a byte-equal differential failure. The user's program compiled successfully on both Anchor (reference) and Anvil's emit, but at runtime the on-chain account state diverged between the two.",
  "Your job: explain WHY the bytes differ in plain English (1-2 paragraphs), then categorize the cause as one of:",
  "  - `source-pattern`: the user's source uses an Anchor pattern Anvil can't transpile correctly. Suggest a source-side rewrite they can apply.",
  "  - `anvil-emit-bug`: Anvil's emitter produced wrong bytes for a correctly-written source. Mark for maintainer review, no user-actionable fix.",
  "  - `wire-format-mismatch`: the call-site account ordering / instruction data layout differs between the test scenario and what one of the .so files expects. Source isn't wrong; the scenario JSON is.",
  "  - `clock-or-sysvar-drift`: the divergence depends on a runtime sysvar value that varies between runs (clock, recent slot). Suggest pinning it via scenario.clock.",
  "",
  "Return valid JSON only. No markdown fences. No prose outside the JSON object.",
  "",
  "── HARD RULES ──",
  "1. NEVER guess. If you can't tell whether the cause is source-pattern vs anvil-emit-bug from the evidence, say so explicitly in `diagnosis` and pick the more conservative category.",
  "2. NEVER suggest source patches that change the program's externally-observable behavior. The whole point of byte-equal is the user wants identical semantics; suggesting `change this u64 to u32` is wrong.",
  "3. If the field-diff has all-zero on the Anvil side and populated on the Anchor side, that's a strong signal Anvil failed to write the field (anvil-emit-bug, not source-pattern).",
  "4. If both sides are populated but with different values, suspect a runtime-dependent value (clock, slot, dynamic program ID).",
  "5. Patch suggestions, when offered, are MINIMAL — change the smallest span that resolves the divergence. The same line-delta cap as the refine prompt: max(5, 2 × number of issues addressed).",
  "",
  "── OUTPUT JSON SCHEMA (strict — extra keys rejected) ──",
  '{',
  '  "category": "source-pattern" | "anvil-emit-bug" | "wire-format-mismatch" | "clock-or-sysvar-drift",',
  '  "confidence": "high" | "medium" | "low",',
  '  "diagnosis": "<1-2 paragraphs explaining why the bytes diverge>",',
  '  "evidenceCited": "<one sentence naming the specific bytes / fields / IR statement that anchor your diagnosis>",',
  '  "suggestedSourcePatch": null | { "filePath": "<path>", "originalSnippet": "<exact lines being replaced>", "patchedSnippet": "<replacement>", "explanation": "<why this fixes the divergence>" },',
  '  "maintainerNote": "<empty string when category != anvil-emit-bug; otherwise a precise pointer to the IR statement / emit handler / regex post-process step that produced the wrong bytes>"',
  '}',
];

export interface DiagnoseDifferentialInput {
  /** The DIVERGED account's name + per-field diff. */
  divergence: {
    accountName: string;
    accountType?: string; // matched IR AccountDef name
    fieldDiffs?: Array<{
      field: string;
      anchor: unknown;
      anvil: unknown;
      equal: boolean;
      sourceLink?: { instruction: string; line: number; column: number };
    }>;
    firstDiffByte?: number;
    anchorHex?: string;
    anvilHex?: string;
  };
  /** Original Anchor source snippet for the instruction that wrote the diverging account. */
  sourceSnippet?: string;
  /** Anvil-emitted Pinocchio/Native source for the same handler. */
  emittedSnippet?: string;
  /** The IR's accountType.fields list for richer context. */
  accountFields?: Array<{ name: string; type: string }>;
  /** Target: pinocchio | native. */
  target?: "pinocchio" | "native";
}

function stringifySafe(v: unknown): string {
  if (typeof v === "bigint") return `${v.toString()}n`;
  try {
    return JSON.stringify(v, (_k, val) => (typeof val === "bigint" ? `${val.toString()}n` : val));
  } catch {
    return String(v);
  }
}

export function buildDiagnoseDifferentialPrompt(input: DiagnoseDifferentialInput): string {
  const sections: string[] = [];
  sections.push(...DIAGNOSE_DIFFERENTIAL_SYSTEM_RULES);
  sections.push("");
  sections.push(`── DIVERGENCE CONTEXT ──`);
  sections.push(`Target: ${input.target ?? "pinocchio"}`);
  sections.push(`Account: ${input.divergence.accountName}${input.divergence.accountType ? ` (${input.divergence.accountType})` : ""}`);
  if (input.divergence.firstDiffByte !== undefined) {
    sections.push(`First diverging byte offset (post-discriminator-strip): ${input.divergence.firstDiffByte}`);
  }
  if (input.divergence.anchorHex) sections.push(`Anchor reference hex (first ~64 bytes): ${input.divergence.anchorHex}`);
  if (input.divergence.anvilHex) sections.push(`Anvil emit hex   (first ~64 bytes): ${input.divergence.anvilHex}`);
  if (input.divergence.fieldDiffs?.length) {
    sections.push(``);
    sections.push(`── PER-FIELD DIFFS ──`);
    for (const f of input.divergence.fieldDiffs) {
      const tag = f.equal ? "=" : "≠";
      sections.push(`  ${tag} ${f.field}: anchor=${stringifySafe(f.anchor)} anvil=${stringifySafe(f.anvil)}${
        f.sourceLink ? ` (writes from ${f.sourceLink.instruction} @ line ${f.sourceLink.line})` : ""
      }`);
    }
  }
  if (input.accountFields?.length) {
    sections.push(``);
    sections.push(`── IR ACCOUNT FIELDS ──`);
    for (const f of input.accountFields) {
      sections.push(`  ${f.name}: ${f.type}`);
    }
  }
  if (input.sourceSnippet) {
    sections.push(``);
    sections.push(`── ORIGINAL ANCHOR SOURCE (handler) ──`);
    sections.push("```rust");
    sections.push(input.sourceSnippet.slice(0, 4000));
    sections.push("```");
  }
  if (input.emittedSnippet) {
    sections.push(``);
    sections.push(`── ANVIL EMIT (same handler) ──`);
    sections.push("```rust");
    sections.push(input.emittedSnippet.slice(0, 4000));
    sections.push("```");
  }
  return sections.join("\n");
}

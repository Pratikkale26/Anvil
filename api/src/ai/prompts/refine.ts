import type { ValidationIssue } from "../../emitter/output-validator.js";
import type { RejectedAttempt } from "../refine-schemas.js";

// Bumped to v5: added pinocchio is_signer/is_writable method-call hint and
// hard "do not fabricate symbols" rule. Cache key folds in this version so
// v4 cached results never collide.
export const REFINE_PROMPT_VERSION = "refine.v6"; // bumped for sonnet-4-6 upgrade — invalidates file-cache for clean cost telemetry

/** Max preview length per rejected attempt — keeps retry prompts bounded. */
const REJECTED_ATTEMPT_PREVIEW_CHARS = 2000;
/** Max number of rejected attempts to include — newest first. */
const MAX_REJECTED_ATTEMPTS = 2;

/**
 * Static system rules. Co-located in the cached prompt prefix so Anthropic's
 * prompt cache engages (1024-token minimum, 5-min TTL).
 *
 * Two layers: rigid rules for the JSON contract, then framework-specific
 * guidance the model can draw on while patching. The framework section is
 * load-bearing — without it the model falls back on Anchor patterns it has
 * seen far more of in training, which is the most common failure mode.
 */
export const REFINE_SYSTEM_RULES = [
  "You are repairing generated Solana Rust code emitted by Anvil from a typed SolanaIR.",
  "Anvil transpiles Anchor programs into framework-agnostic Rust for the Pinocchio, Quasar, or Native targets.",
  "Your job is narrow: take the user's broken file(s) plus deterministic validation findings, and return a JSON object with one full-file patch per file you fix.",
  "Return valid JSON only. No markdown fences, no prose outside the JSON object.",
  "",
  "── HARD RULES (non-negotiable) ──",
  "1. Output the COMPLETE patched file content for each file you touch — never partial diffs, never `... unchanged ...` placeholders.",
  "2. Fix ONLY the listed validation issues. Do not refactor unrelated code, rename functions, reorder items, or 'while you're here' clean things up.",
  "3. Preserve every comment, doc string, function name, item ordering, lifetime annotation, and the existing behavior of correct code.",
  "4. Do NOT change the framework target. Pinocchio code stays Pinocchio. Quasar stays Quasar. Native stays solana_program. The user states the target — match it.",
  "5. If a fix requires more context than the prompt gives you (e.g. a private helper you can't see), leave a `// TODO(manual): <one-line explanation>` marker AT the affected line, do NOT invent imports/types/signatures, and add a finding explaining what's missing.",
  "6. Patches must compile in isolation: import every type you reference, balance every brace/paren/bracket, return the declared type from every function, propagate `?` correctly.",
  "7. Findings are compact — only cover issues you addressed or couldn't fully address. Skip findings for trivial mechanical fixes.",
  "8. Never emit `panic!`, `.unwrap()` on Option<T>/Result<T,E> from on-chain data, or `unsafe` outside of explicitly-acknowledged zero-init blocks.",
  "9. Do not include `unimplemented!()` or `todo!()` macros — leave the TODO(manual) comment marker instead.",
  "10. NEVER fabricate symbols. If your fix references a function (e.g. `bump_seed(...)`, `create_program_account(...)`), constant (e.g. `SEED_PREFIX`), method (e.g. `Foo::required_space()`), or type that you cannot see defined in the input files OR import from a real crate already in scope, you are guessing — that's a regression, not a fix. Either define the missing item inline (if the fix obviously requires it and the body is one-liner) or leave a `// TODO(manual): <what's missing>` and explain in `findings`. Do NOT replace one E0425/E0599 with another.",
  "",
  "── PINOCCHIO TARGET HINTS ──",
  "• Account access: instructions take `accounts: &[AccountInfo]` — no Anchor wrappers, no `ctx.accounts`. Index into the slice.",
  "• `AccountInfo` flag accessors (`is_signer`, `is_writable`, `is_executable`) are METHODS in pinocchio — call with parens: `acc.is_signer()`, NOT `acc.is_signer`. Treating them as fields produces E0615 (`attempted to take value of method`). Same for `key()`, `lamports()`, `data_len()`, `owner()`.",
  "• Logging: use `pinocchio::log::sol_log(&str)`. NEVER `msg!`.",
  "• Errors: return `ProgramError::InvalidArgument`, `ProgramError::AccountDataTooSmall`, etc. NEVER `error!`/`require!`/Anchor `#[error_code]`.",
  "• PDAs: derive with `pinocchio::pubkey::find_program_address(seeds, program_id)`. Always store the bump on the account or recompute.",
  "• System / SPL CPIs: use `pinocchio_system::instructions::*` and `pinocchio_token::instructions::*` builders. NEVER `anchor_lang::system_program::*`, NEVER `anchor_spl::*`, NEVER `solana_program::program::invoke` — pinocchio_* builders already wrap the invoke call.",
  "• Account state: define `#[repr(C)]` structs (or `#[repr(C, packed)]`) with manual `from_account_info` / `save` helpers. NEVER `#[account]`.",
  "• No `#[derive(Accounts)]`, no `#[program]`, no `#[instruction]` — these are Anchor-only attribute macros.",
  "",
  "── QUASAR TARGET HINTS ──",
  "• Quasar accepts `ctx.accounts` syntactic sugar inside `#[program]` — leave existing Quasar idioms intact when refining Quasar code.",
  "• Use `quasar_lang::prelude::*` and `quasar_spl::*` (NOT anchor_lang/anchor_spl).",
  "• Discriminators: each instruction must have a unique 8-byte discriminator (Quasar generates from the instruction name hash).",
  "• `declare_id!()` must appear exactly once at the crate root.",
  "",
  "── NATIVE TARGET HINTS ──",
  "• Built on `solana_program` directly — no framework wrappers.",
  "• Logging: `solana_program::msg!()` is fine here.",
  "• Account deserialization: borsh by hand, with explicit `try_from_slice` + length checks.",
  "• Use `invoke` / `invoke_signed` for CPIs with manual `Instruction` construction.",
  "",
  "── RUSTC ERROR CODE → FIX SHAPE (when issue source is cargo) ──",
  "• E0425 `cannot find function/value X` → fix the IMPORT or remove the call. Do NOT re-spell X as Y you also can't see.",
  "• E0432 `unresolved import` → check Cargo.toml dep is in scope; fix the import path; if the module doesn't exist in this target, drop it and inline the logic.",
  "• E0433 `failed to resolve: use of unresolved module/crate` → either add the right import or replace the call with the target-framework equivalent. NEVER paper over with `solana_program::*` from a pinocchio file.",
  "• E0599 `no associated item/function named X found for struct Y` → Y::X doesn't exist. Either it should be a free function call, or X belongs to a trait you didn't import, or the impl block was never emitted. Don't fabricate the impl unless the body is trivially one-line and obviously correct.",
  "• E0615 `attempted to take value of method` → missing parentheses on a method call (most often pinocchio `acc.is_signer` → `acc.is_signer()`).",
  "• E0609 `no field X on type Y` → Y is opaque (e.g. raw AccountInfo). Unpack first (`Mint::unpack(...)?.X`) or pass X in as a separate argument.",
  "• E0277 `?` couldn't convert error → add a `.map_err(|e| Into::into(e))?` or change the function's return type to one that has `From<E>`.",
  "• E0061 `takes N arguments but M were supplied` → look at the constructor/variant signature and pass the correct count. Don't omit required fields.",
  "",
  "── COMMON ANTI-PATTERNS THE VALIDATOR FLAGS ──",
  "• `ctx.accounts.X` / `ctx.bumps.X` leakage → replace with the AccountInfo-slice indexing the surrounding code uses.",
  "• `CpiContext::new(...)` → replace with the framework's CPI builder; never construct CpiContext outside Anchor.",
  "• `anchor_lang::*` / `anchor_spl::*` imports → swap for the target-framework equivalents.",
  "• `require!(cond, Err)` → replace with `if !(cond) { return Err(ProgramError::...); }` (or framework-idiomatic error return).",
  "• `emit!(Event { .. })` → replace with `sol_log_data(&[...])` on Pinocchio/Native.",
  "• `Pubkey::from_str(\"...\")` → use a `pub const FOO: Pubkey = Pubkey::new_from_array([...])` or take the value as a parameter.",
  "• `.try_into().unwrap()` → use `.try_into().map_err(|_| ProgramError::...)?`.",
  "• Unbalanced braces, missing imports, undefined associated constants → the file won't compile; fix the structural issue, don't paper over it.",
  "",
  "── OUTPUT JSON SCHEMA (strict — extra keys are rejected) ──",
  '{',
  '  "rationale": "1-3 sentences explaining your overall approach",',
  '  "findings": [',
  '    {',
  '      "severity": "error" | "warning" | "info",',
  '      "filePath": "<optional path>",',
  '      "title": "<short title>",',
  '      "explanation": "<why this matters in 1-2 sentences>",',
  '      "suggestedFix": "<what you did, or what the user needs to do manually>"',
  '    }',
  '  ],',
  '  "patches": [',
  '    { "filePath": "<must match an input file path exactly>", "patchedContent": "<COMPLETE patched file>" }',
  '  ]',
  '}',
  "",
  "If you have nothing to fix, still return the schema shape with `patches: []` and explain in the rationale why no change was warranted.",
].join("\n");

/**
 * Build a focused AI prompt containing ONLY the code sections that have issues.
 * This is dramatically smaller than the old review-output prompt (~5-10KB vs 30-50KB).
 *
 * When `previousAttempts` is supplied (user clicked retry after a failed refine),
 * the rejected patches + reasons are prepended so the model sees what went wrong
 * and can pick a different approach.
 */
export function buildRefinePrompt(input: {
  target: string;
  validationIssues: ValidationIssue[];
  files: Array<{ path: string; content: string }>;
  previousAttempts?: RejectedAttempt[];
  /**
   * Where the validation issues came from. "validator" (default) means
   * Anvil's regex/structural heuristics fired; "cargo" means rustc itself
   * complained. Cargo errors get a prefix block telling the model to trust
   * the file/line/code as ground truth — they're not heuristics.
   */
  issueSource?: "validator" | "cargo";
}): string {
  // Collect unique files that have issues
  const issuePaths = new Set(
    input.validationIssues
      .map((i) => i.path)
      .filter((p): p is string => !!p)
  );

  // If no per-file issues, pick first file
  if (issuePaths.size === 0 && input.files.length > 0 && input.files[0]) {
    issuePaths.add(input.files[0].path);
  }

  // Extract only the problematic sections from each file.
  // For each issue with a line number, extract a ~40-line window around it.
  // If no line numbers, include the full file but truncated.
  const sections: string[] = [];

  for (const filePath of issuePaths) {
    const file = input.files.find((f) => f.path === filePath);
    if (!file) continue;

    const fileIssues = input.validationIssues.filter((i) => i.path === filePath);
    const linesWithNumbers = fileIssues.filter((i) => i.line !== undefined);

    if (linesWithNumbers.length > 0) {
      // Extract windows around each issue line
      const allLines = file.content.split("\n");
      const ranges: Array<[number, number]> = [];
      for (const issue of linesWithNumbers) {
        const line = issue.line!;
        const start = Math.max(0, line - 20);
        const end = Math.min(allLines.length, line + 20);
        ranges.push([start, end]);
      }
      // Merge overlapping ranges
      const merged = mergeRanges(ranges);
      for (const [start, end] of merged) {
        const snippet = allLines.slice(start, end).join("\n");
        sections.push(`--- ${filePath}:${start + 1}-${end} ---\n${snippet}`);
      }
    } else {
      // No line numbers — include full file but truncate to 6000 chars
      const truncated = file.content.length > 6000
        ? `${file.content.slice(0, 6000)}\n... [truncated ${file.content.length - 6000} chars]`
        : file.content;
      sections.push(`--- ${filePath} (full) ---\n${truncated}`);
    }
  }

  // Format issues as a numbered list
  const issueList = input.validationIssues
    .map((issue, i) => {
      const loc = issue.path ? `${issue.path}${issue.line ? `:${issue.line}` : ""}` : "general";
      return `${i + 1}. [${issue.severity.toUpperCase()}] ${loc} — ${issue.message}`;
    })
    .join("\n");

  // Retry feedback — only present when the user clicked retry after a prior
  // attempt failed validation. Bounded in size (N attempts × M chars each) so
  // this doesn't explode context on large programs.
  const retryBlock: string[] = [];
  if (input.previousAttempts && input.previousAttempts.length > 0) {
    const recent = input.previousAttempts.slice(-MAX_REJECTED_ATTEMPTS);
    retryBlock.push(
      "── PRIOR ATTEMPT REJECTED — DO NOT REPEAT THESE MISTAKES ──",
      "Your previous attempt on this same input was rejected by the validator.",
      "Below is what you tried and why it was thrown out. Pick a different approach this time — do not produce the same patch again.",
      "",
    );
    for (const [i, a] of recent.entries()) {
      const preview = a.patchedContentPreview.length > REJECTED_ATTEMPT_PREVIEW_CHARS
        ? `${a.patchedContentPreview.slice(0, REJECTED_ATTEMPT_PREVIEW_CHARS)}\n... [truncated]`
        : a.patchedContentPreview;
      retryBlock.push(
        `── Rejected attempt ${i + 1}: ${a.filePath} ──`,
        `Reason: ${a.acceptanceReason}`,
        "What you tried (truncated):",
        preview,
        "",
      );
    }
  }

  // When cargo is the source, prepend a short trust-the-locations block.
  // The model has seen far more validator-style heuristic errors than rustc
  // diagnostics during training, so without this hint it sometimes ignores
  // the line/code and "fixes" something else it thinks is the real bug.
  const cargoPrefix: string[] = [];
  if (input.issueSource === "cargo") {
    cargoPrefix.push(
      "── ISSUE SOURCE: cargo check (rustc diagnostics) ──",
      "These issues are exact Rust compiler errors with file:line:column locations and rustc error codes (E0XXX). Trust the file/line/code as ground truth. Each error code has a canonical fix; use the code (not just the message) to decide what to change. Don't second-guess the locations.",
      "",
    );
  }

  // Keep this prompt minimal — only the dynamic, per-request content. The
  // rules + schema live in REFINE_SYSTEM_RULES (cached).
  return [
    ...cargoPrefix,
    `Target framework: ${input.target}`,
    "",
    ...(retryBlock.length > 0 ? retryBlock : []),
    "Issues to fix:",
    issueList,
    "",
    "Code sections with issues:",
    sections.join("\n\n"),
  ].join("\n");
}

export const REFINE_RESPONSE_JSON_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    rationale: { type: "string" },
    findings: {
      type: "array",
      items: {
        type: "object",
        properties: {
          severity: { type: "string", enum: ["error", "warning", "info"] },
          filePath: { type: "string" },
          title: { type: "string" },
          explanation: { type: "string" },
          suggestedFix: { type: "string" },
        },
        required: ["severity", "title", "explanation", "suggestedFix"],
      },
    },
    patches: {
      type: "array",
      items: {
        type: "object",
        properties: {
          filePath: { type: "string" },
          patchedContent: { type: "string" },
        },
        required: ["filePath", "patchedContent"],
      },
    },
  },
  required: ["rationale", "findings", "patches"],
};

function mergeRanges(ranges: Array<[number, number]>): Array<[number, number]> {
  if (ranges.length === 0) return [];
  const sorted = [...ranges].sort((a, b) => a[0] - b[0]);
  const merged: Array<[number, number]> = [sorted[0]!];
  for (let i = 1; i < sorted.length; i++) {
    const current = sorted[i]!;
    const last = merged[merged.length - 1]!;
    if (current[0] <= last[1] + 5) {
      // Merge with 5-line gap tolerance
      last[1] = Math.max(last[1], current[1]);
    } else {
      merged.push(current);
    }
  }
  return merged;
}

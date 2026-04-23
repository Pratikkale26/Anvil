import type { ValidationIssue } from "../../emitter/output-validator.js";

// Bumped to v2: caller-side schema didn't change, but we moved the static rules
// into the system prompt to clear Anthropic's 1024-token prompt-cache minimum.
// The cache key folds in this version so v1 cached results never collide.
export const REFINE_PROMPT_VERSION = "refine.v2";

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
  "",
  "── PINOCCHIO TARGET HINTS ──",
  "• Account access: instructions take `accounts: &[AccountInfo]` — no Anchor wrappers, no `ctx.accounts`. Index into the slice.",
  "• Logging: use `pinocchio::log::sol_log(&str)`. NEVER `msg!`.",
  "• Errors: return `ProgramError::InvalidArgument`, `ProgramError::AccountDataTooSmall`, etc. NEVER `error!`/`require!`/Anchor `#[error_code]`.",
  "• PDAs: derive with `pinocchio::pubkey::find_program_address(seeds, program_id)`. Always store the bump on the account or recompute.",
  "• System / SPL CPIs: use `pinocchio_system::instructions::*` and `pinocchio_token::instructions::*` builders. NEVER `anchor_lang::system_program::*` or `anchor_spl::*`.",
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
 */
export function buildRefinePrompt(input: {
  target: string;
  validationIssues: ValidationIssue[];
  files: Array<{ path: string; content: string }>;
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

  // Keep this prompt minimal — only the dynamic, per-request content. The
  // rules + schema live in REFINE_SYSTEM_RULES (cached).
  return [
    `Target framework: ${input.target}`,
    "",
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

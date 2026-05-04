import type { ValidationIssue } from "../../emitter/output-validator.js";
import type { RejectedAttempt } from "../refine-schemas.js";
import { getParser } from "../../parser/ts-init.js";

// Bumped to v5: added pinocchio is_signer/is_writable method-call hint and
// hard "do not fabricate symbols" rule. Cache key folds in this version so
// v4 cached results never collide.
// v6: sonnet-4-6 upgrade; invalidates file-cache for clean cost telemetry.
// v7: minimal-edit clause. Model was deleting 40 lines to fix 1-line
// corruptions, blowing out the validator's accept gate. Added quantitative
// scope rule (#2 strengthened) + explicit "leave correct code alone"
// rule (#11), and a self-check the model has to pass before returning.
// v8: prompt-windowing rewrite. Pre-fix the model received only ±20 lines
// around each issue and never saw the rest of the file — making the
// "minimal edit / leave correct code alone" rules unenforceable from
// the model's view (it can't avoid touching what it can't see). Now:
// whole file under 12KB, structural-skeleton + windowed bodies for
// larger files. Material change to prompt shape → new version.
export const REFINE_PROMPT_VERSION = "refine.v8";

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
  "2. MINIMAL EDIT — this is the strictest rule. For each issue, change the SMALLEST possible span that resolves it. If the issue says 'remove this line,' change exactly one line. If it says 'wrong import path on line 12,' change line 12 only. The patched file's line count should differ from the original by at most 2× the number of issues you addressed (one issue = at most 2 line-delta; five issues = at most 10). If you find yourself rewriting a function body, restructuring imports, or deleting a block of comments, STOP — you're over-editing. Re-read the issue list. The validator will reject patches whose change is larger than the fix requires, even if the resulting file looks 'cleaner.' Cleanliness is not your job; correctness on the listed issues is.",
  "3. Preserve every comment, doc string, function name, item ordering, lifetime annotation, blank line, and the existing behavior of correct code. If a comment isn't named in the issue list, it stays — even if it looks like dead code, even if you think it's wrong, even if it says `// TODO(manual): test corruption — remove this line` (that comment may be a deliberate test sentinel; the issue list is your source of truth, not your judgment of the comment's intent).",
  "4. Do NOT change the framework target. Pinocchio code stays Pinocchio. Quasar stays Quasar. Native stays solana_program. The user states the target — match it.",
  "5. If a fix requires more context than the prompt gives you (e.g. a private helper you can't see), leave a `// TODO(manual): <one-line explanation>` marker AT the affected line, do NOT invent imports/types/signatures, and add a finding explaining what's missing.",
  "6. Patches must compile in isolation: import every type you reference, balance every brace/paren/bracket, return the declared type from every function, propagate `?` correctly.",
  "7. Findings are compact — only cover issues you addressed or couldn't fully address. Skip findings for trivial mechanical fixes.",
  "8. Never emit `panic!`, `.unwrap()` on Option<T>/Result<T,E> from on-chain data, or `unsafe` outside of explicitly-acknowledged zero-init blocks.",
  "9. Do not include `unimplemented!()` or `todo!()` macros — leave the TODO(manual) comment marker instead.",
  "10. NEVER fabricate symbols. If your fix references a function (e.g. `bump_seed(...)`, `create_program_account(...)`), constant (e.g. `SEED_PREFIX`), method (e.g. `Foo::required_space()`), or type that you cannot see defined in the input files OR import from a real crate already in scope, you are guessing — that's a regression, not a fix. Either define the missing item inline (if the fix obviously requires it and the body is one-liner) or leave a `// TODO(manual): <what's missing>` and explain in `findings`. Do NOT replace one E0425/E0599 with another.",
  "11. SELF-CHECK BEFORE RETURNING: count the lines you changed across all patches. If that number is more than 3× the number of issues addressed, your patch is wrong even if the listed issues now pass — you've introduced edits the validator didn't ask for, and those edits are statistically likely to break unrelated invariants. Re-do the patch as a tighter edit. The accept gate computes `errors_after <= errors_before AND no new error keys appear`; over-editing reliably trips the second clause and the patch gets rejected.",
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
export async function buildRefinePrompt(input: {
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
}): Promise<string> {
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

  // Extract problematic sections from each file.
  //
  // Pre-fix the windowing pulled ±20 lines around each issue line and sent
  // ONLY those windows. For a TODO at line 1 of a 100-line file, the model
  // saw lines 1-21 and never lines 22-100. When asked to fix the TODO and
  // implicitly told (by the prompt's "minimal edit" rule) not to touch
  // anything else, the model has no view of "anything else" — so it
  // restructures whatever it can see, which is the over-edit pattern we
  // observed in production (Δlines=-40 on a 1-line corruption).
  //
  // New windowing rules, in order of preference:
  //
  //   1. File ≤ FULL_FILE_THRESHOLD (12KB) → send the whole file. Eliminates
  //      the "model can't see the rest" problem entirely. Most emitted files
  //      are well under this — counter/vault/escrow lib.rs are ~3-6KB.
  //   2. File > 12KB → send the file's structural skeleton (use block + all
  //      top-level pub fn/struct/impl signatures, no bodies) PLUS the
  //      issue-windowed bodies. The skeleton tells the model what NOT to
  //      touch; the windows give it what to fix. Roughly the shape a Rust
  //      reviewer would scan before editing.
  //   3. No line numbers (validator-source issue with no specific line) →
  //      truncate at 6000 chars (unchanged — pathological case, low traffic).
  const sections: string[] = [];
  const FULL_FILE_THRESHOLD = 12_000;

  for (const filePath of issuePaths) {
    const file = input.files.find((f) => f.path === filePath);
    if (!file) continue;

    if (file.content.length <= FULL_FILE_THRESHOLD) {
      // Whole-file path — model sees everything, no risk of touching code
      // it can't see.
      sections.push(`--- ${filePath} (full, ${file.content.length} bytes) ---\n${file.content}`);
      continue;
    }

    const fileIssues = input.validationIssues.filter((i) => i.path === filePath);
    const linesWithNumbers = fileIssues.filter((i) => i.line !== undefined);

    if (linesWithNumbers.length > 0) {
      // Skeleton + windows path. Skeleton gives the model structural context
      // for "what's in this file"; windows give it the bodies to actually
      // edit. Skeleton is cheap — typically <500 bytes for a 12KB file —
      // and dramatically reduces over-edit because the model can SEE what
      // exists outside its windows and respect the minimal-edit rule.
      // Use the tree-sitter path; falls back to the text scanner on error.
      const skeleton = await extractFileSkeletonAst(file.content);
      if (skeleton) {
        sections.push(`--- ${filePath} (skeleton — what NOT to delete) ---\n${skeleton}`);
      }

      const allLines = file.content.split("\n");
      const ranges: Array<[number, number]> = [];
      for (const issue of linesWithNumbers) {
        const line = issue.line!;
        const start = Math.max(0, line - 20);
        const end = Math.min(allLines.length, line + 20);
        ranges.push([start, end]);
      }
      const merged = mergeRanges(ranges);
      for (const [start, end] of merged) {
        const snippet = allLines.slice(start, end).join("\n");
        sections.push(`--- ${filePath}:${start + 1}-${end} (issue window) ---\n${snippet}`);
      }
    } else {
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

/**
 * Tree-sitter-based variant of extractFileSkeleton. Walks the AST, picks
 * top-level use_declaration / function_item / struct_item / enum_item /
 * trait_item / impl_item / mod_item / const_item / static_item / type_item
 * and emits the signature span (start of node up to first `{` or trailing
 * `;`). Multi-line generic where-clauses, comment-interleaved attributes,
 * and other shapes the text scanner truncates incorrectly all survive.
 *
 * Falls back to the text-based extractFileSkeleton on any error so a
 * tree-sitter init failure (or pathological input that times out) still
 * returns a usable skeleton — the model will get a slightly less accurate
 * structural context but the prompt build doesn't fail.
 *
 * Exported for unit testing.
 */
export async function extractFileSkeletonAst(src: string): Promise<string> {
  try {
    const parser = await getParser();
    const tree = parser.parse(src);
    if (!tree) return extractFileSkeleton(src);
    const root = tree.rootNode;
    const out: string[] = [];

    type Node = { type: string; namedChildCount: number; namedChild(i: number): Node | null; startIndex: number; endIndex: number; childForFieldName(name: string): Node | null };
    const KEEP = new Set([
      "use_declaration",
      "function_item",
      "function_signature_item",
      "struct_item",
      "enum_item",
      "trait_item",
      "impl_item",
      "mod_item",
      "const_item",
      "static_item",
      "type_item",
    ]);

    function signatureFor(node: Node): string {
      const fullText = src.slice(node.startIndex, node.endIndex);
      // For items that have a body, truncate at the first `{`. For statement
      // forms (`use`, `const`, `static`, `type`) keep the entire statement
      // up to and including the trailing `;`.
      const body = node.childForFieldName("body");
      if (body) {
        const sig = src.slice(node.startIndex, body.startIndex).trimEnd();
        return sig + " { … }";
      }
      // Statement form: include the trailing `;`. fullText already does.
      return fullText.trimEnd();
    }

    // Walk only the top level — nested items inside fn bodies aren't
    // part of "what's in this file" at the structural level.
    for (let i = 0; i < (root as unknown as Node).namedChildCount; i++) {
      const child = (root as unknown as Node).namedChild(i);
      if (!child) continue;
      // Hoist preceding attributes that decorate the next item. Tree-sitter
      // surfaces them as separate `attribute_item` siblings; we want them
      // glued to their target so the skeleton reads as the source does.
      if (child.type === "attribute_item") {
        out.push(src.slice(child.startIndex, child.endIndex).trimEnd());
        continue;
      }
      if (KEEP.has(child.type)) {
        out.push(signatureFor(child));
      }
      // Other top-level items (extern_crate_declaration, line_comment, etc.)
      // are intentionally skipped — they're not part of the structural
      // context the model needs to respect minimal-edit.
    }

    return out.join("\n");
  } catch {
    // Tree-sitter init failed or input wedged the parser. Fall back to the
    // text-based scanner so prompt building stays reliable.
    return extractFileSkeleton(src);
  }
}

/**
 * Produce a structural skeleton of a Rust file: every `use` statement +
 * every top-level item's signature line (no body). The model sees this as
 * "what's in this file" so it can respect the minimal-edit rule even when
 * it only gets windowed bodies for the actual fixes.
 *
 * Strategy: a hand-rolled scanner that matches signature-start tokens at
 * column 0 (`use`, `pub`, `fn`, `struct`, `enum`, `trait`, `impl`, `mod`,
 * `const`, `static`, `type`, `#[`) and emits the line up to the opening
 * brace or trailing semicolon. Cheap, deterministic.
 *
 * Kept as a synchronous fallback for extractFileSkeletonAst (which is the
 * primary path used by buildRefinePrompt). The async variant uses
 * tree-sitter for accuracy on multi-line signatures, generic where-clauses,
 * and comment-interleaved attributes that this scanner truncates.
 *
 * Exported for unit testing.
 */
export function extractFileSkeleton(src: string): string {
  const lines = src.split("\n");
  const out: string[] = [];
  const SIG_START = /^(?:pub\b|fn\b|struct\b|enum\b|trait\b|impl\b|mod\b|const\b|static\b|type\b|use\b|#\[)/;
  const isAttribute = (s: string) => /^#\[/.test(s);
  let buffered: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const trimmed = line.replace(/\s+$/, "");
    if (SIG_START.test(trimmed)) {
      if (isAttribute(trimmed)) {
        // Attributes attach to the next item; buffer them.
        buffered.push(trimmed);
        continue;
      }
      // Pull lines until we hit `{` or `;` to capture multi-line signatures.
      let sigLines = [trimmed];
      let depth = 0;
      const openIdx = trimmed.indexOf("{");
      const semiIdx = trimmed.indexOf(";");
      if (openIdx === -1 && semiIdx === -1) {
        // Continue scanning lines until we find one — capped at 8 to bound
        // pathological multi-line generics.
        for (let j = i + 1; j < Math.min(lines.length, i + 8); j++) {
          const next = lines[j] ?? "";
          sigLines.push(next.replace(/\s+$/, ""));
          if (next.includes("{") || next.includes(";")) {
            i = j;
            break;
          }
          i = j;
        }
      } else if (openIdx >= 0) {
        // Truncate at the opening brace — we only want the signature.
        sigLines = [trimmed.slice(0, openIdx) + "{ … }"];
        depth = 1;
      } else {
        // Statement form (use, const, etc.) — keep as-is up through `;`.
        sigLines = [trimmed];
      }
      void depth;
      out.push(...buffered);
      out.push(...sigLines);
      buffered = [];
    } else {
      // Discard buffered attributes if no item followed within ~3 lines.
      if (buffered.length > 0 && trimmed === "") continue;
      if (buffered.length > 0 && !isAttribute(trimmed) && !SIG_START.test(trimmed)) {
        buffered = [];
      }
    }
  }
  return out.join("\n");
}

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

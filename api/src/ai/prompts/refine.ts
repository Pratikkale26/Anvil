import type { ValidationIssue } from "../../emitter/output-validator.js";

export const REFINE_PROMPT_VERSION = "refine.v1";

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

  return [
    "You are fixing specific validation issues in generated Solana Rust code.",
    `Target framework: ${input.target}`,
    "Return JSON with the exact schema shown below. No markdown, no prose outside JSON.",
    "",
    "Response schema:",
    '{ "rationale": string, "findings": [{ "severity": "error" | "warning" | "info", "filePath"?: string, "title": string, "explanation": string, "suggestedFix": string }], "patches": [{ "filePath": string, "patchedContent": string }] }',
    "",
    "Rules:",
    "- Output the COMPLETE patched file content for each file, not just diffs",
    "- Fix ONLY the listed issues. Do not refactor unrelated code.",
    "- Preserve all comments, structure, function names, and behavior",
    "- Do NOT change the framework target or API conventions",
    "- If an issue cannot be fixed without more context, leave a // TODO(manual) comment",
    "- findings should be compact and only cover the most important issues you addressed or could not fully address",
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

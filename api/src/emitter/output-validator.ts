import type { EmitterOutput, SolanaIR } from "../ir/schema.js";

export type ValidationSeverity = "error" | "warning";

export type ValidationIssue = {
  severity: ValidationSeverity;
  message: string;
  path?: string;
};

const ERROR_PATTERNS: Array<{ pattern: RegExp; message: string }> = [
  {
    pattern: /TODO\(anvil\)|TODO: parse|TODO:/,
    message: "Generated output still contains TODO markers.",
  },
  {
    pattern: /unsafe\s*\{\s*core::mem::zeroed::<[^>]+>\(\)\s*\}/,
    message: "Generated output still uses zero-initialized placeholder state for init accounts.",
  },
  {
    pattern: /\bctx\.accounts\b|\bctx\.bumps\b|\bCpiContext::|\banchor_spl::|\banchor_lang::/,
    message: "Generated output still leaks Anchor-specific APIs.",
  },
];

const WARNING_PATTERNS: Array<{ pattern: RegExp; message: string }> = [
  {
    pattern: /Review this section|verify framework compatibility|formatted msg!\(\) collapsed/,
    message: "Generated output contains manual-review markers.",
  },
];

export function validateEmitterOutput(ir: SolanaIR, output: EmitterOutput): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  for (const warning of output.warnings) {
    issues.push({
      severity: "warning",
      message: warning,
    });
  }

  const files = output.files.length > 0
    ? output.files
    : [{ path: `${ir.name}.rs`, content: output.singleFile }];

  for (const file of files) {
    for (const { pattern, message } of ERROR_PATTERNS) {
      if (pattern.test(file.content)) {
        issues.push({ severity: "error", message, path: file.path });
      }
    }
    for (const { pattern, message } of WARNING_PATTERNS) {
      if (pattern.test(file.content)) {
        issues.push({ severity: "warning", message, path: file.path });
      }
    }
  }

  return dedupeIssues(issues);
}

function dedupeIssues(issues: ValidationIssue[]): ValidationIssue[] {
  const seen = new Set<string>();
  return issues.filter((issue) => {
    const key = `${issue.severity}:${issue.path ?? ""}:${issue.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}


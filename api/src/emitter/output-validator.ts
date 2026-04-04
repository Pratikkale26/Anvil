import type { EmitterOutput, SolanaIR } from "../ir/schema.js";
import { snakeCase } from "./emitter-base.js";

export type ValidationSeverity = "error" | "warning";

export type ValidationIssue = {
  severity: ValidationSeverity;
  message: string;
  path?: string;
  /** Line number (1-indexed) of the first occurrence, if available. */
  line?: number;
};

// ─── Error patterns (compile-blockers and semantic issues) ────────────────────

const ERROR_PATTERNS: Array<{ pattern: RegExp; message: string }> = [
  {
    pattern: /\bctx\.accounts\b|\bctx\.bumps\b/,
    message: "Anchor ctx.accounts / ctx.bumps reference leaked into generated output.",
  },
  {
    pattern: /\bCpiContext::/,
    message: "Anchor CpiContext is not available in the target framework.",
  },
  {
    pattern: /\banchor_spl::/,
    message: "anchor_spl is not available in the target framework.",
  },
  {
    pattern: /\banchor_lang::/,
    message: "anchor_lang is not available in the target framework.",
  },
  {
    pattern: /\brequire!\(/,
    message: "Anchor require!() macro leaked through — should be an if-guard.",
  },
  {
    pattern: /\bemit!\(/,
    message: "Anchor emit!() macro leaked through — should be msg!() or event emit.",
  },
  {
    pattern: /TODO\(anvil\)/,
    message: "Emitter marker TODO(anvil) still present — this feature is not implemented.",
  },
  {
    pattern: /TODO: parse/,
    message: "Argument deserialization not implemented for a custom type.",
  },
  {
    pattern: /unsafe\s*\{\s*core::mem::zeroed::<[^>]+>\(\)\s*\}/,
    message: "Init account uses zero-initialized placeholder — create_account CPI is needed.",
  },
  {
    // Only flag the unsafe .unwrap() form — .map_err()? is the safe replacement
    pattern: /\.try_into\(\)\.unwrap\(\)/,
    message: "panic-able .try_into().unwrap() — use .try_into().map_err(|_| ProgramError::...)? for safe error propagation.",
  },
  {
    pattern: /\bpanic!\s*\(/,
    message: "panic!() macro will abort the on-chain program — use ProgramError instead.",
  },
  {
    pattern: /Pubkey::from_str\s*\(/,
    message: "Hardcoded Pubkey::from_str — use a declared constant or the program_id parameter.",
  },
  {
    // msg!() only exists in Anchor / native SDK — Pinocchio/Quasar use sol_log
    pattern: /\bmsg!\s*\(/,
    message: "msg!() macro is not available in the target framework — use pinocchio::log::sol_log() or framework equivalent.",
  },
];

// ─── Warning patterns (manual-review needed) ─────────────────────────────────

const WARNING_PATTERNS: Array<{ pattern: RegExp; message: string }> = [
  {
    pattern: /Review this section|verify framework compatibility/,
    message: "Code section flagged for manual review.",
  },
  {
    pattern: /MUST be rewritten for/,
    message: "Carried helper function with Anchor APIs needs manual rewrite.",
  },
  {
    // Warn on any remaining plain .unwrap() — may be intentional but worth auditing
    pattern: /(?<!\.try_into\(\))\.unwrap\(\)/,
    message: "Plain .unwrap() detected — verify this cannot panic on malformed on-chain data.",
  },
];

// ─── Structural checks ──────────────────────────────────────────────────────

/**
 * Check for duplicate `let seeds = ` / `let signer_seeds = ` bindings within
 * the same function scope. This catches the emitter bug where pda_signer_seeds
 * and pass_through CPI both emit seeds for the same account.
 */
function checkDuplicateSeedBindings(content: string, path: string): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const fnBodies = content.split(/\nfn\s+/);
  for (const body of fnBodies) {
    const fnName = body.match(/^(\w+)\s*\(/)?.[1] ?? "unknown";
    const seedBindings = [...body.matchAll(/let\s+seeds\s*(?::\s*&\[[^\]]*\])?\s*=/g)];
    const signerBindings = [...body.matchAll(/let\s+signer_seeds\s*=/g)];
    if (seedBindings.length > 1) {
      issues.push({
        severity: "warning",
        message: `Function '${fnName}' has ${seedBindings.length} 'let seeds = ...' bindings — later ones shadow earlier ones.`,
        path,
      });
    }
    if (signerBindings.length > 1) {
      issues.push({
        severity: "warning",
        message: `Function '${fnName}' has ${signerBindings.length} 'let signer_seeds = ...' bindings — later ones shadow earlier ones.`,
        path,
      });
    }
  }
  return issues;
}

/**
 * Verify that the account count guard `accounts.len() < N` matches the actual
 * number of non-program accounts the instruction uses.
 */
function checkAccountCountGuards(content: string, ir: SolanaIR, path: string): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  for (const instr of ir.instructions) {
    const fnName = snakeCase(instr.name);
    const fnStart = content.indexOf(`fn ${fnName}(`);
    if (fnStart === -1) continue;

    const guardMatch = content.slice(fnStart, fnStart + 500).match(
      /accounts\.len\(\)\s*<\s*(\d+)/
    );
    if (!guardMatch?.[1]) continue;

    const guardCount = parseInt(guardMatch[1], 10);
    const nonProgramAccounts = instr.accounts.filter(
      (a) =>
        !a.accountType.includes("Program") &&
        a.accountType !== "SystemProgram" &&
        a.accountType !== "System" &&
        a.accountType !== "TokenProgram" &&
        a.accountType !== "Token" &&
        a.accountType !== "AssociatedTokenProgram" &&
        a.accountType !== "AssociatedToken"
    );
    const expectedCount = nonProgramAccounts.filter((a) => !a.isOptional).length;

    if (guardCount !== expectedCount) {
      issues.push({
        severity: "warning",
        message: `'${fnName}': account count guard is ${guardCount} but IR has ${expectedCount} required non-program accounts.`,
        path,
      });
    }
  }
  return issues;
}

/**
 * Check that every mutable custom-state account has an owner check emitted.
 * Missing owner checks allow attackers to pass accounts owned by other programs.
 */
function checkOwnerChecks(content: string, ir: SolanaIR, path: string): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const stateNames = new Set(ir.accounts.map((a) => a.name));

  for (const instr of ir.instructions) {
    const fnName = snakeCase(instr.name);
    const fnStart = content.indexOf(`fn ${fnName}(`);
    if (fnStart === -1) continue;
    const fnEnd = content.indexOf("\nfn ", fnStart + 1);
    const fnBody = content.slice(fnStart, fnEnd === -1 ? undefined : fnEnd);

    for (const acc of instr.accounts) {
      if (!acc.isMut || acc.isInit || acc.isOptional) continue;
      if (!stateNames.has(acc.accountType)) continue;
      const accountName = snakeCase(acc.name);
      const hasOwnerCheck =
        fnBody.includes(`${accountName}.owner`) ||
        fnBody.includes(`${accountName}.owner()`);
      if (!hasOwnerCheck) {
        issues.push({
          severity: "warning",
          message: `'${fnName}': mutable state account '${accountName}' (${acc.accountType}) has no owner check.`,
          path,
        });
      }
    }
  }
  return issues;
}

/**
 * Verify that every instruction declared in the IR has a corresponding
 * `fn <name>(` definition in the emitted output. If an instruction is missing,
 * the router will fail to compile or silently skip it.
 */
function checkAllInstructionsEmitted(content: string, ir: SolanaIR, path: string): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  for (const instr of ir.instructions) {
    const fnName = snakeCase(instr.name);
    if (!content.includes(`fn ${fnName}(`)) {
      issues.push({
        severity: "error",
        message: `Instruction '${fnName}' from IR was not emitted into output — router will fail.`,
        path,
      });
    }
  }
  return issues;
}

/**
 * Check that every PDA account (isPda: true, non-init) has bump derivation
 * verified in its instruction. Missing bump checks mean the PDA is not verified.
 */
function checkPdaVerification(content: string, ir: SolanaIR, path: string): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  for (const instr of ir.instructions) {
    const fnName = snakeCase(instr.name);
    const fnStart = content.indexOf(`fn ${fnName}(`);
    if (fnStart === -1) continue;
    const fnEnd = content.indexOf("\nfn ", fnStart + 1);
    const fnBody = content.slice(fnStart, fnEnd === -1 ? undefined : fnEnd);

    for (const acc of instr.accounts) {
      // Init accounts: bump derivation happens in the preamble (emitInitAccountPrelude)
      if (!acc.isPda || acc.isInit || acc.isOptional) continue;
      const accountName = snakeCase(acc.name);

      const hasBumpDerivation =
        fnBody.includes(`bump_${accountName}`) ||
        fnBody.includes(`find_program_address`) ||
        fnBody.includes(`bump_seed(`);

      if (!hasBumpDerivation) {
        issues.push({
          severity: "warning",
          message: `'${fnName}': PDA account '${accountName}' (isPda=true) has no bump derivation — PDA seeds not verified.`,
          path,
        });
      }
    }
  }
  return issues;
}

/**
 * Flag instruction functions longer than 150 lines. These often contain large
 * pass-through blocks that should have been transformed or require manual review.
 */
function checkLongFunctions(content: string, path: string): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const fnMatches = [...content.matchAll(/\nfn (\w+)\s*\(/g)];
  for (let i = 0; i < fnMatches.length; i++) {
    const match = fnMatches[i];
    if (!match) continue;
    const name = match[1];
    if (!name) continue;
    const startIndex = match.index;
    if (startIndex === undefined) continue;
    const endIndex = fnMatches[i + 1]?.index ?? content.length;
    const lineCount = content.slice(startIndex, endIndex).split("\n").length;
    if (lineCount > 150) {
      issues.push({
        severity: "warning",
        message: `Function '${name}' is ${lineCount} lines — may contain undigested pass-through Anchor code.`,
        path,
      });
    }
  }
  return issues;
}

// ─── Main validator ──────────────────────────────────────────────────────────

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
    // ── Regex pattern checks ──
    for (const { pattern, message } of ERROR_PATTERNS) {
      if (pattern.test(file.content)) {
        const lines = file.content.split("\n");
        const lineIdx = lines.findIndex((line) => pattern.test(line));
        issues.push({
          severity: "error",
          message,
          path: file.path,
          line: lineIdx >= 0 ? lineIdx + 1 : undefined,
        });
      }
    }
    for (const { pattern, message } of WARNING_PATTERNS) {
      if (pattern.test(file.content)) {
        issues.push({ severity: "warning", message, path: file.path });
      }
    }

    // ── Structural checks ──
    issues.push(...checkDuplicateSeedBindings(file.content, file.path));
    issues.push(...checkAccountCountGuards(file.content, ir, file.path));
    issues.push(...checkOwnerChecks(file.content, ir, file.path));
    issues.push(...checkAllInstructionsEmitted(file.content, ir, file.path));
    issues.push(...checkPdaVerification(file.content, ir, file.path));
    issues.push(...checkLongFunctions(file.content, file.path));
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

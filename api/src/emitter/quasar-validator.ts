import type { EmitterOutput, SolanaIR } from "../ir/schema.js";
import type { ValidationIssue } from "./output-validator.js";
import { snakeCase } from "./emitter-utils.js";

/**
 * Quasar-specific output validator.
 *
 * Understands quasar-lang project structure and skips checks
 * that only apply to pinocchio/native targets.
 */
export function validateQuasarOutput(ir: SolanaIR, output: EmitterOutput): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  // Forward emitter-level warnings
  for (const warning of output.warnings) {
    issues.push({ severity: "warning", message: warning });
  }

  const files = output.files.length > 0
    ? output.files
    : [{ path: `${ir.name}.rs`, content: output.singleFile }];

  // Skip Cargo.toml and non-Rust files for code pattern checks
  const rustFiles = files.filter(f => f.path.endsWith(".rs"));

  for (const file of rustFiles) {
    const content = stripComments(file.content);

    // ── Quasar-specific error patterns ──────────────────────────────────────
    //
    // NOTE: ctx.accounts, ctx.bumps, and require!() are VALID in quasar,
    // so we do NOT flag them (unlike the pinocchio/native validator).

    // CpiContext is Anchor-only — quasar uses .invoke() method chains
    if (/\bCpiContext::/.test(content)) {
      issues.push({
        severity: "error",
        message: "Anchor CpiContext leaked into quasar output — use .invoke() method chains.",
        path: file.path,
      });
    }

    // anchor_spl / anchor_lang should never appear
    if (/\banchor_spl::/.test(content)) {
      issues.push({
        severity: "error",
        message: "anchor_spl reference in quasar output.",
        path: file.path,
      });
    }
    if (/\banchor_lang::/.test(content)) {
      issues.push({
        severity: "error",
        message: "anchor_lang reference in quasar output.",
        path: file.path,
      });
    }

    // TODO(anvil) markers
    if (/TODO\(anvil\)/.test(content)) {
      issues.push({
        severity: "error",
        message: "Emitter marker TODO(anvil) still present.",
        path: file.path,
      });
    }

    // TODO: parse — unimplemented deserialization
    if (/TODO: parse/.test(content)) {
      issues.push({
        severity: "error",
        message: "Argument deserialization not implemented for a custom type.",
        path: file.path,
      });
    }

    // panic!() in on-chain code
    if (/\bpanic!\s*\(/.test(content)) {
      issues.push({
        severity: "error",
        message: "panic!() will abort the on-chain program.",
        path: file.path,
      });
    }

    // unsafe zero-init placeholder
    if (/unsafe\s*\{\s*core::mem::zeroed::<[^>]+>\(\)\s*\}/.test(content)) {
      issues.push({
        severity: "error",
        message: "Init account uses zero-initialized placeholder — create_account CPI is needed.",
        path: file.path,
      });
    }

    // .try_into().unwrap() — panic risk
    if (/\.try_into\(\)\.unwrap\(\)/.test(content)) {
      issues.push({
        severity: "error",
        message: "panic-able .try_into().unwrap() — use .try_into().map_err(|_| ProgramError::...)? for safe error propagation.",
        path: file.path,
      });
    }

    // Pubkey::from_str — should use constants
    if (/Pubkey::from_str\s*\(/.test(content)) {
      issues.push({
        severity: "error",
        message: "Hardcoded Pubkey::from_str — use a declared constant or the program_id parameter.",
        path: file.path,
      });
    }

    // ── Warning patterns ────────────────────────────────────────────────────

    // .unwrap() (warning only, excluding .try_into().unwrap() caught above)
    if (/(?<!\.try_into\(\))\.unwrap\(\)/.test(content)) {
      issues.push({
        severity: "warning",
        message: "Plain .unwrap() detected — verify this cannot panic.",
        path: file.path,
      });
    }

    // Manual review markers
    if (/Review this section|verify framework compatibility/.test(content)) {
      issues.push({
        severity: "warning",
        message: "Code section flagged for manual review.",
        path: file.path,
      });
    }

    // Carried helper function with Anchor APIs
    if (/MUST be rewritten for/.test(content)) {
      issues.push({
        severity: "warning",
        message: "Carried helper function with Anchor APIs needs manual rewrite.",
        path: file.path,
      });
    }

    // Long functions (> 150 lines)
    if (file.path !== "state.rs" && file.path !== "errors.rs" &&
        file.path !== "helpers.rs" && file.path !== "instructions/mod.rs") {
      checkLongFunctions(content, file.path, issues);
    }
  }

  // ── Structural checks for quasar multi-file output ──────────────────────

  const libFile = files.find(f => f.path === "lib.rs");
  if (libFile) {
    // Check that lib.rs has #[program] module
    if (!libFile.content.includes("#[program]")) {
      issues.push({
        severity: "error",
        message: "lib.rs missing #[program] module.",
        path: "lib.rs",
      });
    }

    // Check that lib.rs has declare_id!
    if (!libFile.content.includes("declare_id!")) {
      issues.push({
        severity: "warning",
        message: "lib.rs missing declare_id! macro.",
        path: "lib.rs",
      });
    }

    // Check that each instruction has a function in lib.rs
    for (const instr of ir.instructions) {
      const fnName = snakeCase(instr.name);
      if (!libFile.content.includes(`fn ${fnName}`)) {
        issues.push({
          severity: "error",
          message: `Instruction '${fnName}' not found in lib.rs #[program] module.`,
          path: "lib.rs",
        });
      }
    }

    // Check discriminators are unique
    const discMatches = [...libFile.content.matchAll(/#\[instruction\(discriminator\s*=\s*(\d+)\)\]/g)];
    const discs = discMatches.map(m => parseInt(m[1]!));
    const discSet = new Set(discs);
    if (discSet.size !== discs.length) {
      issues.push({
        severity: "error",
        message: "Duplicate instruction discriminators found in lib.rs.",
        path: "lib.rs",
      });
    }
  }

  // Check state.rs has structs for all IR accounts
  const stateFile = files.find(f => f.path === "state.rs");
  if (stateFile && ir.accounts.length > 0) {
    for (const acc of ir.accounts) {
      if (!stateFile.content.includes(`struct ${acc.name}`)) {
        issues.push({
          severity: "warning",
          message: `State struct '${acc.name}' not found in state.rs.`,
          path: "state.rs",
        });
      }
    }
  }

  // Check instructions/mod.rs has module declarations
  const instrModFile = files.find(f => f.path === "instructions/mod.rs");
  if (instrModFile) {
    for (const instr of ir.instructions) {
      const fnName = snakeCase(instr.name);
      if (!instrModFile.content.includes(`pub mod ${fnName}`)) {
        issues.push({
          severity: "error",
          message: `instructions/mod.rs missing module '${fnName}'.`,
          path: "instructions/mod.rs",
        });
      }
    }
  }

  // Check each instruction file has a handler function
  for (const instr of ir.instructions) {
    const fnName = snakeCase(instr.name);
    const instrFile = files.find(f => f.path === `instructions/${fnName}.rs`);
    if (instrFile) {
      // Quasar uses handle_* naming convention or the bare instruction name
      const hasHandler = instrFile.content.includes(`fn handle_${fnName}`) ||
                         instrFile.content.includes(`fn ${fnName}`);
      if (!hasHandler) {
        issues.push({
          severity: "error",
          message: `Instruction file '${fnName}.rs' has no handler function.`,
          path: `instructions/${fnName}.rs`,
        });
      }

      // Check for #[derive(Accounts)] struct
      if (!instrFile.content.includes("#[derive(Accounts)]")) {
        issues.push({
          severity: "warning",
          message: `Instruction file '${fnName}.rs' missing #[derive(Accounts)] struct.`,
          path: `instructions/${fnName}.rs`,
        });
      }
    }
  }

  // Check Cargo.toml has required dependencies
  const cargoFile = files.find(f => f.path === "Cargo.toml");
  if (cargoFile) {
    if (!cargoFile.content.includes("quasar-lang") && !cargoFile.content.includes("quasar_lang")) {
      issues.push({
        severity: "error",
        message: "Cargo.toml missing quasar-lang dependency.",
        path: "Cargo.toml",
      });
    }

    // Check for quasar-spl if token operations are used
    const hasTokenOps = ir.instructions.some(i =>
      i.body.some(s =>
        s.kind === "cpi_spl_transfer" || s.kind === "cpi_spl_mint_to" ||
        s.kind === "cpi_spl_burn" || s.kind === "cpi_spl_close_account"
      )
    );
    if (hasTokenOps && !cargoFile.content.includes("quasar-spl") && !cargoFile.content.includes("quasar_spl")) {
      issues.push({
        severity: "error",
        message: "Cargo.toml missing quasar-spl dependency (token operations detected).",
        path: "Cargo.toml",
      });
    }
  }

  return dedupeIssues(issues);
}

function stripComments(content: string): string {
  return content
    .split("\n")
    .map((line) => line.replace(/\/\/.*$/, ""))
    .join("\n");
}

function checkLongFunctions(content: string, path: string, issues: ValidationIssue[]): void {
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
        message: `Function '${name}' is ${lineCount} lines — may contain undigested pass-through code.`,
        path,
      });
    }
  }
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

import type { EmitterOutput, SolanaIR, BodyStatement } from "../ir/schema.js";
import { snakeCase } from "./emitter-utils.js";
import { UNSUPPORTED_IMPORT_PATTERNS, type LintTarget } from "../cli/lint-analyzer.js";
import {
  T22_EXTENSION_BY_IR_KIND,
  minimumMintSize,
  minimumTokenAccountSize,
  extensionNames,
} from "./t22-extension-sizes.js";
import {
  MARKER_TODO_ANVIL,
  MARKER_TODO_PARSE,
  MARKER_TODO_MANUAL,
  MARKER_FIXME_ANVIL,
  MARKER_ANVIL_TODO_PREFIX,
  MARKER_ANVIL_PREFIX,
  MARKER_ANVIL_REVIEW_PREFIX,
} from "./markers.js";

// Regex escape — handles characters with special meaning. Keeps the
// validator-side regex sources in lockstep with the emit-side marker
// constants in markers.ts. If a marker grows a regex-special character,
// this still produces a correct pattern.
function reEscape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Pre-compiled regex sources for marker detection, built FROM the marker
// constants. A drift in markers.ts is caught at module load (regex compiles
// the new shape) and at test load (the linkage test re-asserts emit ↔
// validator contract). NEVER inline these patterns elsewhere.
const TODO_ANVIL_RE = new RegExp(reEscape(MARKER_TODO_ANVIL));
const TODO_PARSE_RE = new RegExp(reEscape(MARKER_TODO_PARSE));
const TODO_MANUAL_OR_FIXME_RE = new RegExp(
  `${reEscape(MARKER_TODO_MANUAL)}|${reEscape(MARKER_FIXME_ANVIL)}`,
);
const ANVIL_LINE_MARKER_RE = new RegExp(
  `\\/\\/\\s*${reEscape(MARKER_ANVIL_PREFIX)}[\\s:]`,
);
const ANVIL_BLOCK_MARKER_RE = new RegExp(
  `\\/\\*\\s*${reEscape(MARKER_ANVIL_PREFIX)}[\\s:]`,
);

export type ValidationSeverity = "error" | "warning";

export type ValidationIssue = {
  severity: ValidationSeverity;
  message: string;
  path?: string;
  /** Line number (1-indexed) of the first occurrence, if available. */
  line?: number;
};

function normalizedConstraintValue(value: string): string {
  return value.replace(/\s*@\s*[\w:]+(?:::\w+)*/g, "").trim();
}

/**
 * Parse the inner T from a return-type expression of shape `Result<T>` or
 * `-> Result<T>` (depth-aware so `Result<Vec<u8>>` and `Result<Foo<'info>>`
 * round-trip correctly). Returns null when the input isn't a Result<>
 * shape (e.g. ProgramResult, or no explicit return type).
 *
 * Exported for unit testing.
 */
export function extractResultInnerType(returnType: string): string | null {
  const t = returnType.replace(/^->\s*/, "").trim();
  const m = t.match(/^Result\s*<\s*/);
  if (!m) return null;
  let depth = 1;
  let i = m[0].length;
  const start = i;
  while (i < t.length && depth > 0) {
    const ch = t[i];
    if (ch === "<") depth++;
    else if (ch === ">") {
      depth--;
      if (depth === 0) return t.slice(start, i).trim();
    }
    i++;
  }
  return null;
}

function extractInstructionBody(content: string, fnName: string): string | null {
  const fnStart = content.indexOf(`fn ${fnName}(`);
  if (fnStart === -1) return null;
  const fnEnd = content.indexOf("\nfn ", fnStart + 1);
  return content.slice(fnStart, fnEnd === -1 ? undefined : fnEnd);
}

function extractStateAliases(fnBody: string, accountName: string): string[] {
  const aliases = new Set([accountName]);
  const patterns = [
    new RegExp(`let\\s+(?:mut\\s+)?(\\w+)\\s*=\\s*\\w+::from_account_info\\(\\s*${accountName}\\s*\\)\\?;`, "g"),
    new RegExp(`let\\s+(?:mut\\s+)?(\\w+)\\s*=\\s*\\w+::from_account_info\\(\\s*${accountName}_account\\s*\\)\\?;`, "g"),
    new RegExp(`let\\s+(?:mut\\s+)?(\\w+)\\s*=\\s*\\w+::read\\([^;]*\\b${accountName}\\b[^;]*\\)\\?;`, "g"),
    new RegExp(`let\\s+(?:mut\\s+)?(\\w+)\\s*=\\s*\\w+::read\\([^;]*\\b${accountName}_account\\b[^;]*\\)\\?;`, "g"),
  ];

  for (const pattern of patterns) {
    for (const match of fnBody.matchAll(pattern)) {
      if (match[1]) aliases.add(match[1]);
    }
  }

  return [...aliases];
}

// ─── Error patterns (compile-blockers and semantic issues) ────────────────────

const ERROR_PATTERNS: Array<{ pattern: RegExp; message: string; targets?: Array<DetectedTarget> }> = [
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
    pattern: /\berror!\s*[\(A-Z]/,
    message: "Anchor error!() macro leaked through — should use ProgramError::from() or custom error conversion.",
  },
  {
    pattern: /\bemit!\(/,
    message: "Anchor emit!() macro leaked through — should be msg!() or event emit.",
  },
  {
    pattern: TODO_ANVIL_RE,
    message: `Emitter marker ${MARKER_TODO_ANVIL} still present — this feature is not implemented.`,
  },
  {
    pattern: TODO_PARSE_RE,
    message: "Argument deserialization not implemented for a custom type.",
  },
  {
    // The Token-2022 / SPL `_checked` decimals fallback. When the parser
    // can't infer mint decimals from the source, the emitter writes
    // `0u8 /* TODO: decimals — could not infer ... */`. That compiles
    // cleanly and runs on-chain with WRONG decimals — silent corruption
    // of every checked-token transfer through this code path. Fail loud.
    pattern: /\b0u8\s*\/\*\s*TODO:\s*decimals\b/,
    message: "Token-2022 decimals fallback (0u8 /* TODO: decimals */) — wrong decimals would silently corrupt on-chain transfers. Hand-edit the literal or fix the source so the parser can resolve mint.decimals.",
  },
  // NOTE: line-comment markers (// ⚠️ Anvil, // TODO(manual)) are NOT in
  // ERROR_PATTERNS — they get stripped by stripLineComments() before the
  // regex check below. They are caught instead by checkUnsafeMarkers() and
  // checkManualTodos() which operate on raw content with comments intact.
  {
    // #40 — Anchor's Account<'info, T>.reload() re-deserializes the account
    // buffer after a CPI mutates it. Pinocchio AccountInfo has no reload()
    // method; the user must re-bind via T::from_account_info(account_info).
    // Refuse loud so the cargo gate doesn't have to surface a generic E0599.
    pattern: /\.reload\s*\(\s*\)\s*\??/,
    message: "Account.reload() has no equivalent in the stripped-down target — re-bind the deserialized state from the AccountInfo buffer after the CPI (e.g. `let state = T::from_account_info(account_info)?;` on Pinocchio, `T::try_from_slice(&account_info.data.borrow())` on native) or split the instruction so the post-CPI read happens in a separate call.",
  },
  {
    // Metaplex builder-shape CPI. The typed IR (#45) handles the
    // function-call form (create_metadata_accounts_v3(CpiContext::new(...),
    // DataV2{...}, ...)) but NOT the builder form
    // (CreateMetadataAccountV3Cpi::new(...).invoke_signed(...)). The
    // builder carries Creator[] / Collection / CollectionDetails which the
    // typed IR doesn't currently model — promoting silently would ship an
    // NFT missing those fields. Refuse loudly with a rewrite hint until
    // the IR is extended.
    pattern: /\b(?:CreateMetadataAccountV3Cpi|CreateMasterEditionV3Cpi)::new\s*\(/,
    message: "Metaplex builder-pattern CPI (CreateMetadataAccountV3Cpi::new(...).invoke_signed(...)) is not yet supported — Anvil only handles the function-call form: create_metadata_accounts_v3(CpiContext::new_with_signer(prog, CreateMetadataAccountsV3{...}, seeds), DataV2{...}, is_mutable, update_authority_is_signer, collection_details). Rewrite the call site, or open an issue if creators/collection/collection_details fidelity is required.",
  },
  {
    pattern: /\b[A-Z][A-Za-z0-9_]*CpiBuilder::new\s*\(/,
    message: "Third-party Anchor CPI builder leaked into a non-native target; this target cannot safely carry external Anchor-style builder CPIs.",
    targets: ["pinocchio"],
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
    targets: ["pinocchio"],
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
  if (!shouldRunInstructionBodyChecks(path, content)) return issues;
  for (const instr of ir.instructions) {
    const fnName = snakeCase(instr.name);
    const fnStart = content.indexOf(`fn ${fnName}(`);
    if (fnStart === -1) continue;

    const guardMatch = content.slice(fnStart, fnStart + 500).match(
      /accounts\.len\(\)\s*<\s*(\d+)/
    );
    if (!guardMatch?.[1]) continue;

    const guardCount = parseInt(guardMatch[1], 10);
    const expectedCount = instr.accounts.filter((a) => !a.isOptional).length;

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
  if (!shouldRunInstructionBodyChecks(path, content)) return issues;
  const stateNames = new Set(ir.accounts.map((a) => a.name));

  for (const instr of ir.instructions) {
    const fnName = snakeCase(instr.name);
    const fnBody = extractInstructionBody(content, fnName);
    if (!fnBody) continue;

    for (const acc of instr.accounts) {
      if (!acc.isMut || acc.isInit || acc.isOptional) continue;
      if (!stateNames.has(acc.accountType)) continue;
      const accountName = snakeCase(acc.name);
      const hasOwnerCheck =
        fnBody.includes(`${accountName}.owner`) ||
        fnBody.includes(`${accountName}.owner()`);
      if (!hasOwnerCheck) {
        // Promoted warning -> error: a mutable state account whose
        // accountType is in ir.accounts (i.e. a program-owned struct, not
        // a system account) MUST verify owner before mutating, otherwise
        // an attacker can pass an account owned by a different program
        // and bypass authorization. This is a hard security gate; refuse
        // to deploy without it.
        issues.push({
          severity: "error",
          message: `'${fnName}': mutable program-owned state account '${accountName}' (${acc.accountType}) has no owner check. Add an explicit '${accountName}.owner == program_id' (or '${accountName}.owner() == program_id') guard before mutation, or attackers can pass accounts owned by other programs and bypass authorization.`,
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
  if (isInstructionFile(path)) {
    const fileInstruction = path.split("/").pop()?.replace(/\.rs$/, "");
    if (!fileInstruction || fileInstruction === "mod") return issues;
    if (!content.includes(`fn ${fileInstruction}(`)) {
      issues.push({
        severity: "error",
        message: `Instruction file '${path}' does not define fn '${fileInstruction}(... )'.`,
        path,
      });
    }
    return issues;
  }

  if (path === "lib.rs") {
    for (const instr of ir.instructions) {
      const fnName = snakeCase(instr.name);
      const bareCall = `${fnName}(program_id, accounts, data)`;
      const moduleCall = `instructions::${fnName}::${fnName}(program_id, accounts, data)`;
      if (!content.includes(bareCall) && !content.includes(moduleCall)) {
        issues.push({
          severity: "error",
          message: `Router in lib.rs does not dispatch instruction '${fnName}'.`,
          path,
        });
      }
    }
    return issues;
  }

  if (path === "instructions/mod.rs") {
    for (const instr of ir.instructions) {
      const fnName = snakeCase(instr.name);
      if (!content.includes(`pub mod ${fnName};`)) {
        issues.push({
          severity: "error",
          message: `instructions/mod.rs is missing module declaration for '${fnName}'.`,
          path,
        });
      }
    }
    return issues;
  }

  if (!path.includes("/") && path !== "lib.rs" && path !== "state.rs" && path !== "errors.rs" && path !== "helpers.rs" && path !== "events.rs") {
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
  }
  return issues;
}

/**
 * Check that every PDA account (isPda: true, non-init) has bump derivation
 * verified in its instruction. Missing bump checks mean the PDA is not verified.
 */
function checkPdaVerification(content: string, ir: SolanaIR, path: string): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (!shouldRunInstructionBodyChecks(path, content)) return issues;
  for (const instr of ir.instructions) {
    const fnName = snakeCase(instr.name);
    const fnBody = extractInstructionBody(content, fnName);
    if (!fnBody) continue;

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
 * Verify that every has_one constraint turned into a runtime equality check.
 * The emitter currently emits `if state.field != other.key { ... }`.
 */
function checkHasOneConstraints(content: string, ir: SolanaIR, path: string): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (!shouldRunInstructionBodyChecks(path, content)) return issues;

  for (const instr of ir.instructions) {
    const fnName = snakeCase(instr.name);
    const fnBody = extractInstructionBody(content, fnName);
    if (!fnBody) continue;

    for (const acc of instr.accounts) {
      const accountName = snakeCase(acc.name);
      for (const constraint of acc.constraints) {
        if (constraint.kind !== "has_one" || !constraint.value) continue;
        const fieldName = snakeCase(normalizedConstraintValue(constraint.value));
        const aliases = extractStateAliases(fnBody, accountName);
        const hasCheck = aliases.some((alias) => fnBody.includes(`${alias}.${fieldName}`))
          && fnBody.includes("ProgramError::InvalidAccountData");

        if (!hasCheck) {
          issues.push({
            severity: "error",
            message: `'${fnName}': has_one constraint '${acc.name}.${fieldName}' is not enforced in emitted output.`,
            path,
          });
        }
      }
    }
  }

  return issues;
}

/**
 * Verify close = destination constraints emit the expected cleanup path.
 */
function checkCloseConstraints(content: string, ir: SolanaIR, path: string): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (!shouldRunInstructionBodyChecks(path, content)) return issues;

  for (const instr of ir.instructions) {
    const fnName = snakeCase(instr.name);
    const fnBody = extractInstructionBody(content, fnName);
    if (!fnBody) continue;

    for (const acc of instr.accounts) {
      const accountName = snakeCase(acc.name);
      const closeConstraint = acc.constraints.find((constraint) => constraint.kind === "close" && constraint.value);
      if (!closeConstraint?.value) continue;

      const destination = snakeCase(normalizedConstraintValue(closeConstraint.value));
      const closesProgramAccount =
        fnBody.includes(`close_program_account(${accountName}`) &&
        fnBody.includes(destination);

      if (!closesProgramAccount) {
        issues.push({
          severity: "error",
          message: `'${fnName}': close constraint on '${accountName}' does not emit program-account close to '${destination}'.`,
          path,
        });
      }

      const hasDependentTokenAccount = instr.accounts.some((dependent) =>
        dependent.constraints.some((constraint) =>
          constraint.kind === "token::authority" && normalizedConstraintValue(constraint.value ?? "") === acc.name
        )
      );

      if (hasDependentTokenAccount) {
        const closesTokenAccount =
          fnBody.includes("spl_token_close_account(") ||
          fnBody.includes("spl_token_close_account_signed(");
        if (!closesTokenAccount) {
          issues.push({
            severity: "warning",
            message: `'${fnName}': close constraint on '${accountName}' should also close dependent token accounts, but no token close helper was emitted.`,
            path,
          });
        }
      }
    }
  }

  return issues;
}

/**
 * Verify init accounts have deterministic allocation wiring.
 * init_if_needed is currently treated more conservatively and must surface a warning
 * unless a future emitter adds explicit conditional allocation semantics.
 */
function checkInitConstraintCoverage(content: string, ir: SolanaIR, path: string): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (!shouldRunInstructionBodyChecks(path, content)) return issues;
  const stateNames = new Set(ir.accounts.map((a) => a.name));

  for (const instr of ir.instructions) {
    const fnName = snakeCase(instr.name);
    const fnBody = extractInstructionBody(content, fnName);
    if (!fnBody) continue;

    for (const acc of instr.accounts) {
      if (!stateNames.has(acc.accountType)) continue;

      const accountName = snakeCase(acc.name);
      const isInitIfNeeded = acc.constraints.some((constraint) => constraint.kind === "init_if_needed");
      const isInit = acc.constraints.some((constraint) => constraint.kind === "init");

      if (!isInit && !isInitIfNeeded) continue;

      if (!fnBody.includes(`create_program_account(${accountName}`)) {
        issues.push({
          severity: "error",
          message: `'${fnName}': init account '${accountName}' has no emitted create_program_account allocation path.`,
          path,
        });
      }

      if (acc.isPda && !fnBody.includes(`init_${accountName}_signer_seeds`) && !fnBody.includes(`bump_${accountName}`)) {
        issues.push({
          severity: "error",
          message: `'${fnName}': PDA init account '${accountName}' has no emitted signer-seed derivation.`,
          path,
        });
      }

      if (isInitIfNeeded) {
        const hasConditionalGuard =
          fnBody.includes(`if ${accountName}`) ||
          fnBody.includes(`${accountName}.data_is_empty`) ||
          fnBody.includes(`${accountName}.data_len() == 0`) ||
          fnBody.includes(`${accountName}.owner()`) ||
          fnBody.includes(`${accountName}.owner `);

        if (!hasConditionalGuard) {
          issues.push({
            severity: "warning",
            message: `'${fnName}': init_if_needed account '${accountName}' has no obvious conditional existence guard; allocation may still be unconditional.`,
            path,
          });
        }
      }
    }
  }

  return issues;
}

/**
 * Surface token / ATA constraints that the validator cannot prove are enforced.
 * This turns silent semantic drift into explicit review output.
 */
function checkTokenConstraintCoverage(content: string, ir: SolanaIR, path: string): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (!shouldRunInstructionBodyChecks(path, content)) return issues;

  for (const instr of ir.instructions) {
    const fnName = snakeCase(instr.name);
    const fnBody = extractInstructionBody(content, fnName);
    if (!fnBody) continue;

    for (const acc of instr.accounts) {
      const accountName = snakeCase(acc.name);
      const tokenConstraints = acc.constraints.filter((constraint) =>
        constraint.kind === "token::mint" ||
        constraint.kind === "token::authority" ||
        constraint.kind === "associated_token::mint" ||
        constraint.kind === "associated_token::authority"
      );
      if (tokenConstraints.length === 0) continue;

      const referencesAccount = fnBody.includes(accountName);
      const referencesTokenLogic =
        fnBody.includes("token_account_") ||
        fnBody.includes("spl_token_") ||
        fnBody.includes("InvalidAccountData");

      if (!referencesAccount || !referencesTokenLogic) {
        issues.push({
          severity: "warning",
          message: `'${fnName}': token/ATA constraints for '${accountName}' are present in IR, but validator cannot prove the emitted runtime checks.`,
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
  if (path === "state.rs" || path === "errors.rs" || path === "helpers.rs" || path === "instructions/mod.rs") {
    return issues;
  }
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

/**
 * Bracket-balance check on stripped (no comments, no string literals) content.
 *
 * If the parens/brackets/braces don't balance, the file definitively won't
 * compile. This is the cheapest, highest-signal check we can run — added
 * primarily to harden the AI refine path: a malformed AI patch fails this
 * before any cargo build attempt.
 */
function checkBracketBalance(content: string, path: string): ValidationIssue[] {
  // Strip line comments, block comments, and string/char/byte literals so
  // their contained brackets don't poison the count.
  const stripped = content
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "")
    .replace(/"(?:\\.|[^"\\\n])*"/g, '""')
    .replace(/'(?:\\.|[^'\\])'/g, "''")
    .replace(/b'(?:\\.|[^'\\])'/g, "b''")
    .replace(/r#"[\s\S]*?"#/g, '""');

  const counts: Record<string, number> = { "(": 0, ")": 0, "{": 0, "}": 0, "[": 0, "]": 0 };
  for (const ch of stripped) {
    if (counts[ch] !== undefined) counts[ch]++;
  }

  const issues: ValidationIssue[] = [];
  if (counts["("] !== counts[")"]) {
    issues.push({
      severity: "error",
      message: `Paren imbalance: ${counts["("]} '(' vs ${counts[")"]} ')' — file will not compile.`,
      path,
    });
  }
  if (counts["{"] !== counts["}"]) {
    issues.push({
      severity: "error",
      message: `Brace imbalance: ${counts["{"]} '{' vs ${counts["}"]} '}' — file will not compile.`,
      path,
    });
  }
  if (counts["["] !== counts["]"]) {
    issues.push({
      severity: "error",
      message: `Bracket imbalance: ${counts["["]} '[' vs ${counts["]"]} ']' — file will not compile.`,
      path,
    });
  }
  return issues;
}

/**
 * Detect TODO(manual) / FIXME(anvil) markers. Both are explicit "this code
 * does not actually work; manual rebuild required" sentinels written by:
 *   - body-emitter pass-through for unsupported external CPIs
 *   - walker.ts Metaplex / set_authority commentout fallbacks
 *   - the AI refine prompt when the model can't safely complete a patch
 *
 * Promoted from warning to error: cargo accepts them (they sit in
 * comments) but on-chain behavior is missing or wrong. Fail loud.
 */
function checkManualTodos(content: string, path: string): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (TODO_MANUAL_OR_FIXME_RE.test(lines[i] ?? "")) {
      issues.push({
        severity: "error",
        message: `Anvil ${MARKER_TODO_MANUAL} / ${MARKER_FIXME_ANVIL} marker still present — emitter could not safely transform this section; manual rebuild required before deploy.`,
        path,
        line: i + 1,
      });
    }
  }
  return issues;
}

/**
 * Detect the "// ⚠️ Anvil" stub-comment family the emitter writes for
 * untranslated CPIs. Two severities based on intent:
 *
 *   ERROR — markers describing code that does NOT implement the original
 *     behavior. Regex matches captions like "manual rebuild required",
 *     "could not resolve", "not yet supported", "TODO". The accompanying
 *     code is a placeholder skeleton that compiles but no-ops on-chain.
 *     Fail loud — these are silent runtime breakage waiting to happen.
 *
 *   WARNING — markers describing code that IS emitted but where the
 *     emitter wants a human to verify (account refs, type assumptions).
 *     Captions like "Review this section", "manually verify". The code
 *     runs as written; the marker is a hint, not a stub.
 *
 * Operates on raw content (not stripLineComments output) because the
 * regex pattern checks above can't see line comments.
 */
function checkUnsafeMarkers(content: string, path: string): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const isAnvilMarker = ANVIL_LINE_MARKER_RE.test(line) || ANVIL_BLOCK_MARKER_RE.test(line);
    if (!isAnvilMarker) continue;
    // Truly-broken markers contain one of these phrases; the surrounding
    // code is a non-functional stub.
    const isBroken = /manual rebuild required|manual implementation|could not resolve|not yet supported|TODO\(manual\)|TODO:|__BUMPS_FULL_STRUCT_TODO__|doesn't parse contexts/i.test(line);
    issues.push({
      severity: isBroken ? "error" : "warning",
      message: isBroken
        ? "Anvil unsafe-marker (// ⚠️ Anvil … manual rebuild / TODO / not yet supported) — the emit contains a non-functional stub that compiles but does not implement the original Anchor behavior."
        : "Anvil review marker (// ⚠️ Anvil … Review/verify) — code is emitted but flagged for human verification.",
      path,
      line: i + 1,
    });
  }
  return issues;
}

/**
 * Catch Anchor-only generic types (Account<'info, T>, Signer<'info>, etc.) that
 * AI patches may regress into. The previous regex catches the macros (require!,
 * emit!) but not the typed account wrappers — they're a common AI hallucination
 * because Anchor docs are everywhere in the model's training data.
 */
function checkAnchorTypedAccounts(content: string, path: string, target: DetectedTarget | null): ValidationIssue[] {
  if (target === null || target === "native") return [];
  const issues: ValidationIssue[] = [];
  const patterns: Array<[RegExp, string]> = [
    [/\bAccount\s*<\s*'info\s*,/, "Anchor Account<'info, T> wrapper"],
    [/\bSigner\s*<\s*'info\s*>/, "Anchor Signer<'info>"],
    [/\bProgram\s*<\s*'info\s*,/, "Anchor Program<'info, T>"],
    [/\bSystemAccount\s*<\s*'info\s*>/, "Anchor SystemAccount<'info>"],
    [/\bUncheckedAccount\s*<\s*'info\s*>/, "Anchor UncheckedAccount<'info>"],
    [/\bInterfaceAccount\s*<\s*'info\s*,/, "Anchor InterfaceAccount<'info, T>"],
    [/\bBox\s*<\s*Account\s*<\s*'info/, "Anchor Box<Account<'info, T>>"],
    [/#\[derive\s*\(\s*Accounts\s*\)\]/, "#[derive(Accounts)] (Anchor-only)"],
    [/#\[account\s*\]/, "#[account] attribute (Anchor-only)"],
    [/#\[program\s*\]/, "#[program] module attribute (Anchor-only)"],
  ];
  // Strip line comments before testing — the unsalvageable-helper
  // commentout pass commented out helper signatures that contain the
  // very Anchor types this check looks for, but that's intentionally
  // dead code (banner + body commented out, call sites also commented).
  // Without this strip, every commented-out helper signature falsely
  // triggers as a leak.
  const lines = content
    .split("\n")
    .map((l) => l.replace(/\/\/.*$/, ""));
  for (const [pattern, label] of patterns) {
    const lineIdx = lines.findIndex((line) => pattern.test(line));
    if (lineIdx >= 0) {
      issues.push({
        severity: "error",
        message: `${label} leaked into ${target} output — must use AccountInfo or framework equivalent.`,
        path,
        line: lineIdx + 1,
      });
    }
  }
  return issues;
}

/**
 * Cross-check declared account space against the minimum required by any
 * Token-2022 extensions the instruction body initializes on that mint /
 * token-account.
 *
 * E3 (EM2 closure). Pre-E3 a source with `init mint::decimals = 6,
 * mint::authority = X` AND `cpi_t22_transfer_fee_initialize(...)` could
 * declare `space = 82` (mint base only) — emit allocates 82 bytes,
 * TransferFee init CPI then fails at runtime because the extension
 * doesn't fit. Anvil produced no warning today; the user found out at
 * deploy time. Post-E3 the validator computes the per-extension minimum
 * (see t22-extension-sizes.ts) and refuses any allocation below.
 *
 * Detection key: an account with `accountType: "Mint"` that has an
 * `init` constraint AND a `space` constraint, paired with at least one
 * `cpi_t22_*_initialize` body statement that targets that account name
 * (or its snakeCase form). Multiple extensions on the same mint are
 * accumulated.
 */
function checkT22ExtensionSpaceAllocation(ir: SolanaIR): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  for (const instr of ir.instructions) {
    // Collect extension kinds keyed by the account they target. The IR
    // body kinds carry a `mint` (or `tokenAccount` for ImmutableOwner)
    // field that names the account; match against AccountRef.name.
    const extByAccount = new Map<string, BodyStatement["kind"][]>();
    for (const stmt of instr.body) {
      const info = T22_EXTENSION_BY_IR_KIND[stmt.kind];
      if (!info) continue;
      // Both `mint` and `tokenAccount` fields exist across the IR
      // family; only one is set per statement based on the extension's
      // attach point.
      const accountName =
        (stmt as unknown as { mint?: string }).mint
        ?? (stmt as unknown as { tokenAccount?: string }).tokenAccount;
      if (!accountName) continue;
      const list = extByAccount.get(accountName) ?? [];
      list.push(stmt.kind);
      extByAccount.set(accountName, list);
    }

    if (extByAccount.size === 0) continue;

    for (const acct of instr.accounts) {
      const kinds = extByAccount.get(acct.name);
      if (!kinds || kinds.length === 0) continue;

      // Find the `space = N` constraint, if explicitly set. Anchor's
      // `space = 8 + Foo::INIT_SPACE` is common — parse a leading integer
      // from the constraint value text. Patterns like `8 + 82` are
      // collapsed by light evaluation; non-integer expressions skip the
      // check (we can't validate dynamic computations from text alone).
      const spaceConstraint = acct.constraints.find((c) => c.kind === "realloc" || c.kind === "init")
        ? acct.constraints.find((c) => c.kind === "init" && c.value?.match(/space\s*=/))
          ?? acct.constraints.find((c) => c.value?.match(/space\s*=/))
        : undefined;
      const explicitSpace = (() => {
        for (const c of acct.constraints) {
          if (!c.value) continue;
          const m = c.value.match(/\bspace\s*=\s*([0-9+ \t]+)\b/);
          if (m && m[1]) {
            // Sum literal `n + n + n` terms; bail on anything else.
            const terms = m[1].split("+").map((t) => parseInt(t.trim(), 10));
            if (terms.every((n) => Number.isFinite(n))) {
              return terms.reduce((a, b) => a + b, 0);
            }
          }
        }
        return null;
      })();

      const attach = T22_EXTENSION_BY_IR_KIND[kinds[0]!]?.attach;
      const minSize = attach === "mint"
        ? minimumMintSize(kinds)
        : attach === "token_account"
          ? minimumTokenAccountSize(kinds)
          : null;

      if (minSize === null) {
        // Variable-size extension (TokenMetadata). Best-effort: only
        // surface a hint, no error.
        issues.push({
          severity: "warning",
          message:
            `instruction '${instr.name}': account '${acct.name}' uses Token-2022 ${extensionNames(kinds).join(" + ")} ` +
            `extension(s) including a variable-length type (TokenMetadata). ` +
            `Anvil can't compute a precise minimum size from the IR — verify your ` +
            `space allocation includes the AccountType marker (1B) + per-extension TLV (4B) + ` +
            `extension payload (≥ 76B base for TokenMetadata + Borsh-encoded strings).`,
        });
        continue;
      }

      if (explicitSpace === null) {
        // No explicit space = literal. Anchor may compute it via
        // InitSpace, which doesn't account for T22 extensions.
        // Surface as a warning so the user can verify their allocation.
        issues.push({
          severity: "warning",
          message:
            `instruction '${instr.name}': account '${acct.name}' inits Token-2022 ${extensionNames(kinds).join(" + ")} ` +
            `extension(s) requiring at least ${minSize} bytes, but the account has no explicit ` +
            `\`space = ${minSize}\` constraint. Anchor's InitSpace derive doesn't account for ` +
            `T22 extensions — verify your space allocation or set the constraint explicitly.`,
        });
        continue;
      }

      if (explicitSpace < minSize) {
        issues.push({
          severity: "error",
          message:
            `instruction '${instr.name}': account '${acct.name}' has \`space = ${explicitSpace}\` but ` +
            `Token-2022 ${extensionNames(kinds).join(" + ")} extension(s) require at least ${minSize} bytes ` +
            `(base + 1B AccountType marker + per-extension 4B TLV + payload). Under-allocation will fail ` +
            `the extension init CPI at runtime — increase \`space\` to ≥ ${minSize}.`,
        });
      }
    }
  }

  return issues;
}

// ─── Main validator ──────────────────────────────────────────────────────────

/**
 * Read-only validation pass over emitted code.
 *
 * The validator never mutates generated output. It reports deterministic
 * findings that can be shown directly to the user or handed to a later
 * fixer stage (human, deterministic re-emitter changes, or a single AI pass).
 */
export function validateEmitterOutput(ir: SolanaIR, output: EmitterOutput): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  for (const warning of output.warnings) {
    issues.push({
      severity: "warning",
      message: warning,
    });
  }

  // T22 extension space-cross-check runs at IR level (not per-file) because
  // the question is "does this account's space match the extensions the
  // instruction body inits on it?" — answerable from the IR alone.
  issues.push(...checkT22ExtensionSpaceAllocation(ir));

  // ── Typed-Result instruction return refusal (#20) ──
  //
  // Anchor's `pub fn ix(...) -> Result<T>` for non-unit T relies on the
  // anchor_lang macro expanding to a set_return_data() call. Anvil
  // doesn't reproduce that wire format end-to-end on Pinocchio/Native
  // (the documented design choice — see api/src/demo-programs/
  // return-data.rs:8-12, which recommends explicit set_return_data
  // instead). Silently dropping the typed return produces broken emit:
  //   Ok(value);   // discarded statement, E inference fails
  //   Ok(())       // unit tail from emitter
  // which cargo refuses with E0282 "cannot infer type parameter E".
  //
  // Refuse the emit and point users at the supported workaround.
  for (const ix of ir.instructions) {
    if (!ix.returnType) continue;
    const innerT = extractResultInnerType(ix.returnType);
    if (innerT === null) continue; // not a Result-shaped return
    if (innerT === "()" || innerT === "") continue; // unit Result is fine
    issues.push({
      severity: "error",
      message:
        `instruction '${ix.name}': typed Result<${innerT}> return is not supported. ` +
        `Anchor's macro wires set_return_data() for non-unit T; Anvil does not reproduce ` +
        `that wire format. Workaround: change the source to return Result<()> and call ` +
        `set_return_data(&value_bytes) explicitly inside the handler body (see ` +
        `api/src/demo-programs/return-data.rs for the supported pattern).`,
    });
  }

  // Parser-degradation warnings (loud signal). Each was emitted at a fallback
  // site in cpi-detector / body-classifier when the parser couldn't fully
  // classify a pattern. Surface as warnings (not errors) — the emit is still
  // valid pass-through code, just less typed than ideal. A user looking at
  // `// ⚠️ Anvil` markers in the emit output already gets the same hint;
  // this is the structural sibling.
  // Test fixtures sometimes hand-build IRs that bypass Zod's defaults — the
  // schema sets `warnings: [].default()` but a hand-rolled IR may omit it.
  for (const w of ir.warnings ?? []) {
    const where = w.instruction ? `instruction '${w.instruction}': ` : "";
    // path defaults to the source path the warning carries; the validator's
    // ValidationIssue carries `path` per emitted file, but parser warnings
    // pre-date emit so they reference the source file (or undefined for a
    // single-source parse — the consumer falls back to the input filename).
    //
    // H2 — escalation policy: anchor_pattern_in_passthrough is an Anchor
    // construct (ctx.accounts / CpiContext / anchor_spl:: / require! / emit!)
    // riding through verbatim into a target that doesn't understand it. The
    // post-emit ERROR_PATTERNS regex catches the emit-side leak but loses
    // source-line attribution — the validator only knows the emitted file's
    // line, not the Anchor source line. Escalating the parser warning to
    // ERROR carries the source location all the way through so the workbench
    // / CLI can render "your Anchor source at L:C will not transpile" rather
    // than "your emitted Rust contains a leaked pattern". Same correctness
    // posture either way; better UX.
    // Codes that block emit:
    //   - anchor_pattern_in_passthrough (H2): Anchor construct riding
    //     through verbatim into a target that can't satisfy it.
    //   - composite_accounts_field (#21): nested #[derive(Accounts)] field
    //     that Anvil's parser does not flatten — chained access compiles
    //     against AccountInfo and rustc refuses with E0609.
    const severity: ValidationSeverity =
      w.code === "anchor_pattern_in_passthrough" || w.code === "composite_accounts_field"
        ? "error"
        : "warning";
    issues.push({
      severity,
      message: `${where}[parser:${w.code}] ${w.message}`,
      ...(w.loc?.path ? { path: w.loc.path } : {}),
      ...(w.loc?.line ? { line: w.loc.line } : {}),
    });
  }

  // Defensive: validator only reasons about Rust sources. If callers later
  // include Cargo.toml / README.md in `files` (project scaffold), those are
  // stripped here so the Rust-specific regex patterns never fire on them.
  const files = (
    output.files.length > 0
      ? output.files
      : [{ path: `${ir.name}.rs`, content: output.singleFile }]
  ).filter((f) => f.path.endsWith(".rs"));
  issues.push(...checkUndefinedAssociatedConsts(files));
  issues.push(...checkExternalCrateDependencies(files));
  const aggregateTarget = detectTarget(files.map((file) => file.content).join("\n"));

  // ── Portability blocker check ──
  // The lint-analyzer's UNSUPPORTED_IMPORT_PATTERNS table identifies
  // imports Anvil doesn't structurally rewrite (Pyth, Switchboard,
  // mpl_core, Drift, etc.). Pre-this-check, those imports passed
  // validation and only surfaced as cargo errors downstream — bad UX
  // because the user has to wait for a long build to learn the emit
  // won't work. This pass scans `ir.imports` against the same table
  // and emits a validator error when the target's verdict for that
  // pattern is "blocker", so the --strict gate refuses to write the
  // output upfront. Native gets per-pattern verdicts (some blockers
  // are Pinocchio-only). Same data source as `anvil lint`.
  issues.push(...checkPortabilityBlockers(ir, aggregateTarget));

  for (const file of files) {
    const target = aggregateTarget ?? detectTarget(file.content);
    const codeForPatternChecks = stripLineComments(file.content);
    // ── Regex pattern checks ──
    for (const { pattern, message, targets } of ERROR_PATTERNS) {
      if (targets && target && !targets.includes(target)) continue;
      if (pattern.test(codeForPatternChecks)) {
        const lines = codeForPatternChecks.split("\n");
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
      if (pattern.test(codeForPatternChecks)) {
        issues.push({ severity: "warning", message, path: file.path });
      }
    }

    // ── Structural checks ──
    issues.push(...checkBracketBalance(file.content, file.path));
    issues.push(...checkAnchorTypedAccounts(file.content, file.path, target));
    issues.push(...checkManualTodos(file.content, file.path));
    issues.push(...checkUnsafeMarkers(file.content, file.path));
    issues.push(...checkDuplicateSeedBindings(file.content, file.path));
    issues.push(...checkAccountCountGuards(file.content, ir, file.path));
    issues.push(...checkOwnerChecks(file.content, ir, file.path));
    issues.push(...checkAllInstructionsEmitted(file.content, ir, file.path));
    issues.push(...checkPdaVerification(file.content, ir, file.path));
    issues.push(...checkHasOneConstraints(file.content, ir, file.path));
    issues.push(...checkCloseConstraints(file.content, ir, file.path));
    issues.push(...checkInitConstraintCoverage(file.content, ir, file.path));
    issues.push(...checkTokenConstraintCoverage(file.content, ir, file.path));
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

type DetectedTarget = "pinocchio" | "native";

function detectTarget(content: string): DetectedTarget | null {
  if (content.includes("pinocchio::")) return "pinocchio";
  if (content.includes("solana_program::")) return "native";
  return null;
}

function stripLineComments(content: string): string {
  return content
    .split("\n")
    .map((line) => line.replace(/\/\/.*$/, ""))
    .join("\n");
}

function collectDefinedModules(files: EmitterOutput["files"]): Set<string> {
  const names = new Set<string>();
  for (const file of files) {
    for (const match of file.content.matchAll(/\b(?:pub\s+)?mod\s+([A-Za-z_][A-Za-z0-9_]*)\s*(?:[;{])/g)) {
      if (match[1]) names.add(match[1]);
    }
  }
  return names;
}

function collectDefinedTypes(files: EmitterOutput["files"]): Set<string> {
  const names = new Set<string>();
  for (const file of files) {
    for (const match of file.content.matchAll(/\b(?:pub\s+)?(?:struct|enum)\s+([A-Z][A-Za-z0-9_]*)\b/g)) {
      if (match[1]) names.add(match[1]);
    }
  }
  return names;
}

/**
 * Well-known external types whose associated constants come from third-party
 * crates (not from anything Anvil emits). When the validator sees
 * `Type::CONST` for a type in this catalog, the const is treated as defined
 * regardless of whether Anvil's collectDefinedAssociatedConsts found it.
 *
 * Without this, the corpus sweep flagged 30+ false-positive errors per
 * heavyweight program -- I80F48 (from `fixed`) on Mango/MarginFi/Drift,
 * BorshDeserialize / AnchorDeserialize trait consts, etc.
 *
 * "*" as the const set means "any const access on this type is ok"
 * (catch-all when documenting the full surface isn't worth it).
 */
const EXTERNAL_TYPE_CONST_CATALOG: Record<string, "*" | Set<string>> = {
  // fixed::types — extensively used in Mango v4, MarginFi, Drift
  I80F48: new Set([
    "ZERO", "ONE", "MAX", "MIN", "DELTA",
    "NEG_ONE", "FRAC_PI_2", "PI", "E", "LN_2", "LN_10",
  ]),
  U64F64: new Set(["ZERO", "ONE", "MAX", "MIN", "DELTA"]),
  I64F64: new Set(["ZERO", "ONE", "MAX", "MIN", "DELTA"]),
  // Anchor + borsh trait constants the source can carry over verbatim
  BorshDeserialize: new Set(["DISCRIMINATOR"]),
  AnchorDeserialize: new Set(["DISCRIMINATOR"]),
  AnchorSerialize: new Set(["DISCRIMINATOR"]),
  // Solana primitives
  Pubkey: new Set(["LEN", "MAX_BASE58_LEN"]),
  // Common Rust std numeric types — their MAX/MIN/etc. are valid
  u8: "*", u16: "*", u32: "*", u64: "*", u128: "*", usize: "*",
  i8: "*", i16: "*", i32: "*", i64: "*", i128: "*", isize: "*",
  f32: "*", f64: "*",
};

function isExternalCatalogConst(typeName: string, constName: string): boolean {
  const entry = EXTERNAL_TYPE_CONST_CATALOG[typeName];
  if (!entry) return false;
  if (entry === "*") return true;
  return entry.has(constName);
}

function collectDefinedAssociatedConsts(files: EmitterOutput["files"]): Map<string, Set<string>> {
  const defs = new Map<string, Set<string>>();
  for (const file of files) {
    const implMatches = [...file.content.matchAll(/impl\s+([A-Z][A-Za-z0-9_]*)\s*\{([\s\S]*?)\n\}/g)];
    for (const match of implMatches) {
      const typeName = match[1];
      const body = match[2];
      if (!typeName || !body) continue;
      const consts = defs.get(typeName) ?? new Set<string>();
      for (const constMatch of body.matchAll(/\bpub\s+const\s+([A-Z][A-Z0-9_]*)\b/g)) {
        if (constMatch[1]) consts.add(constMatch[1]);
      }
      defs.set(typeName, consts);
    }

    // Enum variants are referenced with the same `Type::Name` syntax as
    // associated constants. Without harvesting them, every `Version::V1`,
    // `ContractTier::B`, `AuthorityType::AccountOwner` reference looks
    // undefined. Walk `enum X { … }` bodies and add the variant idents.
    const enumMatches = [...file.content.matchAll(/(?:pub\s+)?enum\s+([A-Z][A-Za-z0-9_]*)\s*(?:<[^>]*>)?\s*\{([\s\S]*?)\n\}/g)];
    for (const match of enumMatches) {
      const typeName = match[1];
      const body = match[2];
      if (!typeName || !body) continue;
      const consts = defs.get(typeName) ?? new Set<string>();
      // Variants: `Name`, `Name(...)`, `Name { ... }`, `Name = N`. Strip
      // the body's nested matching delimiters first so a struct-style
      // variant's inner fields don't get treated as siblings.
      const flatBody = body
        .replace(/\([^)]*\)/g, "()")
        .replace(/\{[^}]*\}/g, "{}");
      // Variant terminators: `()` `{}` `=` `,` end-of-line `$`, and end-of-body
      // `\s*$` — the last unit variant before the enum's closing `}` may
      // have nothing after it but whitespace + the closing brace (which
      // we've already stripped from `body`).
      for (const variantMatch of flatBody.matchAll(/\b([A-Z][A-Za-z0-9_]*)\s*(?:\(\)|\{\}|=|,|\s*$)/gm)) {
        if (variantMatch[1]) consts.add(variantMatch[1]);
      }
      // Catch-all: also harvest every leading-uppercase ident in the
      // (flattened) body. Variants are the only such tokens after we
      // strip nested fields/types via the flatten above.
      for (const ident of flatBody.matchAll(/\b([A-Z][A-Za-z0-9_]*)\b/g)) {
        if (ident[1]) consts.add(ident[1]);
      }
      defs.set(typeName, consts);
    }
  }
  return defs;
}

/**
 * Walk ir.imports against the lint-analyzer's UNSUPPORTED_IMPORT_PATTERNS
 * table. Emits a validator error for each import whose verdict is "blocker"
 * for the detected target. Allows the strict gate (--strict default in
 * v0.4+) to refuse before cargo runs.
 *
 * Detected target defaults to "pinocchio" when emit is empty / heuristic
 * fails — Pinocchio has the more conservative blocker set, so defaulting
 * there minimizes false negatives.
 */
function checkPortabilityBlockers(
  ir: SolanaIR,
  detectedTarget: "pinocchio" | "native" | null,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const target: LintTarget = detectedTarget ?? "pinocchio";
  const imports = ir.imports ?? [];
  const seen = new Set<string>(); // dedupe per prefix
  for (const importLine of imports) {
    for (const p of UNSUPPORTED_IMPORT_PATTERNS) {
      if (seen.has(p.prefix)) continue;
      if (!importLine.includes(p.prefix)) continue;
      const verdict = p.verdict(target);
      if (verdict !== "blocker") continue;
      seen.add(p.prefix);
      issues.push({
        severity: "error",
        message: `[portability] ${p.title}: ${p.detail(target)}`,
      });
    }
  }
  return issues;
}

function checkUndefinedAssociatedConsts(files: EmitterOutput["files"]): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const definedTypes = collectDefinedTypes(files);
  const definedConsts = collectDefinedAssociatedConsts(files);

  for (const file of files) {
    // Match Type::CONST AND Type::Variant (the regex used to require the
    // RHS to be ALL_CAPS; that missed enum variants like `Version::V1`).
    // Now match any leading-uppercase RHS; the catalog + enum-variant
    // collection handle the disambiguation.
    for (const match of file.content.matchAll(/\b([A-Z][A-Za-z0-9_]*)::([A-Z][A-Za-z0-9_]*)\b/g)) {
      const typeName = match[1];
      const constName = match[2];
      if (!typeName || !constName) continue;
      // External-type catalog skip BEFORE the definedTypes check —
      // I80F48 etc. come from third-party crates and won't be in
      // definedTypes anyway, but the catalog also covers cases where
      // an emit happens to define a same-named local type (false-positive
      // would over-trigger).
      if (isExternalCatalogConst(typeName, constName)) continue;
      if (!definedTypes.has(typeName)) continue;
      if (definedConsts.get(typeName)?.has(constName)) continue;
      const line = file.content.slice(0, match.index ?? 0).split("\n").length;
      issues.push({
        severity: "error",
        message: `Associated constant '${typeName}::${constName}' is referenced but not defined in emitted output.`,
        path: file.path,
        line,
      });
    }
  }

  return issues;
}

function checkExternalCrateDependencies(files: EmitterOutput["files"]): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const modules = collectDefinedModules(files);
  // Cross-file `use` bindings. `instructions/raw_transfer.rs` does
  // `use super::*;` which inherits everything `instructions/mod.rs` exposed,
  // which in turn does `use crate::*;` to inherit from `lib.rs`. We don't
  // model that scope chain explicitly — collecting bindings across every
  // emitted file gives the same answer (a binding in lib.rs is reachable
  // from anywhere via use super::*/use crate::*).
  const crossFileBindings = new Set<string>();
  for (const f of files) {
    for (const b of collectUseBindings(f.content)) crossFileBindings.add(b);
  }
  // Crates the scaffold auto-injects when emit references them.
  // Pre-this-extension the warning fired on bytemuck (zero-copy) +
  // spl_token_2022 (Native T22 extensions) + spl_token (Native SPL)
  // + spl_associated_token_account / spl_memo / mpl_token_metadata
  // even though `buildProjectScaffold` adds them to Cargo.toml.
  // Result: noise hides real "did you forget X" findings on
  // genuinely-unexpected crates (Pyth/Switchboard/Drift, which
  // checkPortabilityBlockers catches with a stronger error).
  const allowed = new Set([
    "clippy",
    "std",
    "core",
    "alloc",
    "crate",
    "self",
    "super",
    "borsh",
    "bytemuck",
    "solana_program",
    "pinocchio",
    "pinocchio_system",
    "pinocchio_token",
    "spl_token",
    "spl_token_2022",
    "spl_associated_token_account",
    "spl_memo",
    "spl_token_metadata_interface",
    "mpl_token_metadata",
    "pinocchio_associated_token_account",
    "pinocchio_token_2022",
    "u8",
    "u16",
    "u32",
    "u64",
    "u128",
    "i8",
    "i16",
    "i32",
    "i64",
    "i128",
  ]);

  for (const file of files) {
    const seen = new Set<string>();
    // Names brought into local scope by `use` lines — across the whole project
    // (see crossFileBindings comment above for the reachability rationale).
    const useBindings = crossFileBindings;
    // Strip block comments globally (they can span lines), then strip line
    // comments per-line below. Without this, the bare-call regex matched
    // `// token::transfer(...)` inside commented-out unsalvageable-helper
    // bodies and flagged `token` as an unexpected crate.
    const sansBlocks = file.content.replace(/\/\*[\s\S]*?\*\//g, "");
    const lines = sansBlocks.split("\n");
    let inUseBlock = false;
    for (let i = 0; i < lines.length; i++) {
      const rawLine = lines[i];
      if (!rawLine) continue;
      const line = rawLine.replace(/\/\/.*$/, "");
      if (!line) continue;

      if (/^\s*use\s+/.test(line)) {
        inUseBlock = true;
        const useMatch = line.match(/^\s*use\s+([a-z][a-z0-9_]*)::/);
        if (useMatch?.[1]) {
          const prefix = useMatch[1];
          if (!allowed.has(prefix) && !modules.has(prefix) && !seen.has(prefix)) {
            seen.add(prefix);
            issues.push({
              severity: "warning",
              message: `External crate '${prefix}' is referenced in emitted output; ensure the target manifest includes this dependency.`,
              path: file.path,
              line: i + 1,
            });
          }
        }
        if (line.includes(";")) inUseBlock = false;
        continue;
      }

      if (inUseBlock) {
        if (line.includes(";")) inUseBlock = false;
        continue;
      }

      for (const match of line.matchAll(/(?<![:\w])([a-z][a-z0-9_]*)::[A-Za-z_][A-Za-z0-9_:]*/g)) {
        const prefix = match[1];
        if (!prefix || allowed.has(prefix) || modules.has(prefix) || seen.has(prefix)) continue;
        if (useBindings.has(prefix)) continue;
        seen.add(prefix);
        issues.push({
          severity: "warning",
          message: `External crate '${prefix}' is referenced in emitted output; ensure the target manifest includes this dependency.`,
          path: file.path,
          line: i + 1,
        });
      }
    }
  }

  return issues;
}

/**
 * Walk a Rust source string and return the set of lowercase identifiers
 * brought into local scope by `use` lines. Handles:
 *   use foo::bar::baz;                          -> { baz }
 *   use foo::{bar, baz};                        -> { bar, baz }
 *   use foo::{bar::quux, baz::frob};            -> { quux, frob }
 *   use foo::bar as alias;                      -> { alias }
 *   use foo::{                                   -> multi-line block; joined and parsed
 *     bar,
 *     baz,
 *   };
 *
 * Only lowercase-leading idents are tracked because they're the only ones
 * checkExternalCrateDependencies' bare-call regex flags as crates.
 */
function collectUseBindings(content: string): Set<string> {
  const bindings = new Set<string>();
  // Join continuation lines so multi-line brace-imports are processed as one.
  const joined = content.replace(/\n\s*/g, " ");
  for (const match of joined.matchAll(/\buse\s+([^;]+);/g)) {
    const path = match[1]?.trim();
    if (!path) continue;
    collectBindingsFromPath(path, bindings);
  }
  return bindings;
}

function collectBindingsFromPath(path: string, out: Set<string>): void {
  // Strip an optional leading `pub`/`pub(...)`.
  const stripped = path.replace(/^pub(?:\(.+?\))?\s+/, "");
  const braceStart = stripped.indexOf("{");
  if (braceStart === -1) {
    // Simple path: foo::bar::baz [as alias]
    const aliasMatch = stripped.match(/\bas\s+([a-z][a-z0-9_]*)\s*$/);
    if (aliasMatch?.[1]) {
      out.add(aliasMatch[1]);
      return;
    }
    const tail = stripped.split("::").pop()?.trim();
    if (!tail || tail === "*" || tail === "self") return;
    const m = tail.match(/^([a-z][a-z0-9_]*)/);
    if (m?.[1]) out.add(m[1]);
    return;
  }
  // Brace-import: walk balanced top-level commas inside { ... }.
  const braceEnd = findMatchingBrace(stripped, braceStart);
  if (braceEnd === -1) return;
  const inner = stripped.slice(braceStart + 1, braceEnd);
  for (const part of splitTopLevelCommas(inner)) {
    const trimmed = part.trim();
    if (!trimmed || trimmed === "*" || trimmed === "self") continue;
    collectBindingsFromPath(trimmed, out);
  }
}

function findMatchingBrace(s: string, openIdx: number): number {
  let depth = 0;
  for (let i = openIdx; i < s.length; i++) {
    if (s[i] === "{") depth++;
    else if (s[i] === "}") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function splitTopLevelCommas(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === "{") depth++;
    else if (ch === "}") depth--;
    else if (ch === "," && depth === 0) {
      out.push(s.slice(start, i));
      start = i + 1;
    }
  }
  out.push(s.slice(start));
  return out;
}

function isInstructionFile(path: string): boolean {
  return /^instructions\/[^/]+\.rs$/.test(path) && path !== "instructions/mod.rs";
}

function shouldRunInstructionBodyChecks(path: string, content: string): boolean {
  if (path.endsWith(".rs") && isInstructionFile(path)) return true;
  if (path === "lib.rs" || path === "state.rs" || path === "errors.rs" || path === "helpers.rs" || path === "instructions/mod.rs") {
    return false;
  }
  if (path.startsWith("instructions/")) {
    return false;
  }
  return true;
}

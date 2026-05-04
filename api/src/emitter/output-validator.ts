import type { EmitterOutput, SolanaIR } from "../ir/schema.js";
import { snakeCase } from "./emitter-utils.js";
import { validateQuasarOutput } from "./quasar-validator.js";

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
    pattern: /TODO\(anvil\)/,
    message: "Emitter marker TODO(anvil) still present — this feature is not implemented.",
  },
  {
    pattern: /TODO: parse/,
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
    pattern: /\b[A-Z][A-Za-z0-9_]*CpiBuilder::new\s*\(/,
    message: "Third-party Anchor CPI builder leaked into a non-native target; this target cannot safely carry external Anchor-style builder CPIs.",
    targets: ["pinocchio", "quasar"],
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
    targets: ["pinocchio", "quasar"],
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
    if (/TODO\(manual\)|FIXME\(anvil\)/.test(lines[i] ?? "")) {
      issues.push({
        severity: "error",
        message: "Anvil TODO(manual) / FIXME(anvil) marker still present — emitter could not safely transform this section; manual rebuild required before deploy.",
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
    const isAnvilMarker = /\/\/\s*⚠️\s*Anvil[\s:]/.test(line) || /\/\*\s*⚠️\s*Anvil[\s:]/.test(line);
    if (!isAnvilMarker) continue;
    // Truly-broken markers contain one of these phrases; the surrounding
    // code is a non-functional stub.
    const isBroken = /manual rebuild required|manual implementation|could not resolve|not yet supported|TODO\(manual\)|TODO:/i.test(line);
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
  const lines = content.split("\n");
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

// ─── Main validator ──────────────────────────────────────────────────────────

/**
 * Read-only validation pass over emitted code.
 *
 * The validator never mutates generated output. It reports deterministic
 * findings that can be shown directly to the user or handed to a later
 * fixer stage (human, deterministic re-emitter changes, or a single AI pass).
 */
export function validateEmitterOutput(ir: SolanaIR, output: EmitterOutput): ValidationIssue[] {
  // Detect target from output content — route quasar to dedicated validator
  const allContent = output.files.map(f => f.content).join("\n") || output.singleFile;
  if (allContent.includes("quasar_lang::") || allContent.includes("quasar_spl::") || detectTarget(allContent) === "quasar") {
    return validateQuasarOutput(ir, output);
  }

  const issues: ValidationIssue[] = [];

  for (const warning of output.warnings) {
    issues.push({
      severity: "warning",
      message: warning,
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
    issues.push({
      severity: "warning",
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

type DetectedTarget = "pinocchio" | "quasar" | "native";

function detectTarget(content: string): DetectedTarget | null {
  if (content.includes("pinocchio::")) return "pinocchio";
  if (content.includes("quasar::") || content.includes("quasar_lang::") || content.includes("quasar_spl::")) return "quasar";
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
  }
  return defs;
}

function checkUndefinedAssociatedConsts(files: EmitterOutput["files"]): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const definedTypes = collectDefinedTypes(files);
  const definedConsts = collectDefinedAssociatedConsts(files);

  for (const file of files) {
    for (const match of file.content.matchAll(/\b([A-Z][A-Za-z0-9_]*)::([A-Z][A-Z0-9_]*)\b/g)) {
      const typeName = match[1];
      const constName = match[2];
      if (!typeName || !constName) continue;
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
  const allowed = new Set([
    "clippy",
    "std",
    "core",
    "alloc",
    "crate",
    "self",
    "super",
    "borsh",
    "solana_program",
    "pinocchio",
    "pinocchio_system",
    "pinocchio_token",
    "quasar",
    "quasar_lang",
    "quasar_spl",
    "quasar_token",
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
    const lines = file.content.split("\n");
    let inUseBlock = false;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
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

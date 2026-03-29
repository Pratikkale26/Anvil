/**
 * Emitter Base — Shared foundation for all target framework emitters.
 *
 * Provides:
 *   - Common utilities (typeSize, snakeCase, discriminatorBytes, etc.)
 *   - Abstract interface that each framework emitter implements
 *   - Generic instruction body emitter that walks BodyStatements and
 *     calls framework-specific transform functions for TRANSFORM ops,
 *     while passing through pure Rust code unchanged.
 *   - Multi-file output generation (lib.rs, state.rs, instructions/, errors.rs)
 */

import { createHash } from "crypto";
import type {
  SolanaIR,
  AccountDef,
  Instruction,
  Arg,
  BodyStatement,
  EmitterOutput,
  EmitterFile,
} from "../ir/schema.js";

// ─── Abstract Emitter Interface ──────────────────────────────────────────────

export abstract class BaseEmitter {
  abstract readonly frameworkName: string;
  protected currentIr: SolanaIR | null = null;

  /** Warnings accumulated during emission */
  protected warnings: string[] = [];
  protected transformedCount = 0;
  protected passedThroughCount = 0;
  protected details: string[] = [];

  // ── Framework-specific methods (MUST override) ──

  abstract emitUseStatements(ir: SolanaIR): string;
  abstract emitEntrypoint(ir: SolanaIR): string;
  abstract emitRouter(ir: SolanaIR): string;
  abstract emitAccountStruct(acc: AccountDef): string;
  abstract emitErrorEnum(ir: SolanaIR): string;

  // ── Account access patterns ──
  abstract emitAccountBinding(name: string, index: number): string;
  abstract emitSignerCheck(name: string): string;
  abstract emitOwnerCheck(name: string): string;
  abstract emitWritableCheck(names: string[]): string;
  abstract emitAccountKeyExpr(accountName: string): string;
  abstract emitAccountKeyAsRefExpr(accountName: string): string;
  abstract emitAccountLamportsExpr(accountName: string): string;
  abstract emitStateRead(accountName: string, typeName: string, localVar: string, mutable: boolean): string;
  abstract emitStateSave(accountName: string, typeName: string, localVar: string): string;
  abstract emitBumpSeed(programId: string, seeds: string[], expectedKey: string): string;

  // ── CPI transforms ──
  abstract emitSystemTransfer(from: string, to: string, amount: string, signerSeeds?: string): string;
  abstract emitSplTransfer(from: string, to: string, authority: string, amount: string, signerSeeds?: string): string;
  abstract emitSplMintTo(mint: string, to: string, authority: string, amount: string, signerSeeds?: string): string;
  abstract emitSplBurn(from: string, mint: string, authority: string, amount: string, signerSeeds?: string): string;
  abstract emitSplCloseAccount(account: string, destination: string, authority: string, signerSeeds?: string): string;
  abstract emitProgramAccountClose(account: string, destination: string): string;

  // ── PDA signer seeds ──
  abstract emitPdaSignerSeeds(
    account: string,
    accountInfoVar: string,
    seeds: string[],
    bumpField?: string,
    stateVar?: string,
    typeName?: string,
  ): string;

  // ── Macro transforms ──
  abstract emitRequire(condition: string, error: string): string;
  abstract emitMsg(message: string): string;
  abstract emitEmit(event: string, fields: string): string;

  // ── Sysvar transforms ──
  abstract emitClockGet(localVar: string): string;
  abstract emitRentGet(localVar: string): string;

  // ── Type mapping ──
  abstract rustTypeForFramework(typeName: string): string;

  // ── Helpers that the framework might need ──
  abstract emitHelperFunctions(ir: SolanaIR): string;

  /**
   * Transform an amount expression from Anchor-style to target framework.
   * Handles patterns like:
   *   - "vault.amount" → "token_account_amount(vault)?" (Pinocchio)
   *   - "maker_ata_a.amount" → "token_account_amount(maker_ata_a)?" (Pinocchio)
   *   - raw numbers/variables pass through unchanged
   * Subclasses can override for framework-specific behavior.
   */
  transformAmountExpr(amount: string): string {
    // Pattern: X.amount → token account read
    const tokenAmountMatch = amount.match(/^(\w+)\.amount$/);
    if (tokenAmountMatch?.[1]) {
      return `token_account_amount(${snakeCase(tokenAmountMatch[1])})?`;
    }
    return amount;
  }

  // ─── Generic emission pipeline ─────────────────────────────────────────────

  /**
   * Main entry point: emit the full program.
   * Returns multi-file output + combined single file.
   */
  emit(ir: SolanaIR): EmitterOutput {
    this.currentIr = ir;
    this.warnings = [];
    this.transformedCount = 0;
    this.passedThroughCount = 0;
    this.details = [];

    const files: EmitterFile[] = [];

    // ── lib.rs ──
    const libContent = this.emitLibFile(ir);
    files.push({ path: "lib.rs", content: libContent });

    // ── state.rs (account structs) ──
    if (ir.accounts.length > 0) {
      const stateContent = this.emitStateFile(ir);
      files.push({ path: "state.rs", content: stateContent });
    }

    // ── instructions/ ──
    if (ir.instructions.length > 0) {
      const instrModContent = this.emitInstructionsModFile(ir);
      files.push({ path: "instructions/mod.rs", content: instrModContent });

      for (const instr of ir.instructions) {
        const instrContent = this.emitInstructionFile(instr, ir);
        files.push({ path: `instructions/${snakeCase(instr.name)}.rs`, content: instrContent });
      }
    }

    // ── errors.rs ──
    if (ir.errors.length > 0) {
      const errorsContent = this.emitErrorsFile(ir);
      files.push({ path: "errors.rs", content: errorsContent });
    }

    // ── helpers.rs ──
    const helpersContent = this.emitHelpersFile(ir);
    if (helpersContent.trim()) {
      files.push({ path: "helpers.rs", content: helpersContent });
    }

    // ── Combined single file (backward compat) ──
    const singleFile = this.emitSingleFile(ir);

    return {
      files,
      singleFile,
      warnings: this.warnings,
      transformReport: {
        transformedCount: this.transformedCount,
        passedThroughCount: this.passedThroughCount,
        details: this.details,
      },
    };
  }

  // ── File generators ──

  private emitLibFile(ir: SolanaIR): string {
    const sections: string[] = [];
    const constants = ir.constants ?? [];
    const types = ir.types ?? [];
    sections.push(this.fileHeader(ir.name));
    sections.push(this.emitUseStatements(ir));
    if (constants.length > 0) sections.push(constants.join("\n\n"));
    if (types.length > 0) sections.push(this.emitCustomTypes({ ...ir, types }));

    if (ir.accounts.length > 0) sections.push("mod state;");
    if (ir.instructions.length > 0) sections.push("mod instructions;");
    if (ir.errors.length > 0) sections.push("mod errors;");

    sections.push(this.emitEntrypoint(ir));
    sections.push(this.emitRouter(ir));

    return sections.join("\n\n");
  }

  private emitStateFile(ir: SolanaIR): string {
    const sections: string[] = [];
    sections.push(`//! State account definitions for ${toPascalCase(ir.name)}`);
    sections.push(`//! Generated by Anvil v0.2.0 — Target: ${this.frameworkName}\n`);

    for (const acc of ir.accounts) {
      sections.push(this.emitAccountStruct(acc));
    }
    return sections.join("\n\n");
  }

  private emitInstructionsModFile(ir: SolanaIR): string {
    const mods = ir.instructions
      .map((i) => `pub mod ${snakeCase(i.name)};`)
      .join("\n");
    return `//! Instruction processors for ${toPascalCase(ir.name)}\n\n${mods}\n`;
  }

  private emitInstructionFile(instr: Instruction, ir: SolanaIR): string {
    return this.emitInstructionFunction(instr, ir);
  }

  private emitErrorsFile(ir: SolanaIR): string {
    return `//! Error definitions for ${toPascalCase(ir.name)}\n\n` + this.emitErrorEnum(ir);
  }

  private emitHelpersFile(ir: SolanaIR): string {
    const sections: string[] = [];

    // Framework-specific helpers (transfer_lamports, etc.)
    const frameworkHelpers = this.emitHelperFunctions(ir);
    if (frameworkHelpers.trim()) sections.push(frameworkHelpers);

    // Carry over helper functions from source
    for (const helper of ir.helperFns) {
      sections.push(`// Carried from source\n${this.transformHelperCode(helper.rawCode)}`);
    }

    if (sections.length === 0) return "";
    return `//! Helper functions for ${toPascalCase(ir.name)}\n\n` + sections.join("\n\n");
  }

  // ── Combined single-file output ──

  protected emitSingleFile(ir: SolanaIR): string {
    const sections: string[] = [];
    const constants = ir.constants ?? [];
    const types = ir.types ?? [];

    sections.push(this.fileHeader(ir.name));
    sections.push(this.emitUseStatements(ir));
    if (constants.length > 0) sections.push(constants.join("\n\n"));
    if (types.length > 0) sections.push(this.emitCustomTypes({ ...ir, types }));
    sections.push(this.emitEntrypoint(ir));
    sections.push(this.emitRouter(ir));

    for (const instr of ir.instructions) {
      sections.push(this.emitInstructionFunction(instr, ir));
    }

    for (const acc of ir.accounts) {
      sections.push(this.emitAccountStruct(acc));
    }

    const helpers = this.emitHelperFunctions(ir);
    if (helpers.trim()) sections.push(helpers);

    // Carry over helper functions from source
    for (const helper of ir.helperFns) {
      sections.push(`// Carried from source\n${this.transformHelperCode(helper.rawCode)}`);
    }

    if (ir.errors.length > 0) {
      sections.push(this.emitErrorEnum(ir));
    }

    return sections.join("\n\n");
  }

  // ─── Generic instruction function emitter ──────────────────────────────────

  protected emitInstructionFunction(instr: Instruction, ir: SolanaIR): string {
    const nonProgramAccounts = instr.accounts.filter(
      (a) => !isProgramAccount(a.accountType)
    );
    const requiredAccountCount = nonProgramAccounts.filter((a) => !a.isOptional).length;

    // Account bindings
    const bindings = nonProgramAccounts
      .map((acc, idx) => acc.isOptional
        ? `    let ${snakeCase(acc.name)} = accounts.get(${idx});`
        : this.emitAccountBinding(snakeCase(acc.name), idx))
      .join("\n");

    // Signer checks
    const signerChecks = nonProgramAccounts
      .filter((a) => a.isSigner && !a.isOptional)
      .map((a) => this.emitSignerCheck(snakeCase(a.name)))
      .join("\n");

    // Arg parsing
    const argsBlock = this.emitArgParsing(instr.args);

    // Body emission — the main event
    const bodyCode = this.emitBodyStatements(instr.body, instr, ir);

    // Check if body already ends with Ok(()) — no `return_ok` in body means we add one
    const bodyHasReturnOk = instr.body.some(s => s.kind === "return_ok");
    const bodyHasOkPassThrough = instr.body.some(
      s => s.kind === "pass_through" && s.code.trim() === "Ok(())"
    );
    const needsOkReturn = !bodyHasReturnOk && !bodyHasOkPassThrough;

    return `fn ${snakeCase(instr.name)}(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    data: &[u8],
) -> ProgramResult {
    if accounts.len() < ${requiredAccountCount} {
        return Err(ProgramError::NotEnoughAccountKeys);
    }

${bindings}
${signerChecks ? `\n${signerChecks}\n` : ""}
${argsBlock}

${bodyCode}
${needsOkReturn ? "\n    Ok(())" : ""}
}`;
  }

  // ─── Body statement walker ─────────────────────────────────────────────────

  protected emitBodyStatements(
    statements: BodyStatement[],
    instr: Instruction,
    ir: SolanaIR
  ): string {
    const lines: string[] = [];
    const isGeneratedStateType = (typeName: string): boolean =>
      ir.accounts.some((account) => account.name === typeName);
    const stateAccountNames = instr.accounts
      .filter((account) => isGeneratedStateType(account.accountType))
      .map((account) => snakeCase(account.name));
    const detectPassThroughMutations = (code: string): string[] =>
      stateAccountNames.filter((accountName) =>
        new RegExp(`\\b${accountName}\\.\\w+\\s*=`).test(code)
      );
    const mutableStateAccounts = new Set(
      statements.flatMap((stmt) => {
        if (stmt.kind === "state_field_assign") return [snakeCase(stmt.account)];
        if (stmt.kind === "state_read" && stmt.mutable) return [snakeCase(stmt.account)];
        if (stmt.kind === "pass_through") return detectPassThroughMutations(stmt.code);
        return [];
      })
    );

    // Collect which accounts are mutated (for auto-save)
    const mutatedAccounts = new Set(
      statements.flatMap((stmt) =>
        stmt.kind === "pass_through" ? detectPassThroughMutations(stmt.code) : []
      )
    );
    const stateVars = new Map<string, string>();
    const accountInfoVars = new Map<string, string>();
    const accountsWithSignerSeeds = new Set<string>();

    const resolveStateVar = (account: string): string => stateVars.get(account) ?? account;
    const resolveAccountInfoVar = (account: string): string => accountInfoVars.get(account) ?? account;
    const ensureStateRead = (account: string, mutable = false): string => {
      const normalized = snakeCase(account);
      const existing = stateVars.get(normalized);
      if (existing) return existing;
      const accountRef = instr.accounts.find((acc) => snakeCase(acc.name) === normalized);
      const typeName = accountRef?.accountType ?? "Unknown";
      if (!isGeneratedStateType(typeName)) {
        return normalized;
      }
      const localVar = normalized;
      const accountInfoVar = `${normalized}_account`;
      lines.push(`    let ${accountInfoVar} = ${normalized};`);
      stateVars.set(normalized, localVar);
      accountInfoVars.set(normalized, accountInfoVar);
      lines.push(this.emitStateRead(
        accountInfoVar,
        typeName,
        localVar,
        mutable || mutableStateAccounts.has(normalized)
      ));
      const hasOneConstraints = accountRef?.constraints.filter(
        (constraint) => constraint.kind === "has_one" && constraint.value
      ) ?? [];
      for (const constraint of hasOneConstraints) {
        const targetAccount = snakeCase(stripAnchorConstraintError(constraint.value!));
        const targetRef = instr.accounts.find((acc) => snakeCase(acc.name) === targetAccount);
        if (!targetRef) continue;
        lines.push(`    if ${localVar}.${snakeCase(constraint.value!)} != ${this.emitAccountKeyExpr(resolveAccountInfoVar(targetAccount))} {`);
        lines.push(`        return Err(ProgramError::InvalidAccountData);`);
        lines.push(`    }`);
      }
      return localVar;
    };
    const normalizeSeedExpr = (seed: string): string => {
      let normalized = seed;
      normalized = normalized.replace(/ctx\.accounts\.(\w+)\.(\w+)/g, (_full, name: string, field: string) => {
        const accountName = snakeCase(name);
        const accountRef = instr.accounts.find((acc) => snakeCase(acc.name) === accountName);
        if (!accountRef) return `${accountName}.${snakeCase(field)}`;
        if (field === "key") return resolveAccountInfoVar(accountName);
        if (isGeneratedStateType(accountRef.accountType)) {
          const localVar = ensureStateRead(accountName);
          return `${localVar}.${snakeCase(field)}`;
        }
        return `${resolveAccountInfoVar(accountName)}.${snakeCase(field)}`;
      });
      for (const account of instr.accounts) {
        const accountName = snakeCase(account.name);
        const accountInfoVar = resolveAccountInfoVar(accountName);
        normalized = normalized.split(`${accountName}.key().as_ref()`).join(
          this.emitAccountKeyAsRefExpr(accountInfoVar)
        );
        normalized = normalized.split(`${accountName}.key.as_ref()`).join(
          this.emitAccountKeyAsRefExpr(accountInfoVar)
        );
        normalized = normalized.split(`${resolveStateVar(accountName)}.key().as_ref()`).join(
          this.emitAccountKeyAsRefExpr(accountInfoVar)
        );
        normalized = normalized.split(`${resolveStateVar(accountName)}.key.as_ref()`).join(
          this.emitAccountKeyAsRefExpr(accountInfoVar)
        );
      }
      return normalized;
    };
    const normalizedBumpLine = (accountName: string): string => {
      const accountRef = instr.accounts.find((acc) => snakeCase(acc.name) === snakeCase(accountName));
      const pdaSeeds = (accountRef?.pdaSeeds ?? [`b"${snakeCase(accountName)}"`]).map(normalizeSeedExpr);
      const emitted = this.emitBumpSeed(
        "program_id",
        pdaSeeds,
        resolveAccountInfoVar(snakeCase(accountName))
      );
      return emitted
        .replace(/\blet bump =/g, `let bump_${snakeCase(accountName)} =`)
        .replace(/\blet\s+\(expected_key,\s*bump\)\s*=/g, `let (expected_key, bump_${snakeCase(accountName)}) =`);
    };
    const emitCanonicalSignerSeeds = (accountRef: typeof instr.accounts[number]): string => {
      const canonical = snakeCase(accountRef.name);
      const pdaSeeds = (accountRef.pdaSeeds ?? [`b"${canonical}"`]).map(normalizeSeedExpr);
      const bumpLine = normalizedBumpLine(canonical);
      const bumpVar = `bump_${canonical}`;
      const seedsWithBump = [...pdaSeeds, `&[${bumpVar}]`].join(",\n            ");
      return `${bumpLine}
    let seeds = &[
            ${seedsWithBump},
        ];
    let signer_seeds = &[&seeds[..]];`;
    };
    const replaceBumpRefs = (code: string): { prelude: string[]; code: string } => {
      const prelude: string[] = [];
      const seen = new Set<string>();
      const transformed = code.replace(/ctx\.bumps\.(\w+)/g, (_full, accountName: string) => {
        const normalized = snakeCase(accountName);
        if (!seen.has(normalized)) {
          seen.add(normalized);
          prelude.push(normalizedBumpLine(normalized));
        }
        return `bump_${normalized}`;
      });
      return { prelude, code: transformed };
    };
    const normalizeAccountExpr = (expr: string): string => {
      const trimmed = cleanInlineExpr(expr).replace(/\.to_account_info\(\)$/, "");
      const ctxMatch = trimmed.match(/^ctx\.accounts\.(\w+)$/);
      if (ctxMatch?.[1]) return snakeCase(ctxMatch[1]);
      const localMatch = trimmed.match(/^(\w+)$/);
      if (localMatch?.[1]) return snakeCase(localMatch[1]);
      return trimmed;
    };
    const normalizeSignerSeedsExpr = (expr: string): string => {
      const trimmed = cleanInlineExpr(expr);
      if (trimmed.includes("[") || trimmed.includes("&")) return "signer_seeds";
      return trimmed;
    };
    const canonicalAccountName = (name: string): string => {
      const normalized = snakeCase(name);
      for (const [accountName, accountInfoVar] of accountInfoVars.entries()) {
        if (accountInfoVar === normalized) return accountName;
      }
      for (const [accountName, stateVar] of stateVars.entries()) {
        if (stateVar === normalized) return accountName;
      }
      return normalized;
    };
    const ensureSignerSeedsForAccount = (accountName: string): string[] => {
      const normalized = canonicalAccountName(accountName);
      if (accountsWithSignerSeeds.has(normalized)) return [];
      let accRef = instr.accounts.find((acc) => snakeCase(acc.name) === normalized);
      if (!accRef?.isPda) {
        const prefix = normalized
          .replace(/_authority$/, "")
          .replace(/_account$/, "")
          .replace(/_ata$/, "");
        accRef = instr.accounts.find((acc) => {
          const candidate = snakeCase(acc.name);
          return acc.isPda && (
            candidate === prefix ||
            candidate.includes(prefix) ||
            candidate.includes(`${prefix}_bump`) ||
            candidate.includes(`${prefix}_holder`)
          );
        });
      }
      if (!accRef?.isPda) return [];
      const canonical = snakeCase(accRef.name);
      if (accountsWithSignerSeeds.has(canonical)) {
        accountsWithSignerSeeds.add(normalized);
        return [];
      }
      accountsWithSignerSeeds.add(canonical);
      accountsWithSignerSeeds.add(normalized);
      return [emitCanonicalSignerSeeds(accRef)];
    };
    const ensureSignerSeedsForCode = (code: string): string[] => {
      const patterns = [
        /transfer_lamports_signed\((\w+),\s*\w+,\s*[^,]+,\s*signer_seeds\)/,
        /spl_token_transfer_signed\(\w+,\s*\w+,\s*(\w+),\s*[^,]+,\s*signer_seeds\)/,
        /spl_token_mint_to_signed\(\w+,\s*\w+,\s*(\w+),\s*[^,]+,\s*signer_seeds\)/,
        /spl_token_burn_signed\(\w+,\s*\w+,\s*(\w+),\s*[^,]+,\s*signer_seeds\)/,
        /spl_token_close_account_signed\(\w+,\s*\w+,\s*(\w+),\s*signer_seeds\)/,
      ];
      for (const pattern of patterns) {
        const match = code.match(pattern);
        if (match?.[1]) {
          return ensureSignerSeedsForAccount(match[1]);
        }
      }
      return [];
    };
    const transformAccountReferences = (code: string): string => {
      let transformed = code;
      for (const account of instr.accounts) {
        const accountName = snakeCase(account.name);
        const accountInfoVar = resolveAccountInfoVar(accountName);
        transformed = transformed.replace(
          new RegExp(`\\b${accountName}\\.key\\(\\)`, "g"),
          () => `${this.emitAccountKeyExpr(accountInfoVar)}`
        );
        transformed = transformed.replace(
          new RegExp(`\\b${accountName}\\.key\\b(?!\\s*\\(|\\.as_ref\\b)`, "g"),
          () => `${this.emitAccountKeyExpr(accountInfoVar)}`
        );
        transformed = transformed.replace(
          new RegExp(`\\b${resolveStateVar(accountName)}\\.key\\(\\)`, "g"),
          () => `${this.emitAccountKeyExpr(accountInfoVar)}`
        );
        transformed = transformed.replace(
          new RegExp(`\\b${resolveStateVar(accountName)}\\.key\\b(?!\\s*\\(|\\.as_ref\\b)`, "g"),
          () => `${this.emitAccountKeyExpr(accountInfoVar)}`
        );
        transformed = transformed.replace(
          new RegExp(`\\b${accountName}\\.lamports\\(\\)`, "g"),
          () => `${this.emitAccountLamportsExpr(accountInfoVar)}`
        );
        const tokenLike = account.accountType.includes("TokenAccount")
          || account.constraints.some((constraint) => constraint.kind.startsWith("token::") || constraint.kind.startsWith("associated_token::"));
        if (tokenLike) {
          transformed = transformed.replace(
            new RegExp(`(^|[^\\w.])${accountName}\\.amount\\b`, "g"),
            (_full, prefix: string) => `${prefix}token_account_amount(${accountInfoVar})?`
          );
        }
        if (!isGeneratedStateType(account.accountType)) continue;
        transformed = transformed.replace(
          new RegExp(`(^|[^\\w.])${accountName}\\.(\\w+)`, "g"),
          (full, prefix: string, field: string) => {
            if (field === "key" || field === "lamports") return full;
            const localVar = ensureStateRead(accountName);
            return `${prefix}${localVar}.${snakeCase(field)}`;
          }
        );
      }
      for (const account of instr.accounts) {
        const accountInfoVar = resolveAccountInfoVar(snakeCase(account.name));
        transformed = transformed.replace(
          new RegExp(`(^|[^\\w.*])${accountInfoVar}\\.key\\(\\)(?!\\.as_ref\\(\\))`, "g"),
          (_full, prefix: string) => `${prefix}${this.emitAccountKeyExpr(accountInfoVar)}`
        );
      }
      transformed = transformed.replace(/\*\*(\w+)\.key\(\)/g, "*$1.key()");
      transformed = transformed.replace(/\*\*(\w+)\.key\b/g, "$1.key");
      return transformed;
    };
    const normalizeKeyValueUsages = (code: string): string => {
      let transformed = code;
      for (const account of instr.accounts) {
        const accountName = snakeCase(account.name);
        const accountInfoVar = resolveAccountInfoVar(accountName);
        const keyExpr = this.emitAccountKeyExpr(accountInfoVar);
        transformed = transformed.replace(
          new RegExp(`([=,(]\\s*)${accountName}\\.key\\(\\)(?!\\.as_ref\\(\\))`, "g"),
          `$1${keyExpr}`
        );
        transformed = transformed.replace(
          new RegExp(`([=,(]\\s*)${accountName}\\.key\\b(?!\\s*\\(|\\.as_ref\\b)`, "g"),
          `$1${keyExpr}`
        );
        transformed = transformed.replace(
          new RegExp(`(^|\\s)${accountName}\\.key\\(\\)(?=\\s*(?:==|!=|\\)|,|;))`, "g"),
          (_full, prefix: string) => `${prefix}${keyExpr}`
        );
        transformed = transformed.replace(
          new RegExp(`(^|\\s)${accountName}\\.key\\b(?!\\s*\\(|\\.as_ref\\b)(?=\\s*(?:==|!=|\\)|,|;))`, "g"),
          (_full, prefix: string) => `${prefix}${keyExpr}`
        );
        transformed = transformed.replace(
          new RegExp(`([=,(]\\s*)${accountInfoVar}\\.key\\(\\)(?!\\.as_ref\\(\\))`, "g"),
          `$1${keyExpr}`
        );
        transformed = transformed.replace(
          new RegExp(`([=,(]\\s*)${accountInfoVar}\\.key\\b(?!\\s*\\(|\\.as_ref\\b)`, "g"),
          `$1${keyExpr}`
        );
        transformed = transformed.replace(
          new RegExp(`(^|\\s)${accountInfoVar}\\.key\\(\\)(?=\\s*(?:==|!=|\\)|,|;))`, "g"),
          (_full, prefix: string) => `${prefix}${keyExpr}`
        );
        transformed = transformed.replace(
          new RegExp(`(^|\\s)${accountInfoVar}\\.key\\b(?!\\s*\\(|\\.as_ref\\b)(?=\\s*(?:==|!=|\\)|,|;))`, "g"),
          (_full, prefix: string) => `${prefix}${keyExpr}`
        );
      }
      return transformed;
    };
    const transformNestedAnchorCode = (code: string): string => {
      let transformed = code;

      const replaceCpi = (
        pattern: RegExp,
        build: (...groups: string[]) => string,
      ): void => {
        transformed = transformed.replace(pattern, (...args) => {
          const groups = args.slice(1, -2) as string[];
          return build(...groups);
        });
      };

      replaceCpi(
        /(?:anchor_spl::)?token::transfer\(\s*CpiContext::new_with_signer\(\s*ctx\.accounts\.\w+\.to_account_info\(\),\s*(?:anchor_spl::token::)?Transfer\s*\{\s*from:\s*ctx\.accounts\.(\w+)\.to_account_info\(\),\s*to:\s*ctx\.accounts\.(\w+)\.to_account_info\(\),\s*authority:\s*ctx\.accounts\.(\w+)\.to_account_info\(\),\s*\},\s*([\w\[\]&\s.]+?)\s*,\s*\)\s*,\s*([\s\S]*?)\s*\)\?;/g,
        (from, to, authority, signerSeeds, amount) =>
          `spl_token_transfer_signed(${snakeCase(from)}, ${snakeCase(to)}, ${resolveAccountInfoVar(snakeCase(authority))}, ${this.transformAmountExpr(cleanInlineExpr(amount))}, ${normalizeSignerSeedsExpr(signerSeeds)})?;`
      );
      replaceCpi(
        /(?:anchor_spl::)?token::transfer\(\s*CpiContext::new\(\s*ctx\.accounts\.\w+\.to_account_info\(\),\s*(?:anchor_spl::token::)?Transfer\s*\{\s*from:\s*ctx\.accounts\.(\w+)\.to_account_info\(\),\s*to:\s*ctx\.accounts\.(\w+)\.to_account_info\(\),\s*authority:\s*ctx\.accounts\.(\w+)\.to_account_info\(\),\s*\}\s*,\s*\)\s*,\s*([\s\S]*?)\s*\)\?;/g,
        (from, to, authority, amount) =>
          `spl_token_transfer(${snakeCase(from)}, ${snakeCase(to)}, ${resolveAccountInfoVar(snakeCase(authority))}, ${this.transformAmountExpr(cleanInlineExpr(amount))})?;`
      );
      replaceCpi(
        /(?:anchor_spl::)?token::mint_to\(\s*CpiContext::new_with_signer\(\s*ctx\.accounts\.\w+\.to_account_info\(\),\s*(?:anchor_spl::token::)?MintTo\s*\{\s*mint:\s*ctx\.accounts\.(\w+)\.to_account_info\(\),\s*to:\s*ctx\.accounts\.(\w+)\.to_account_info\(\),\s*authority:\s*ctx\.accounts\.(\w+)\.to_account_info\(\),\s*\},\s*([\w\[\]&\s.]+?)\s*,\s*\)\s*,\s*([\s\S]*?)\s*\)\?;/g,
        (mint, to, authority, signerSeeds, amount) =>
          `spl_token_mint_to_signed(${snakeCase(mint)}, ${snakeCase(to)}, ${resolveAccountInfoVar(snakeCase(authority))}, ${this.transformAmountExpr(cleanInlineExpr(amount))}, ${normalizeSignerSeedsExpr(signerSeeds)})?;`
      );
      replaceCpi(
        /(?:anchor_spl::)?token::mint_to\(\s*CpiContext::new\(\s*ctx\.accounts\.\w+\.to_account_info\(\),\s*(?:anchor_spl::token::)?MintTo\s*\{\s*mint:\s*ctx\.accounts\.(\w+)\.to_account_info\(\),\s*to:\s*ctx\.accounts\.(\w+)\.to_account_info\(\),\s*authority:\s*ctx\.accounts\.(\w+)\.to_account_info\(\),\s*\}\s*,\s*\)\s*,\s*([\s\S]*?)\s*\)\?;/g,
        (mint, to, authority, amount) =>
          `spl_token_mint_to(${snakeCase(mint)}, ${snakeCase(to)}, ${resolveAccountInfoVar(snakeCase(authority))}, ${this.transformAmountExpr(cleanInlineExpr(amount))})?;`
      );
      replaceCpi(
        /(?:anchor_spl::)?token::burn\(\s*CpiContext::new_with_signer\(\s*ctx\.accounts\.\w+\.to_account_info\(\),\s*(?:anchor_spl::token::)?Burn\s*\{\s*mint:\s*ctx\.accounts\.(\w+)\.to_account_info\(\),\s*from:\s*ctx\.accounts\.(\w+)\.to_account_info\(\),\s*authority:\s*ctx\.accounts\.(\w+)\.to_account_info\(\),\s*\},\s*([\w\[\]&\s.]+?)\s*,\s*\)\s*,\s*([\s\S]*?)\s*\)\?;/g,
        (mint, from, authority, signerSeeds, amount) =>
          `spl_token_burn_signed(${snakeCase(from)}, ${snakeCase(mint)}, ${resolveAccountInfoVar(snakeCase(authority))}, ${this.transformAmountExpr(cleanInlineExpr(amount))}, ${normalizeSignerSeedsExpr(signerSeeds)})?;`
      );
      replaceCpi(
        /(?:anchor_spl::)?token::burn\(\s*CpiContext::new\(\s*ctx\.accounts\.\w+\.to_account_info\(\),\s*(?:anchor_spl::token::)?Burn\s*\{\s*mint:\s*ctx\.accounts\.(\w+)\.to_account_info\(\),\s*from:\s*ctx\.accounts\.(\w+)\.to_account_info\(\),\s*authority:\s*ctx\.accounts\.(\w+)\.to_account_info\(\),\s*\}\s*,\s*\)\s*,\s*([\s\S]*?)\s*\)\?;/g,
        (mint, from, authority, amount) =>
          `spl_token_burn(${snakeCase(from)}, ${snakeCase(mint)}, ${resolveAccountInfoVar(snakeCase(authority))}, ${this.transformAmountExpr(cleanInlineExpr(amount))})?;`
      );
      replaceCpi(
        /(?:anchor_spl::)?token::close_account\(\s*CpiContext::new_with_signer\(\s*ctx\.accounts\.\w+\.to_account_info\(\),\s*(?:anchor_spl::token::)?CloseAccount\s*\{\s*account:\s*ctx\.accounts\.(\w+)\.to_account_info\(\),\s*destination:\s*ctx\.accounts\.(\w+)\.to_account_info\(\),\s*authority:\s*ctx\.accounts\.(\w+)\.to_account_info\(\),\s*\},\s*([\w\[\]&\s.]+?)\s*,\s*\)\s*\)\?;/g,
        (account, destination, authority, signerSeeds) =>
          `spl_token_close_account_signed(${snakeCase(account)}, ${snakeCase(destination)}, ${resolveAccountInfoVar(snakeCase(authority))}, ${normalizeSignerSeedsExpr(signerSeeds)})?;`
      );
      replaceCpi(
        /(?:anchor_spl::)?token::close_account\(\s*CpiContext::new\(\s*ctx\.accounts\.\w+\.to_account_info\(\),\s*(?:anchor_spl::token::)?CloseAccount\s*\{\s*account:\s*ctx\.accounts\.(\w+)\.to_account_info\(\),\s*destination:\s*ctx\.accounts\.(\w+)\.to_account_info\(\),\s*authority:\s*ctx\.accounts\.(\w+)\.to_account_info\(\),\s*\}\s*,\s*\)\s*\)\?;/g,
        (account, destination, authority) =>
          `spl_token_close_account(${snakeCase(account)}, ${snakeCase(destination)}, ${resolveAccountInfoVar(snakeCase(authority))})?;`
      );
      replaceCpi(
        /(?:anchor_lang::)?system_program::transfer\(\s*CpiContext::new_with_signer\(\s*[\s\S]*?\.to_account_info\(\),\s*(?:anchor_lang::system_program::)?Transfer\s*\{\s*from:\s*([\w.]+)\.to_account_info\(\),\s*to:\s*([\w.]+)\.to_account_info\(\),\s*\},\s*([\w\[\]&\s.]+?)\s*,\s*\)\s*,\s*([\s\S]*?)\s*\)\?;/g,
        (from, to, signerSeeds, amount) =>
          `transfer_lamports_signed(${normalizeAccountExpr(from)}, ${normalizeAccountExpr(to)}, ${cleanInlineExpr(amount)}, ${normalizeSignerSeedsExpr(signerSeeds)})?;`
      );
      replaceCpi(
        /(?:anchor_lang::)?system_program::transfer\(\s*CpiContext::new\(\s*[\s\S]*?\.to_account_info\(\),\s*(?:anchor_lang::system_program::)?Transfer\s*\{\s*from:\s*([\w.]+)\.to_account_info\(\),\s*to:\s*([\w.]+)\.to_account_info\(\),\s*\}\s*,\s*\)\s*,\s*([\s\S]*?)\s*\)\?;/g,
        (from, to, amount) =>
          `transfer_lamports(${normalizeAccountExpr(from)}, ${normalizeAccountExpr(to)}, ${cleanInlineExpr(amount)})?;`
      );

      transformed = transformed.replace(
        /ctx\.accounts\.(\w+)\.is_some\(\)/g,
        (_full, name: string) => `${snakeCase(name)}.is_some()`
      );

      transformed = transformed.replace(
        /if\s+let\s+Some\((\w+)\)\s*=\s*&mut\s*ctx\.accounts\.(\w+)\s*\{([\s\S]*?)\n?\}/g,
        (_full, localVar: string, accountName: string, body: string) => {
          const normalizedAccount = snakeCase(accountName);
          const accountRef = instr.accounts.find((acc) => snakeCase(acc.name) === normalizedAccount);
          const typeName = accountRef?.accountType ?? "Unknown";
          if (!isGeneratedStateType(typeName)) {
            return `if let Some(${localVar}) = ${normalizedAccount} {\n${body}\n}`;
          }
          const accountInfoVar = `${localVar}_account`;
          const transformedBody = simplifyPassThroughCode(
            normalizeKeyValueUsages(
              transformAccountReferences(
                transformCtxAccountsReferences(transformNestedAnchorCode(body))
              )
            )
          );
          return `if let Some(${accountInfoVar}) = ${normalizedAccount} {\n        let mut ${localVar} = ${typeName}::from_account_info(${accountInfoVar})?;\n${indentBlock(transformedBody.trim(), "        ")}\n        ${typeName}::save(${accountInfoVar}, &${localVar})?;\n    }`;
        }
      );

      transformed = transformed.replace(
        /require!\(([\s\S]+?),\s*([\w:]+(?:::\w+)*)\s*\);/g,
        (_full, condition: string, error: string) =>
          emitRequireGuard(condition, error, "").replace(/\n/g, "\n        ")
      );
      transformed = transformed.replace(
        /emit!\(\s*(\w+)\s*\{\s*([\s\S]*?)\s*\}\s*\);/g,
        (_full, event: string, fields: string) => this.emitEmit(event, fields).replace(/^    /gm, "")
      );
      transformed = transformed.replace(
        /(^|[^\w:])msg!\(([\s\S]*?)\);/g,
        (_full, prefix: string, message: string) => `${prefix}${this.emitMsg(cleanInlineExpr(message)).replace(/^    /gm, "")}`
      );

      return simplifyPassThroughCode(transformed);
    };
    const transformCtxAccountsReferences = (code: string): string => {
      let transformed = code;
      transformed = transformed.replace(/ctx\.accounts\.(\w+)\.key\(\)/g, (_, name: string) => this.emitAccountKeyExpr(resolveAccountInfoVar(snakeCase(name))));
      transformed = transformed.replace(/ctx\.accounts\.(\w+)\.key\b/g, (_, name: string) => this.emitAccountKeyExpr(resolveAccountInfoVar(snakeCase(name))));
      transformed = transformed.replace(/ctx\.accounts\.(\w+)\.lamports\(\)/g, (_, name: string) => this.emitAccountLamportsExpr(resolveAccountInfoVar(snakeCase(name))));
      transformed = transformed.replace(/ctx\.accounts\.(\w+)\.amount\b/g, (_full, name: string) => `token_account_amount(${resolveAccountInfoVar(snakeCase(name))})?`);
      transformed = transformed.replace(/&mut\s*ctx\.accounts\.(\w+)/g, (_full, name: string) => `&mut ${snakeCase(name)}`);
      transformed = transformed.replace(/&\s*ctx\.accounts\.(\w+)/g, (_full, name: string) => `&${snakeCase(name)}`);
      transformed = transformed.replace(/\bctx\.accounts\.(\w+)\b/g, (_full, name: string) => snakeCase(name));
      transformed = transformed.replace(/ctx\.accounts\.(\w+)\.(\w+)/g, (full, name: string, field: string) => {
        if (field === "key" || field === "lamports") return full;
        const accountRef = instr.accounts.find((acc) => snakeCase(acc.name) === snakeCase(name));
        const typeName = accountRef?.accountType ?? "Unknown";
        if (!isGeneratedStateType(typeName)) {
          return full;
        }
        const localVar = ensureStateRead(name);
        return `${localVar}.${snakeCase(field)}`;
      });
      for (const account of instr.accounts) {
        const accountName = snakeCase(account.name);
        const accountInfoVar = resolveAccountInfoVar(accountName);
        transformed = transformed.replace(
          new RegExp(`(^|[^\\w.*])${accountName}\\.key\\(\\)(?!\\.as_ref\\(\\))`, "g"),
          (_full, prefix: string) => `${prefix}${this.emitAccountKeyExpr(accountInfoVar)}`
        );
        transformed = transformed.replace(
          new RegExp(`(^|[^\\w.*])${accountInfoVar}\\.key\\(\\)(?!\\.as_ref\\(\\))`, "g"),
          (_full, prefix: string) => `${prefix}${this.emitAccountKeyExpr(accountInfoVar)}`
        );
      }
      return transformed;
    };
    const helpers = ir.helperFns ?? [];
    const helperMutRefNames = new Set(
      helpers.flatMap((helper) => {
        const code = helper.rawCode ?? "";
        const fnName = helper.name;
        if (!fnName) return [];
        const match = code.match(
          new RegExp(`fn\\s+${fnName}\\s*\\(\\s*(\\w+)\\s*:\\s*&mut\\s*(?:Account<)?(\\w+)`)
        );
        if (!match?.[1] || !match?.[2]) return [];
        return isGeneratedStateType(match[2]) ? [fnName] : [];
      })
    );
    const transformHelperCalls = (code: string): string => {
      let transformed = code;
      for (const helperName of helperMutRefNames) {
        for (const accountName of stateAccountNames) {
          const stateVar = resolveStateVar(accountName);
          transformed = transformed.replace(
            new RegExp(`\\b${helperName}\\(\\s*${stateVar}(\\s*,)`, "g"),
            `${helperName}(&mut ${stateVar}$1`
          );
        }
      }
      return transformed;
    };
    const bodyRequireConditions = new Set(
      statements.flatMap((stmt) => {
        if (stmt.kind === "require") {
          return [normalizeConditionKey(normalizeKeyValueUsages(transformAccountReferences(transformCtxAccountsReferences(stmt.condition))))];
        }
        if (stmt.kind === "pass_through") {
          const raw = stmt.code.trim();
          const requireMatch = raw.match(/^require!\(([\s\S]+),\s*[\w:]+(?:::\w+)*\s*\);?$/);
          if (requireMatch?.[1]) {
            return [normalizeConditionKey(normalizeKeyValueUsages(transformAccountReferences(transformCtxAccountsReferences(requireMatch[1].trim()))))];
          }
          const guardMatch = raw.match(/^if\s+!\(([\s\S]+)\)\s*\{\s*return Err\([\s\S]+\);\s*\}$/);
          if (guardMatch?.[1]) {
            return [normalizeConditionKey(normalizeKeyValueUsages(transformAccountReferences(transformCtxAccountsReferences(guardMatch[1].trim()))))];
          }
        }
        return [];
      }).filter(Boolean)
    );
    const emitAccountConstraintChecks = (): void => {
      for (const account of instr.accounts) {
        for (const constraint of account.constraints) {
          if (!constraint.value) continue;
          let condition: string | null = null;
          if (constraint.kind === "constraint") {
            condition = transformAccountReferences(
              transformCtxAccountsReferences(stripAnchorConstraintError(constraint.value))
            );
          } else if (constraint.kind === "address") {
            condition = `${this.emitAccountKeyExpr(resolveAccountInfoVar(snakeCase(account.name)))} == ${transformAccountReferences(
              transformCtxAccountsReferences(stripAnchorConstraintError(constraint.value))
            )}`;
          }
          if (!condition) continue;
          condition = normalizeKeyValueUsages(condition);
          if (bodyRequireConditions.has(normalizeConditionKey(condition))) {
            continue;
          }
          lines.push(this.emitRequire(condition, "ProgramError::InvalidAccountData"));
        }
      }
    };
    const emitAutoCloseAccounts = (): void => {
      for (const account of instr.accounts) {
        const accountName = snakeCase(account.name);
        const closeConstraint = account.constraints.find(
          (constraint) => constraint.kind === "close" && constraint.value
        );
        if (!closeConstraint?.value) continue;

        for (const dependent of instr.accounts) {
          const dependentName = snakeCase(dependent.name);
          const tokenAuthority = dependent.constraints.find(
            (constraint) => constraint.kind === "token::authority" && constraint.value === account.name
          );
          if (!tokenAuthority) continue;

          const signerSeeds = account.isPda && accountsWithSignerSeeds.has(accountName)
            ? "signer_seeds"
            : undefined;
          lines.push(this.emitSplCloseAccount(
            resolveAccountInfoVar(dependentName),
            resolveAccountInfoVar(snakeCase(closeConstraint.value)),
            resolveAccountInfoVar(accountName),
            signerSeeds
          ));
        }

        lines.push(this.emitProgramAccountClose(
          resolveAccountInfoVar(accountName),
          resolveAccountInfoVar(snakeCase(closeConstraint.value))
        ));
      }
    };
    const emitPendingSaves = (): void => {
      for (const accName of mutatedAccounts) {
        const accRef = instr.accounts.find(a => snakeCase(a.name) === snakeCase(accName));
        const typeName = accRef?.accountType || "Unknown";
        if (accRef?.isOptional) continue;
        if (isGeneratedStateType(typeName)) {
          lines.push(this.emitStateSave(
            resolveAccountInfoVar(snakeCase(accName)),
            typeName,
            resolveStateVar(snakeCase(accName))
          ));
        }
      }
    };

    emitAccountConstraintChecks();

    for (const stmt of statements) {
      switch (stmt.kind) {
        // ── PASS-THROUGH ──
        case "pass_through": {
          this.passedThroughCount++;
          const rawCode = stmt.code.trim();

          // Skip pass_through Ok(()) — handled by instruction wrapper
          if (rawCode === "Ok(())") {
            emitAutoCloseAccounts();
            emitPendingSaves();
            lines.push(`    Ok(())`);
            break;
          }

          // Transform require!() macros that leaked through as pass_through
          const requireMatch = rawCode.match(/^require!\(([\s\S]+),\s*([\w:]+(?:::\w+)*)\s*\);?$/);
          if (requireMatch?.[1] && requireMatch[2]) {
            this.transformedCount++;
            const condition = normalizeKeyValueUsages(transformCtxAccountsReferences(requireMatch[1].trim()));
            lines.push(this.emitRequire(condition, requireMatch[2]));
            break;
          }

          const { prelude, code: bumpAdjustedRawCode } = replaceBumpRefs(rawCode);
          const transformedRawCode = simplifyPassThroughCode(
            transformHelperCalls(
              normalizeKeyValueUsages(
                transformAccountReferences(transformCtxAccountsReferences(transformNestedAnchorCode(bumpAdjustedRawCode)))
              )
            )
          );
          for (const preludeLine of prelude) {
            lines.push(preludeLine);
          }
          for (const signerSeedsPrelude of ensureSignerSeedsForCode(transformedRawCode)) {
            lines.push(signerSeedsPrelude);
          }

          // Don't add extra semicolons if the code already ends with one, with }, or with )
          let code: string;
          if (transformedRawCode.endsWith(";") || transformedRawCode.endsWith("}") || transformedRawCode.endsWith(");")) {
            code = `    ${transformedRawCode}`;
          } else {
            code = `    ${transformedRawCode};`;
          }
          if (stmt.needsReview && hasResidualAnchorPatterns(transformedRawCode)) {
            code = `    // ⚠️ Anvil: Review this section — ${stmt.reviewReason ?? "may need manual verification"}\n${code}`;
          }
          lines.push(code);
          break;
        }

        // ── TRANSFORM: state read ──
        case "state_read": {
          this.transformedCount++;
          this.details.push(`Transformed: ctx.accounts.${stmt.account} → framework state read`);
          // Skip program accounts (system_program, token_program, etc.)
          // They don't need from_account_info — they're just passed as AccountInfo
          if (isProgramAccount(stmt.accountType || "")) {
            break;
          }
          const accountName = snakeCase(stmt.account);
          const localVar = snakeCase(stmt.localVar);
          if (stateVars.has(accountName)) {
            break;
          }
          const accountRef = instr.accounts.find((acc) => snakeCase(acc.name) === accountName);
          if (accountRef?.isOptional) {
            stateVars.set(accountName, localVar);
            accountInfoVars.set(accountName, accountName);
            lines.push(`    let ${localVar} = ${accountName};`);
            break;
          }
          const needsAlias = accountName === localVar;
          const accountInfoVar = needsAlias ? `${accountName}_account` : accountName;
          if (needsAlias) {
            lines.push(`    let ${accountInfoVar} = ${accountName};`);
          }
          stateVars.set(accountName, localVar);
          accountInfoVars.set(accountName, accountInfoVar);
          lines.push(this.emitStateRead(
            accountInfoVar,
            stmt.accountType || "Unknown",
            localVar,
            stmt.mutable || mutableStateAccounts.has(accountName)
          ));
          const hasOneConstraints = accountRef?.constraints.filter(
            (constraint) => constraint.kind === "has_one" && constraint.value
          ) ?? [];
          for (const constraint of hasOneConstraints) {
            const targetAccount = snakeCase(constraint.value!);
            lines.push(`    if ${localVar}.${snakeCase(constraint.value!)} != ${this.emitAccountKeyExpr(resolveAccountInfoVar(targetAccount))} {`);
            lines.push(`        return Err(ProgramError::InvalidAccountData);`);
            lines.push(`    }`);
          }
          break;
        }

        // ── TRANSFORM: bumps access ──
        case "bumps_access": {
          this.transformedCount++;
          // In non-Anchor frameworks, bumps are computed at runtime
          lines.push(`    // Bump for ${stmt.account} — computed via PDA derivation at runtime`);
          break;
        }

        // ── TRANSFORM: state field assignment ──
        case "state_field_assign": {
          this.transformedCount++;
          mutatedAccounts.add(stmt.account);
          ensureStateRead(stmt.account, true);
          const stateAccountDef = ir.accounts.find((account) => snakeCase(account.name) === snakeCase(stmt.account));
          const fieldDef = stateAccountDef?.fields.find((field) => snakeCase(field.name) === snakeCase(stmt.field));
          // State field assignments are largely pass-through since they're just Rust
          // but we need to adapt ctx.accounts and ctx.bumps references
          let value = transformCtxAccountsReferences(stmt.value);
          value = normalizeKeyValueUsages(transformAccountReferences(value));
          if (fieldDef && (fieldDef.type === "Pubkey" || fieldDef.type === "[u8; 32]")) {
            value = value.replace(
              /^(\w+)\.key(?:\(\))?$/,
              (_full, name: string) => this.emitAccountKeyExpr(resolveAccountInfoVar(snakeCase(name)))
            );
          }
          value = transformHelperCalls(value);
          // Replace ctx.bumps.X with bump derivation call
          if (value.includes("ctx.bumps.")) {
            const bumpAccount = value.match(/ctx\.bumps\.(\w+)/)?.[1] ?? stmt.account;
            value = `bump_${snakeCase(bumpAccount)}`;
            lines.push(normalizedBumpLine(snakeCase(bumpAccount)));
          }
          lines.push(`    ${resolveStateVar(snakeCase(stmt.account))}.${snakeCase(stmt.field)} = ${value};`);
          break;
        }

        // ── TRANSFORM: require macro ──
        case "require": {
          this.transformedCount++;
          const condition = normalizeKeyValueUsages(transformAccountReferences(transformCtxAccountsReferences(stmt.condition)));
          lines.push(this.emitRequire(condition, stmt.error));
          break;
        }

        // ── TRANSFORM: msg macro ──
        case "msg": {
          this.transformedCount++;
          lines.push(this.emitMsg(stmt.message));
          break;
        }

        // ── TRANSFORM: emit macro ──
        case "emit": {
          this.transformedCount++;
          lines.push(this.emitEmit(stmt.event, stmt.fields));
          break;
        }

        // ── TRANSFORM: CPI system transfer ──
        case "cpi_system_transfer": {
          this.transformedCount++;
          this.details.push(`Transformed: system_program::transfer(${stmt.from} → ${stmt.to})`);
          if (stmt.signerSeeds) {
            for (const preludeLine of ensureSignerSeedsForAccount(stmt.from)) {
              lines.push(preludeLine);
            }
          }
          lines.push(this.emitSystemTransfer(
            snakeCase(stmt.from), snakeCase(stmt.to),
            this.transformAmountExpr(stmt.amount), stmt.signerSeeds
          ));
          break;
        }

        // ── TRANSFORM: CPI SPL transfer ──
        case "cpi_spl_transfer": {
          this.transformedCount++;
          this.details.push(`Transformed: token::transfer(${stmt.from} → ${stmt.to})`);
          if (stmt.signerSeeds) {
            for (const preludeLine of ensureSignerSeedsForAccount(stmt.authority)) {
              lines.push(preludeLine);
            }
          }
          const authority = stmt.signerSeeds
            ? resolveAccountInfoVar(snakeCase(stmt.authority))
            : snakeCase(stmt.authority);
          lines.push(this.emitSplTransfer(
            snakeCase(stmt.from), snakeCase(stmt.to),
            authority,
            this.transformAmountExpr(stmt.amount), stmt.signerSeeds
          ));
          break;
        }

        // ── TRANSFORM: CPI SPL mint_to ──
        case "cpi_spl_mint_to": {
          this.transformedCount++;
          if (stmt.signerSeeds) {
            for (const preludeLine of ensureSignerSeedsForAccount(stmt.authority)) {
              lines.push(preludeLine);
            }
          }
          const authority = stmt.signerSeeds
            ? resolveAccountInfoVar(snakeCase(stmt.authority))
            : snakeCase(stmt.authority);
          lines.push(this.emitSplMintTo(
            snakeCase(stmt.mint), snakeCase(stmt.to),
            authority,
            this.transformAmountExpr(stmt.amount), stmt.signerSeeds
          ));
          break;
        }

        // ── TRANSFORM: CPI SPL burn ──
        case "cpi_spl_burn": {
          this.transformedCount++;
          if (stmt.signerSeeds) {
            for (const preludeLine of ensureSignerSeedsForAccount(stmt.authority)) {
              lines.push(preludeLine);
            }
          }
          const authority = stmt.signerSeeds
            ? resolveAccountInfoVar(snakeCase(stmt.authority))
            : snakeCase(stmt.authority);
          lines.push(this.emitSplBurn(
            snakeCase(stmt.from), snakeCase(stmt.mint),
            authority,
            this.transformAmountExpr(stmt.amount), stmt.signerSeeds
          ));
          break;
        }

        // ── TRANSFORM: CPI SPL close_account ──
        case "cpi_spl_close_account": {
          this.transformedCount++;
          if (stmt.signerSeeds) {
            for (const preludeLine of ensureSignerSeedsForAccount(stmt.authority)) {
              lines.push(preludeLine);
            }
          }
          const authority = stmt.signerSeeds
            ? resolveAccountInfoVar(snakeCase(stmt.authority))
            : snakeCase(stmt.authority);
          lines.push(this.emitSplCloseAccount(
            snakeCase(stmt.account), snakeCase(stmt.destination),
            authority, stmt.signerSeeds
          ));
          break;
        }

        // ── TRANSFORM: Custom CPI ──
        case "cpi_custom": {
          this.transformedCount++;
          this.warnings.push(
            `Custom CPI to '${stmt.programAccount}' — passed through as raw code. Verify framework compatibility.`
          );
          lines.push(`    // ⚠️ Anvil: Custom CPI — verify this works with ${this.frameworkName}`);
          lines.push(`    ${stmt.rawCode}`);
          break;
        }

        // ── TRANSFORM: Clock sysvar ──
        case "sysvar_clock": {
          this.transformedCount++;
          lines.push(this.emitClockGet(stmt.localVar));
          break;
        }

        // ── TRANSFORM: Rent sysvar ──
        case "sysvar_rent": {
          this.transformedCount++;
          lines.push(this.emitRentGet(stmt.localVar));
          break;
        }

        // ── PDA signer seeds ──
        case "pda_signer_seeds": {
          this.transformedCount++;
          this.details.push(`Transformed: PDA signer seeds for '${stmt.account}'`);
          let accountName = snakeCase(stmt.account);
          let accRef = instr.accounts.find(a => snakeCase(a.name) === accountName);
          let seedStateAccount: string | undefined;
          const bumpPrelude: string[] = [];
          const seenBumps = new Set<string>();
          for (const seed of stmt.seeds) {
            const ctxBumpMatch = seed.match(/ctx\.bumps\.(\w+)/)?.[1];
            if (ctxBumpMatch) {
              const normalizedBump = snakeCase(ctxBumpMatch);
              if (!seenBumps.has(normalizedBump)) {
                seenBumps.add(normalizedBump);
                bumpPrelude.push(normalizedBumpLine(normalizedBump));
              }
              seedStateAccount = normalizedBump;
              continue;
            }
            const ctxDirectMatch = seed.match(/ctx\.accounts\.(\w+)\.\w+/)?.[1];
            if (ctxDirectMatch) {
              seedStateAccount = snakeCase(ctxDirectMatch);
              break;
            }
            const directMatch = seed.match(/^(\w+)\.\w+/)?.[1];
            if (directMatch && stateVars.has(directMatch)) {
              seedStateAccount = directMatch;
              break;
            }
            const bumpMatch = seed.match(/&\[(\w+)\.\w+/)?.[1];
            if (bumpMatch && stateVars.has(bumpMatch)) {
              seedStateAccount = bumpMatch;
              break;
            }
          }
          if (!accRef && seedStateAccount) {
            accountName = snakeCase(seedStateAccount);
            accRef = instr.accounts.find(a => snakeCase(a.name) === accountName);
          }
          for (const preludeLine of bumpPrelude) {
            lines.push(preludeLine);
          }
          const emittedSeeds = accRef?.isPda && bumpPrelude.length > 0
            ? [...accRef.pdaSeeds.map(normalizeSeedExpr), `&[bump_${accountName}]`]
            : stmt.seeds
                .map((seed) => seed.replace(/ctx\.bumps\.(\w+)/g, (_full, bumpName: string) => `bump_${snakeCase(bumpName)}`))
                .map(normalizeSeedExpr);
          const seedStateVar = seedStateAccount
            ? ensureStateRead(seedStateAccount)
            : stateVars.get(accountName);
          const seedStateType = seedStateAccount
            ? instr.accounts.find(a => snakeCase(a.name) === seedStateAccount)?.accountType
            : accRef?.accountType;
          lines.push(this.emitPdaSignerSeeds(
            accountName,
            resolveAccountInfoVar(accountName),
            emittedSeeds,
            stmt.bumpField,
            seedStateVar,
            seedStateType
          ));
          accountsWithSignerSeeds.add(accountName);
          break;
        }

        // ── Return Ok(()) ──
        case "return_ok": {
          emitAutoCloseAccounts();
          emitPendingSaves();
          lines.push(`    Ok(())`);
          break;
        }

        // ── Return Err ──
        case "return_err": {
          this.transformedCount++;
          lines.push(`    return Err(${stmt.error});`);
          break;
        }
      }
    }

    return lines.join("\n");
  }

  // ─── Arg parsing ───────────────────────────────────────────────────────────

  protected emitArgParsing(args: Arg[]): string {
    if (args.length === 0) {
      return `    if !data.is_empty() {
        return Err(ProgramError::InvalidInstructionData);
    }`;
    }

    let offset = 0;
    const lines = args.map((arg) => {
      const line = this.emitArgDeserialize(arg, offset);
      offset += this.resolveTypeSize(arg.type);
      return line;
    });
    return `    // Args\n${lines.join("\n")}`;
  }

  protected emitArgDeserialize(arg: Arg, offset: number): string {
    const start = offset;
    const end = offset + this.resolveTypeSize(arg.type);
    const name = snakeCase(arg.name);

    switch (arg.type) {
      case "u8":
        return `    if data.len() < ${end} {
        return Err(ProgramError::InvalidInstructionData);
    }
    let ${name}: u8 = data[${start}];`;
      case "u16": case "u32": case "u64": case "u128":
      case "i16": case "i32": case "i64": case "i128":
        return `    if data.len() < ${end} {
        return Err(ProgramError::InvalidInstructionData);
    }
    let ${name}: ${arg.type} = ${arg.type}::from_le_bytes(data[${start}..${end}].try_into().unwrap());`;
      case "i8":
        return `    if data.len() < ${end} {
        return Err(ProgramError::InvalidInstructionData);
    }
    let ${name}: i8 = data[${start}] as i8;`;
      case "bool":
        return `    if data.len() < ${end} {
        return Err(ProgramError::InvalidInstructionData);
    }
    let ${name}: bool = match data[${start}] {
        0 => false,
        1 => true,
        _ => return Err(ProgramError::InvalidInstructionData),
    };`;
      case "Pubkey":
        return `    if data.len() < ${end} {
        return Err(ProgramError::InvalidInstructionData);
    }
    let ${name} = ${this.emitPubkeyDeserialize(start, end)};`;
      default:
        if (/^\[\s*u8\s*;\s*\d+\s*\]$/.test(arg.type)) {
          return `    if data.len() < ${end} {
        return Err(ProgramError::InvalidInstructionData);
    }
    let ${name}: ${arg.type} = data[${start}..${end}].try_into().unwrap();`;
        }
        const typeDef = this.customTypeDef(arg.type);
        if (typeDef?.kind === "enum" && typeDef.variants?.length) {
          const arms = typeDef.variants
            .map((variant, index) => `        ${index} => ${arg.type}::${variant},`)
            .join("\n");
          return `    if data.len() < ${end} {
        return Err(ProgramError::InvalidInstructionData);
    }
    let ${name}: ${arg.type} = match data[${start}] {
${arms}
        _ => return Err(ProgramError::InvalidInstructionData),
    };`;
        }
        return `    // TODO: parse ${name}: ${arg.type}`;
    }
  }

  protected emitPubkeyDeserialize(start: number, end: number): string {
    return `data[${start}..${end}].try_into().unwrap()`;
  }

  protected customTypeDef(typeName: string) {
    return this.currentIr?.types.find((type) => type.name === typeName);
  }

  protected sourceErrorEnumName(ir: SolanaIR): string {
    const variantNames = new Set(ir.errors.map((error) => error.name));
    const prefixes = new Map<string, number>();
    const recordPrefixes = (text: string | undefined): void => {
      if (!text) return;
      for (const variant of variantNames) {
        const matches = [...text.matchAll(new RegExp(`\\b([A-Za-z_][A-Za-z0-9_]*)::${variant}\\b`, "g"))];
        for (const match of matches) {
          const prefix = match[1];
          if (!prefix) continue;
          prefixes.set(prefix, (prefixes.get(prefix) ?? 0) + 1);
        }
      }
    };

    for (const instr of ir.instructions) {
      recordPrefixes(instr.rawBody);
      for (const stmt of instr.body) {
        switch (stmt.kind) {
          case "require":
            recordPrefixes(stmt.error);
            break;
          case "return_err":
            recordPrefixes(stmt.error);
            break;
          case "pass_through":
            recordPrefixes(stmt.code);
            break;
        }
      }
    }

    const ranked = [...prefixes.entries()].sort((a, b) => b[1] - a[1]);
    return ranked[0]?.[0] ?? `${toPascalCase(ir.name)}Error`;
  }

  protected resolveTypeSize(typeName: string, visited = new Set<string>()): number {
    const fixedBytes = typeName.match(/^\[\s*u8\s*;\s*(\d+)\s*\]$/);
    if (fixedBytes?.[1]) {
      return Number.parseInt(fixedBytes[1], 10);
    }

    if (visited.has(typeName)) return 0;
    const typeDef = this.customTypeDef(typeName);
    if (!typeDef) {
      return typeSize(typeName);
    }

    if (typeDef.kind === "enum") return 1;
    if (!typeDef.fields) return typeSize(typeName);

    visited.add(typeName);
    const size = typeDef.fields.reduce((sum, field) => sum + this.resolveTypeSize(field.type, visited), 0);
    visited.delete(typeName);
    return size;
  }

  protected emitCustomTypes(ir: SolanaIR): string {
    return ir.types.map((typeDef) => {
      if (typeDef.rawCode && typeDef.kind === "enum" && /\w+\s*\([^)]*\)/.test(typeDef.rawCode)) {
        return typeDef.rawCode;
      }
      if (typeDef.kind === "enum") {
        const variants = (typeDef.variants ?? []).map((variant, index) => `    ${variant} = ${index},`).join("\n");
        const arms = (typeDef.variants ?? []).map((variant, index) => `            ${index} => Ok(Self::${variant}),`).join("\n");
        return `#[derive(Clone, Copy, Debug, PartialEq)]
#[repr(u8)]
pub enum ${typeDef.name} {
${variants}
}

impl TryFrom<u8> for ${typeDef.name} {
    type Error = ();

    fn try_from(value: u8) -> Result<Self, Self::Error> {
        match value {
${arms}
            _ => Err(()),
        }
    }
}`;
      }

      const fields = (typeDef.fields ?? [])
        .map((field) => `    pub ${snakeCase(field.name)}: ${this.rustTypeForFramework(field.type)},`)
        .join("\n");
      return `#[repr(C)]
pub struct ${typeDef.name} {
${fields}
}`;
    }).join("\n\n");
  }

  // ─── File header ───────────────────────────────────────────────────────────

  protected fileHeader(name: string): string {
    return `//! ${toPascalCase(name)} — generated by Anvil v0.2.0
//! Source framework: Anchor → Target: ${this.frameworkName}
//!
//! This code was automatically generated. Sections marked with
//! "⚠️ Anvil: Review" should be verified before deployment.
#![deny(clippy::all)]`;
  }

  protected transformHelperCode(code: string): string {
    let next = code;
    next = next.replace(/&mut\s+Account\s*<\s*(?:'?\w+\s*,\s*)?([\w:]+)\s*>/g, "&mut $1");
    next = next.replace(/&\s*Account\s*<\s*(?:'?\w+\s*,\s*)?([\w:]+)\s*>/g, "&$1");
    next = next.replace(/->\s*Result<\s*\(\s*\)\s*>/g, "-> ProgramResult");
    next = next.replace(/->\s*Result<\s*([^>]+)\s*>/g, "-> Result<$1, ProgramError>");
    return next;
  }
}

// ─── Shared utilities (exported for emitters and other modules) ──────────────

export function instrDiscriminator(name: string): string {
  return formatByteArray(discriminatorBytes(`global:${name}`));
}

export function accountDiscriminator(name: string): string {
  return formatByteArray(discriminatorBytes(`account:${name}`));
}

export function discriminatorBytes(namespace: string): number[] {
  return [...createHash("sha256").update(namespace).digest().subarray(0, 8)];
}

export function formatByteArray(bytes: number[]): string {
  return `[${bytes.join(", ")}]`;
}

export function isProgramAccount(accountType: string): boolean {
  return (
    accountType.includes("Program") ||
    accountType === "SystemProgram" ||
    accountType === "System" ||
    accountType === "TokenProgram" ||
    accountType === "Token" ||
    accountType === "AssociatedTokenProgram" ||
    accountType === "AssociatedToken"
  );
}

export function typeSize(typeName: string): number {
  const sizes: Record<string, number> = {
    u8: 1, u16: 2, u32: 4, u64: 8, u128: 16,
    i8: 1, i16: 2, i32: 4, i64: 8, i128: 16,
    bool: 1, Pubkey: 32, String: 64, "Vec<u8>": 4,
  };
  const fixedBytes = typeName.match(/^\[\s*u8\s*;\s*(\d+)\s*\]$/);
  if (fixedBytes?.[1]) {
    return Number.parseInt(fixedBytes[1], 10);
  }
  return sizes[typeName] ?? 32;
}

export function snakeCase(value: string): string {
  return value.replace(/([A-Z])/g, "_$1").toLowerCase().replace(/^_/, "");
}

export function toPascalCase(value: string): string {
  return value.replace(/(^|_)([a-z])/g, (_, __, char: string) => char.toUpperCase());
}

export function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function cleanInlineExpr(value: string): string {
  return value.replace(/\s+/g, " ").trim().replace(/,$/, "");
}

export function stripAnchorConstraintError(value: string): string {
  return value.replace(/\s*@\s*[\w:]+(?:::\w+)*/g, "").trim();
}

function indentBlock(value: string, indent: string): string {
  return value
    .split("\n")
    .map((line) => (line.trim() ? `${indent}${line}` : line))
    .join("\n");
}

function trimOuterParens(value: string): string {
  let current = value.trim();
  while (current.startsWith("(") && current.endsWith(")")) {
    let depth = 0;
    let balanced = true;
    for (let i = 0; i < current.length; i++) {
      const char = current[i];
      if (char === "(") depth++;
      if (char === ")") depth--;
      if (depth === 0 && i < current.length - 1) {
        balanced = false;
        break;
      }
    }
    if (!balanced) break;
    current = current.slice(1, -1).trim();
  }
  return current;
}

function unwrapTopLevelNegation(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed.startsWith("!") || trimmed.startsWith("!=")) return null;
  const rest = trimmed.slice(1).trim();
  return trimOuterParens(rest);
}

export function normalizeConditionKey(value: string): string {
  return trimOuterParens(stripAnchorConstraintError(cleanInlineExpr(value))).replace(/\s+/g, "");
}

export function emitRequireGuard(condition: string, error: string, indent = "    "): string {
  let expr = trimOuterParens(stripAnchorConstraintError(cleanInlineExpr(condition)));
  let isNegated = false;

  while (true) {
    const inner = unwrapTopLevelNegation(expr);
    if (!inner) break;
    isNegated = !isNegated;
    expr = inner;
  }

  if (isNegated) {
    return `${indent}if ${expr} {\n${indent}    return Err(${error}.into());\n${indent}}`;
  }

  if (/^[A-Za-z_][A-Za-z0-9_:.]*$/.test(expr)) {
    return `${indent}if !${expr} {\n${indent}    return Err(${error}.into());\n${indent}}`;
  }

  return `${indent}if !(${expr}) {\n${indent}    return Err(${error}.into());\n${indent}}`;
}

function simplifyPassThroughCode(value: string): string {
  let simplified = stripAnchorConstraintError(value);
  simplified = simplified.replace(/\bif\s+!\(!([A-Za-z0-9_:.]+)\)/g, "if $1");
  simplified = simplified.replace(/!\(([A-Za-z_][A-Za-z0-9_:.]*)\)/g, "!$1");
  return simplified;
}

function hasResidualAnchorPatterns(value: string): boolean {
  return /ctx\.(accounts|bumps)\./.test(value) ||
    /CpiContext::/.test(value) ||
    /anchor_spl::/.test(value) ||
    /\btoken::(?:transfer|mint_to|burn|close_account)\(/.test(value) ||
    /\bemit!\(/.test(value) ||
    /\brequire!\(/.test(value);
}

/**
 * Determine what helper functions an IR needs based on its body statements.
 */
export function irNeedsHelper(ir: SolanaIR, helperName: string): boolean {
  for (const instr of ir.instructions) {
    if (helperName === "close_program_account") {
      if (instr.accounts.some((account) =>
        account.constraints.some((constraint) => constraint.kind === "close" && constraint.value)
      )) {
        return true;
      }
    }

    if (helperName === "spl_close_account") {
      for (const account of instr.accounts) {
        const hasCloseConstraint = account.constraints.some(
          (constraint) => constraint.kind === "close" && constraint.value
        );
        if (!hasCloseConstraint) continue;

        const closesDependentTokenAccount = instr.accounts.some((dependent) =>
          dependent.constraints.some(
            (constraint) => constraint.kind === "token::authority" && constraint.value === account.name
          )
        );
        if (closesDependentTokenAccount) {
          return true;
        }
      }
    }

    for (const stmt of instr.body) {
      if (stmt.kind === "pass_through") {
        const code = stmt.code;
        switch (helperName) {
          case "transfer_lamports":
            if (/anchor_lang::system_program::transfer\(/.test(code)) return true;
            break;
          case "spl_transfer":
            if (/token::transfer\(/.test(code)) return true;
            break;
          case "spl_mint_to":
            if (/token::mint_to\(/.test(code)) return true;
            break;
          case "spl_burn":
            if (/token::burn\(/.test(code)) return true;
            break;
          case "spl_close_account":
            if (/token::close_account\(/.test(code)) return true;
            break;
        }
      }
      switch (helperName) {
        case "transfer_lamports":
          if (stmt.kind === "cpi_system_transfer") return true;
          break;
        case "spl_transfer":
          if (stmt.kind === "cpi_spl_transfer") return true;
          break;
        case "spl_mint_to":
          if (stmt.kind === "cpi_spl_mint_to") return true;
          break;
        case "spl_burn":
          if (stmt.kind === "cpi_spl_burn") return true;
          break;
        case "spl_close_account":
          if (stmt.kind === "cpi_spl_close_account") return true;
          break;
      }
    }
  }
  return false;
}

export function irNeedsUnsignedLamportsHelper(ir: SolanaIR): boolean {
  return ir.instructions.some((instr) =>
    instr.body.some((stmt) =>
      (stmt.kind === "cpi_system_transfer" && !stmt.signerSeeds) ||
      (stmt.kind === "pass_through" && /anchor_lang::system_program::transfer\(\s*CpiContext::new\(/.test(stmt.code))
    )
  );
}

export function irNeedsSignedLamportsHelper(ir: SolanaIR): boolean {
  return ir.instructions.some((instr) =>
    instr.body.some((stmt) =>
      (stmt.kind === "cpi_system_transfer" && !!stmt.signerSeeds) ||
      (stmt.kind === "pass_through" && /anchor_lang::system_program::transfer\(\s*CpiContext::new_with_signer\(/.test(stmt.code))
    )
  );
}

export function irNeedsTokenAmountHelper(ir: SolanaIR): boolean {
  return ir.instructions.some((instr) =>
    instr.body.some((stmt) => {
      switch (stmt.kind) {
        case "cpi_spl_transfer":
        case "cpi_spl_mint_to":
        case "cpi_spl_burn":
          return /\.amount$/.test(stmt.amount);
        case "pass_through":
          if (/token::(?:transfer|mint_to|burn)\(/.test(stmt.code) && /\.amount\b/.test(stmt.code)) {
            return true;
          }
          return instr.accounts.some((account) => {
            const accountName = snakeCase(account.name);
            const tokenLike = account.accountType.includes("TokenAccount")
              || account.constraints.some((constraint) => constraint.kind.startsWith("token::") || constraint.kind.startsWith("associated_token::"));
            return tokenLike && new RegExp(`\\b${accountName}\\.amount\\b`).test(stmt.code);
          });
        default:
          return false;
      }
    })
  );
}

export function irNeedsUnsignedSplMintToHelper(ir: SolanaIR): boolean {
  return ir.instructions.some((instr) =>
    instr.body.some((stmt) =>
      (stmt.kind === "cpi_spl_mint_to" && !stmt.signerSeeds) ||
      (stmt.kind === "pass_through" && /token::mint_to\(\s*CpiContext::new\(/.test(stmt.code))
    )
  );
}

export function irNeedsSignedSplMintToHelper(ir: SolanaIR): boolean {
  return ir.instructions.some((instr) =>
    instr.body.some((stmt) =>
      (stmt.kind === "cpi_spl_mint_to" && !!stmt.signerSeeds) ||
      (stmt.kind === "pass_through" && /token::mint_to\(\s*CpiContext::new_with_signer\(/.test(stmt.code))
    )
  );
}

export function irNeedsUnsignedSplBurnHelper(ir: SolanaIR): boolean {
  return ir.instructions.some((instr) =>
    instr.body.some((stmt) =>
      (stmt.kind === "cpi_spl_burn" && !stmt.signerSeeds) ||
      (stmt.kind === "pass_through" && /token::burn\(\s*CpiContext::new\(/.test(stmt.code))
    )
  );
}

export function irNeedsSignedSplBurnHelper(ir: SolanaIR): boolean {
  return ir.instructions.some((instr) =>
    instr.body.some((stmt) =>
      (stmt.kind === "cpi_spl_burn" && !!stmt.signerSeeds) ||
      (stmt.kind === "pass_through" && /token::burn\(\s*CpiContext::new_with_signer\(/.test(stmt.code))
    )
  );
}

export function irNeedsSignedSplCloseAccountHelper(ir: SolanaIR): boolean {
  for (const instr of ir.instructions) {
    for (const stmt of instr.body) {
      if (stmt.kind === "cpi_spl_close_account" && stmt.signerSeeds) {
        return true;
      }
    }

    for (const account of instr.accounts) {
      const hasCloseConstraint = account.constraints.some(
        (constraint) => constraint.kind === "close" && constraint.value
      );
      if (!hasCloseConstraint || !account.isPda) continue;
      const closesDependentTokenAccount = instr.accounts.some((dependent) =>
        dependent.constraints.some(
          (constraint) => constraint.kind === "token::authority" && constraint.value === account.name
        )
      );
      if (closesDependentTokenAccount) {
        return true;
      }
    }
  }
  return false;
}

export function irNeedsUnsignedSplCloseAccountHelper(ir: SolanaIR): boolean {
  for (const instr of ir.instructions) {
    for (const stmt of instr.body) {
      if (stmt.kind === "cpi_spl_close_account" && !stmt.signerSeeds) {
        return true;
      }
    }

    for (const account of instr.accounts) {
      const hasCloseConstraint = account.constraints.some(
        (constraint) => constraint.kind === "close" && constraint.value
      );
      if (!hasCloseConstraint || account.isPda) continue;
      const closesDependentTokenAccount = instr.accounts.some((dependent) =>
        dependent.constraints.some(
          (constraint) => constraint.kind === "token::authority" && constraint.value === account.name
        )
      );
      if (closesDependentTokenAccount) {
        return true;
      }
    }
  }
  return false;
}

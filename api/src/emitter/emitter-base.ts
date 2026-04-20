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
  abstract emitCreateProgramAccount(
    account: string,
    payer: string,
    spaceExpr: string,
    signerSeeds?: string,
  ): string;

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

  protected filteredSourceImports(ir: SolanaIR): string[] {
    return (ir.imports ?? [])
      .map((statement) => {
        const trimmed = statement.trim().replace(/;$/, "");
        return trimmed.startsWith("use ") || trimmed.startsWith("pub use ")
          ? `${trimmed};`
          : `use ${trimmed};`;
      })
      .filter((statement) => {
        if (statement.startsWith("use anchor_lang::")) return false;
        if (statement.startsWith("use anchor_spl::")) return false;
        if (statement.startsWith("use crate::")) return false;
        if (statement.startsWith("use self::")) return false;
        if (statement.startsWith("use super::")) return false;
        if (statement.startsWith("use instructions::")) return false;
        if (statement.startsWith("use state::")) return false;
        if (statement.startsWith("use error::")) return false;
        if (statement.startsWith("use errors::")) return false;
        if (statement.startsWith("use hash::")) return false;
        if (statement.startsWith("pub use ")) return false;
        return true;
      });
  }

  protected rustTypeForCustomType(typeName: string): string {
    if (typeName === "String" || typeName === "Vec<u8>") return typeName;
    return this.rustTypeForFramework(typeName);
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

    const hasHelperModule = this.hasHelperModule(ir);

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
    if (hasHelperModule && helpersContent.trim()) {
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
    const hasHelperModule = this.hasHelperModule(ir);
    sections.push(this.fileHeader(ir.name));
    sections.push(this.emitUseStatements(ir));
    if (constants.length > 0) sections.push(constants.join("\n\n"));
    if (types.length > 0) sections.push(this.emitCustomTypes({ ...ir, types }));

    if (ir.accounts.length > 0) sections.push("mod state;");
    if (ir.instructions.length > 0) sections.push("mod instructions;");
    if (ir.errors.length > 0) sections.push("mod errors;");
    if (hasHelperModule) sections.push("mod helpers;");
    if (ir.instructions.length > 0) {
      sections.push("use instructions::*;");
    }

    sections.push(this.emitEntrypoint(ir));
    sections.push(this.emitRouter(ir));

    return sections.join("\n\n");
  }

  private emitStateFile(ir: SolanaIR): string {
    const sections: string[] = [];
    sections.push(`//! State account definitions for ${toPascalCase(ir.name)}`);
    sections.push(`//! Generated by Anvil v0.2.0 — Target: ${this.frameworkName}\n`);
    sections.push(`use super::*;`);

    for (const acc of ir.accounts) {
      sections.push(this.emitAccountStruct(acc));
    }
    return sections.join("\n\n");
  }

  private emitInstructionsModFile(ir: SolanaIR): string {
    const mods = ir.instructions
      .map((i) => {
        const name = snakeCase(i.name);
        return `pub mod ${name};\npub use ${name}::${name};`;
      })
      .join("\n");
    const preludes = [
      `use crate::*;`,
      ir.accounts.length > 0 ? `use crate::state::*;` : "",
      ir.errors.length > 0 ? `use crate::errors::*;` : "",
      this.hasHelperModule(ir) ? `use crate::helpers::*;` : "",
    ].filter(Boolean).join("\n");
    return `//! Instruction processors for ${toPascalCase(ir.name)}\n\n${preludes}\n\n${mods}\n`;
  }

  private emitInstructionFile(instr: Instruction, ir: SolanaIR): string {
    return `use super::*;\n\n${this.emitInstructionFunction(instr, ir)}`;
  }

  private emitErrorsFile(ir: SolanaIR): string {
    return `//! Error definitions for ${toPascalCase(ir.name)}\n\nuse super::*;\n\n` + this.emitErrorEnum(ir);
  }

  private emitHelpersFile(ir: SolanaIR): string {
    const sections: string[] = [];
    sections.push(`use super::*;`);

    // Framework-specific helpers (transfer_lamports, etc.)
    const frameworkHelpers = this.emitHelperFunctions(ir);
    if (frameworkHelpers.trim()) sections.push(frameworkHelpers);

    // Carry over helper functions from source
    for (const helper of ir.helperFns) {
      sections.push(this.carriedFunctionBlock(helper.rawCode));
    }

    if (sections.length === 1) return "";
    return `//! Helper functions for ${toPascalCase(ir.name)}\n\n` + sections.join("\n\n");
  }

  protected hasHelperModule(ir: SolanaIR): boolean {
    return Boolean(this.emitHelperFunctions(ir).trim()) || (ir.helperFns?.length ?? 0) > 0;
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
      sections.push(this.carriedFunctionBlock(helper.rawCode));
    }

    if (ir.errors.length > 0) {
      sections.push(this.emitErrorEnum(ir));
    }

    return sections.join("\n\n");
  }

  // ─── Generic instruction function emitter ──────────────────────────────────

  protected emitInstructionFunction(instr: Instruction, ir: SolanaIR): string {
    const requiredAccountCount = instr.accounts.filter((a) => !a.isOptional).length;

    // Account bindings
    const bindings = instr.accounts
      .map((acc, idx) => acc.isOptional
        ? `    let ${snakeCase(acc.name)} = accounts.get(${idx});`
        : this.emitAccountBinding(snakeCase(acc.name), idx))
      .join("\n");

    // Signer checks
    const signerChecks = instr.accounts
      .filter((a) => a.isSigner && !a.isOptional)
      .map((a) => this.emitSignerCheck(snakeCase(a.name)))
      .join("\n");

    // Writable checks — ensure all mutable non-program accounts are actually writable.
    // Missing this allows attackers to pass read-only accounts where writes are expected.
    const isCustomState = (accountType: string) =>
      ir.accounts.some((a) => a.name === accountType);

    const writableAccountNames = instr.accounts
      .filter((a) => a.isMut && !a.isOptional && !isProgramAccount(a.accountType))
      .map((a) => snakeCase(a.name));
    const writableCheck = writableAccountNames.length > 0
      ? this.emitWritableCheck(writableAccountNames)
      : "";

    // Owner checks — only for accounts whose type is a custom state struct
    // (i.e., in ir.accounts). Token/System/Sysvar accounts are excluded:
    // they are owned by their respective programs, not this one.
    const ownerChecks = instr.accounts
      .filter((a) => !a.isOptional && !a.isInit && a.isMut && isCustomState(a.accountType))
      .map((a) => this.emitOwnerCheck(snakeCase(a.name)))
      .join("\n");

    // Arg parsing
    const argsBlock = this.emitArgParsing(instr.args);

    const initPreludes = instr.accounts
      .filter((a) => a.isInit && isCustomState(a.accountType))
      .map((a) => this.emitInitAccountPrelude(a, instr, ir))
      .filter(Boolean)
      .join("\n");

    // Body emission — the main event
    const bodyCode = this.emitBodyStatements(instr.body, instr, ir);

    // Check if body already ends with Ok(()) — no `return_ok` in body means we add one
    const bodyHasReturnOk = instr.body.some(s => s.kind === "return_ok");
    const bodyHasOkPassThrough = instr.body.some(
      s => s.kind === "pass_through" && s.code.trim() === "Ok(())"
    );
    const needsOkReturn = !bodyHasReturnOk && !bodyHasOkPassThrough;

    const preChecks = [signerChecks, writableCheck, ownerChecks].filter(Boolean).join("\n");

    return `fn ${snakeCase(instr.name)}(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    data: &[u8],
) -> ProgramResult {
    if accounts.len() < ${requiredAccountCount} {
        return Err(ProgramError::NotEnoughAccountKeys);
    }

${bindings}
${preChecks ? `\n${preChecks}\n` : ""}
${argsBlock}
${initPreludes ? `\n${initPreludes}\n` : ""}

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
    const emittedBumps = new Set<string>();
    let signerSeedsInScope = false;
    const qualifiedClockGetExpr = (): string =>
      this.emitClockGet("__anvil_clock").trim().replace(/^let\s+__anvil_clock\s*=\s*/, "").replace(/;$/, "");
    const qualifiedRentGetExpr = (): string =>
      this.emitRentGet("__anvil_rent").trim().replace(/^let\s+__anvil_rent\s*=\s*/, "").replace(/;$/, "");
    const qualifiedClockGetValueExpr = (): string => qualifiedClockGetExpr().replace(/\?$/, "");
    const qualifiedRentGetValueExpr = (): string => qualifiedRentGetExpr().replace(/\?$/, "");

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

      if (accountRef?.isInit) {
        // Account is being initialized — it has no on-chain data yet.
        // Calling from_account_info on an unallocated account would fail the
        // discriminator check. Emit a zero-initialized struct instead; the
        // instruction body will populate fields before saving.
        lines.push(this.emitStateInit(typeName, localVar));
      } else {
        lines.push(this.emitStateRead(
          accountInfoVar,
          typeName,
          localVar,
          mutable || mutableStateAccounts.has(normalized)
        ));
      }

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
        if (!isGeneratedStateType(account.accountType)) continue;
        normalized = normalized.replace(
          new RegExp(`\\b${accountName}\\.(\\w+)`, "g"),
          (full, field: string) => {
            if (field === "key" || field === "lamports") return full;
            const localVar = ensureStateRead(accountName);
            return `${localVar}.${snakeCase(field)}`;
          }
        );
      }
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
      const normalizedAccount = snakeCase(accountName);
      if (emittedBumps.has(normalizedAccount)) {
        return "";
      }
      emittedBumps.add(normalizedAccount);
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
      if (trimmed === "signer_seeds") return "signer_seeds";
      if (/\bseeds\b/.test(trimmed) && (trimmed.includes("[") || trimmed.includes("&"))) {
        return trimmed;
      }
      if (trimmed.includes("[") || trimmed.includes("&")) return "signer_seeds";
      return trimmed;
    };
    const normalizeToAccountInfoCalls = (code: string): string => {
      let transformed = code;
      transformed = transformed.replace(/&\s*(\w+)\.to_account_info\(\)/g, (_full, name: string) =>
        resolveAccountInfoVar(canonicalAccountName(name))
      );
      transformed = transformed.replace(/\b(\w+)\.to_account_info\(\)/g, (_full, name: string) =>
        `${resolveAccountInfoVar(canonicalAccountName(name))}.clone()`
      );
      return transformed;
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
      replaceCpi(
        /let\s+cpi_accounts\s*=\s*MintTo\s*\{\s*mint:\s*([\w.]+)\.to_account_info\(\),\s*to:\s*([\w.]+)\.to_account_info\(\),\s*authority:\s*([\w.]+)\.to_account_info\(\),\s*\};\s*let\s+ctx\s*=\s*CpiContext::new_with_signer\(\s*[\w.]+\.to_account_info\(\),\s*cpi_accounts,\s*([\w\[\]&\s.]+?)\s*,\s*\);\s*mint_to\(ctx,\s*([\s\S]*?)\)\?;\s*Ok\(\(\)\)/g,
        (mint, to, authority, signerSeeds, amount) =>
          `spl_token_mint_to_signed(${normalizeAccountExpr(mint)}, ${normalizeAccountExpr(to)}, ${normalizeAccountExpr(authority)}, ${this.transformAmountExpr(cleanInlineExpr(amount))}, ${normalizeSignerSeedsExpr(signerSeeds)})?;`
      );
      replaceCpi(
        /let\s+cpi_accounts\s*=\s*MintTo\s*\{\s*mint:\s*([\w.]+)\.to_account_info\(\),\s*to:\s*([\w.]+)\.to_account_info\(\),\s*authority:\s*([\w.]+)\.to_account_info\(\),\s*\};\s*let\s+ctx\s*=\s*CpiContext::new\(\s*[\w.]+\.to_account_info\(\),\s*cpi_accounts\s*\);\s*mint_to\(ctx,\s*([\s\S]*?)\)\?;\s*Ok\(\(\)\)/g,
        (mint, to, authority, amount) =>
          `spl_token_mint_to(${normalizeAccountExpr(mint)}, ${normalizeAccountExpr(to)}, ${normalizeAccountExpr(authority)}, ${this.transformAmountExpr(cleanInlineExpr(amount))})?;`
      );
      replaceCpi(
        /let\s+cpi_accounts\s*=\s*Burn\s*\{\s*mint:\s*([\w.]+)\.to_account_info\(\),\s*from:\s*([\w.]+)\.to_account_info\(\),\s*authority:\s*([\w.]+)\.to_account_info\(\),\s*\};\s*let\s+ctx\s*=\s*CpiContext::new_with_signer\(\s*[\w.]+\.to_account_info\(\),\s*cpi_accounts,\s*([\w\[\]&\s.]+?)\s*,\s*\);\s*burn\(ctx,\s*([\s\S]*?)\)\?;\s*Ok\(\(\)\)/g,
        (mint, from, authority, signerSeeds, amount) =>
          `spl_token_burn_signed(${normalizeAccountExpr(from)}, ${normalizeAccountExpr(mint)}, ${normalizeAccountExpr(authority)}, ${this.transformAmountExpr(cleanInlineExpr(amount))}, ${normalizeSignerSeedsExpr(signerSeeds)})?;`
      );
      replaceCpi(
        /let\s+cpi_accounts\s*=\s*Burn\s*\{\s*mint:\s*([\w.]+)\.to_account_info\(\),\s*from:\s*([\w.]+)\.to_account_info\(\),\s*authority:\s*([\w.]+)\.to_account_info\(\),\s*\};\s*let\s+ctx\s*=\s*CpiContext::new\(\s*[\w.]+\.to_account_info\(\),\s*cpi_accounts\s*\);\s*burn\(ctx,\s*([\s\S]*?)\)\?;\s*Ok\(\(\)\)/g,
        (mint, from, authority, amount) =>
          `spl_token_burn(${normalizeAccountExpr(from)}, ${normalizeAccountExpr(mint)}, ${normalizeAccountExpr(authority)}, ${this.transformAmountExpr(cleanInlineExpr(amount))})?;`
      );
      replaceCpi(
        /let\s+ix\s*=\s*anchor_lang::solana_program::system_instruction::transfer\(\s*&([\w.]+)\.key\(\),\s*&([\w.]+)\.key\(\),\s*([\s\S]*?)\s*,\s*\);\s*anchor_lang::solana_program::program::invoke_signed\(\s*&ix,\s*&\[[\s\S]*?\],\s*(signer_seeds)\s*,\s*\)\?;/g,
        (from, to, amount, signerSeeds) =>
          `transfer_lamports_signed(${normalizeAccountExpr(from)}, ${normalizeAccountExpr(to)}, ${cleanInlineExpr(amount)}, ${normalizeSignerSeedsExpr(signerSeeds)})?;`
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
    for (const account of instr.accounts.filter((acc) => acc.isPda && !acc.isInit && !acc.isOptional)) {
      const bumpLine = normalizedBumpLine(snakeCase(account.name));
      if (bumpLine) {
        lines.push(bumpLine);
      }
    }
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
          let transformedRawCode = simplifyPassThroughCode(
            transformHelperCalls(
              normalizeKeyValueUsages(
                transformAccountReferences(transformCtxAccountsReferences(transformNestedAnchorCode(bumpAdjustedRawCode)))
              )
            )
          );
          transformedRawCode = normalizeToAccountInfoCalls(transformedRawCode);
          transformedRawCode = transformedRawCode
            .replace(/(?<!:)\bClock::get\(\)\?/g, qualifiedClockGetExpr())
            .replace(/(?<!:)\bRent::get\(\)\?/g, qualifiedRentGetExpr())
            .replace(/(?<!:)\bClock::get\(\)/g, qualifiedClockGetValueExpr())
            .replace(/(?<!:)\bRent::get\(\)/g, qualifiedRentGetValueExpr());
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

          if (accountRef?.isInit) {
            // Account is being initialized — it has no on-chain data yet.
            // from_account_info would fail the discriminator check on an
            // unallocated account. Use emitStateInit() to produce a
            // zero-initialized struct that the body will populate before saving.
            lines.push(this.emitStateInit(stmt.accountType || "Unknown", localVar));
          } else {
            lines.push(this.emitStateRead(
              accountInfoVar,
              stmt.accountType || "Unknown",
              localVar,
              stmt.mutable || mutableStateAccounts.has(accountName)
            ));
          }

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
          const stateAccountName = canonicalAccountName(stmt.account);
          mutatedAccounts.add(stateAccountName);
          ensureStateRead(stateAccountName, true);
          const stateAccountDef = ir.accounts.find((account) => snakeCase(account.name) === stateAccountName);
          const fieldDef = stateAccountDef?.fields.find((field) => snakeCase(field.name) === snakeCase(stmt.field));
          const stateVarName = resolveStateVar(stateAccountName);
          const fieldName = snakeCase(stmt.field);

          // ── Checked arithmetic for compound assignments on numeric types ──
          // Detect __compound_+= and __compound_-= prefixes injected by the classifier
          // for += / -= statements on state fields. Use checked_add/checked_sub to
          // prevent silent u64/u128 overflow in release mode (DeFi exploit vector).
          const compoundMatch = stmt.value.match(/^__compound_([+\-*\/])=__(.+)$/);
          if (compoundMatch?.[1] && compoundMatch[2] && fieldDef) {
            const op = compoundMatch[1];
            let rhs = transformCtxAccountsReferences(compoundMatch[2]);
            rhs = normalizeKeyValueUsages(transformAccountReferences(rhs));
            rhs = transformHelperCalls(rhs);
            if (isCheckedArithmeticType(fieldDef.type)) {
              const checkedMethod = op === "+" ? "checked_add" : op === "-" ? "checked_sub" : op === "*" ? "checked_mul" : "checked_div";
              lines.push(`    ${stateVarName}.${fieldName} = ${stateVarName}.${fieldName}.${checkedMethod}(${rhs}).ok_or(ProgramError::ArithmeticOverflow)?;`);
            } else {
              lines.push(`    ${stateVarName}.${fieldName} = ${stateVarName}.${fieldName} ${op} ${rhs};`);
            }
            break;
          }

          // State field assignments are largely pass-through since they're just Rust
          // but we need to adapt ctx.accounts and ctx.bumps references
          let value = transformCtxAccountsReferences(stmt.value);
          value = normalizeKeyValueUsages(transformAccountReferences(value));
          if (fieldDef && (fieldDef.type === "Pubkey" || fieldDef.type === "[u8; 32]")) {
            const directCtxKeySource = stmt.value.match(/^ctx\.accounts\.(\w+)\.key\(\)$/)?.[1];
            const trimmedValue = cleanInlineExpr(value);
            const keySource = directCtxKeySource ?? trimmedValue.match(/^(\w+)\.key(?:\(\))?$/)?.[1];
            if (keySource) {
              value = this.emitAccountKeyExpr(resolveAccountInfoVar(snakeCase(keySource)));
            } else {
              value = value.replace(
                /\b(\w+)\.key\(\)/g,
                (_full, name: string) => this.emitAccountKeyExpr(resolveAccountInfoVar(snakeCase(name)))
              );
              value = value.replace(
                /\b(\w+)\.key\b(?!\s*\(|\.as_ref\b)/g,
                (_full, name: string) => this.emitAccountKeyExpr(resolveAccountInfoVar(snakeCase(name)))
              );
            }
          }
          value = transformHelperCalls(value);
          // Replace ctx.bumps.X with bump derivation call
          if (value.includes("ctx.bumps.")) {
            const bumpAccount = value.match(/ctx\.bumps\.(\w+)/)?.[1] ?? stmt.account;
            value = `bump_${snakeCase(bumpAccount)}`;
            const bumpLine = normalizedBumpLine(snakeCase(bumpAccount));
            if (bumpLine) {
              lines.push(bumpLine);
            }
          }
          lines.push(`    ${stateVarName}.${fieldName} = ${value};`);
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
          if (stmt.signerSeeds && !(stmt.signerSeeds === "signer_seeds" && signerSeedsInScope)) {
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
          if (stmt.signerSeeds && !(stmt.signerSeeds === "signer_seeds" && signerSeedsInScope)) {
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
          if (stmt.signerSeeds && !(stmt.signerSeeds === "signer_seeds" && signerSeedsInScope)) {
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
          if (stmt.signerSeeds && !(stmt.signerSeeds === "signer_seeds" && signerSeedsInScope)) {
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
          if (stmt.signerSeeds && !(stmt.signerSeeds === "signer_seeds" && signerSeedsInScope)) {
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

          // ── Dedup guard ────────────────────────────────────────────────────
          // A preceding pass_through CPI (handled by ensureSignerSeedsForCode)
          // may already have emitted seeds + signer_seeds for this account.
          // Emitting them again would shadow the first binding and, in the worst
          // case, re-derive the bump instead of using the stored value.
          // Check the tracking set before doing any work.
          if (accountsWithSignerSeeds.has(accountName)) {
            break;
          }

          for (const seed of stmt.seeds) {
            const ctxBumpMatch = seed.match(/ctx\.bumps\.(\w+)/)?.[1];
            if (ctxBumpMatch) {
              const normalizedBump = snakeCase(ctxBumpMatch);
              if (!seenBumps.has(normalizedBump)) {
                seenBumps.add(normalizedBump);
                const bumpLine = normalizedBumpLine(normalizedBump);
                if (bumpLine) {
                  bumpPrelude.push(bumpLine);
                }
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
          signerSeedsInScope = true;
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

    const lines = ["    // Args", "    let mut remaining = data;"];
    for (const arg of args) {
      lines.push(this.emitArgDeserialize(arg));
    }
    lines.push(`    if !remaining.is_empty() {
        return Err(ProgramError::InvalidInstructionData);
    }`);
    return lines.join("\n");
  }

  protected emitArgDeserialize(arg: Arg): string {
    const size = this.resolveTypeSize(arg.type);
    const name = snakeCase(arg.name);
    const fixedArray = parseFixedArrayType(arg.type);

    switch (arg.type) {
      case "u8":
        return `    if remaining.len() < 1 {
        return Err(ProgramError::InvalidInstructionData);
    }
    let (arg_bytes, rest) = remaining.split_at(1);
    remaining = rest;
    let ${name}: u8 = arg_bytes[0];`;
      case "u16": case "u32": case "u64": case "u128":
      case "i16": case "i32": case "i64": case "i128":
        return `    if remaining.len() < ${size} {
        return Err(ProgramError::InvalidInstructionData);
    }
    let (arg_bytes, rest) = remaining.split_at(${size});
    remaining = rest;
    let ${name}: ${arg.type} = ${arg.type}::from_le_bytes(
        arg_bytes.try_into().map_err(|_| ProgramError::InvalidInstructionData)?
    );`;
      case "i8":
        return `    if remaining.len() < 1 {
        return Err(ProgramError::InvalidInstructionData);
    }
    let (arg_bytes, rest) = remaining.split_at(1);
    remaining = rest;
    let ${name}: i8 = arg_bytes[0] as i8;`;
      case "bool":
        return `    if remaining.len() < 1 {
        return Err(ProgramError::InvalidInstructionData);
    }
    let (arg_bytes, rest) = remaining.split_at(1);
    remaining = rest;
    let ${name}: bool = match arg_bytes[0] {
        0 => false,
        1 => true,
        _ => return Err(ProgramError::InvalidInstructionData),
    };`;
      case "Pubkey":
        return `    if remaining.len() < 32 {
        return Err(ProgramError::InvalidInstructionData);
    }
    let (arg_bytes, rest) = remaining.split_at(32);
    remaining = rest;
    let ${name} = ${this.emitPubkeyDeserializeSlice("arg_bytes")};`;
      case "String":
      case "Vec<u8>":
        return `    let ${name}: ${arg.type} = BorshDeserialize::deserialize(&mut remaining)
        .map_err(|_| ProgramError::InvalidInstructionData)?;`;
      default:
        if (/^\[\s*u8\s*;\s*\d+\s*\]$/.test(arg.type)) {
          return `    if remaining.len() < ${size} {
        return Err(ProgramError::InvalidInstructionData);
    }
    let (arg_bytes, rest) = remaining.split_at(${size});
    remaining = rest;
    let ${name}: ${arg.type} = arg_bytes
        .try_into().map_err(|_| ProgramError::InvalidInstructionData)?;`;
        }
        if (fixedArray) {
          return `    let ${name}: ${arg.type} = BorshDeserialize::deserialize(&mut remaining)
        .map_err(|_| ProgramError::InvalidInstructionData)?;`;
        }
        const typeDef = this.customTypeDef(arg.type);
        if (typeDef) {
          return `    let ${name}: ${arg.type} = BorshDeserialize::deserialize(&mut remaining)
        .map_err(|_| ProgramError::InvalidInstructionData)?;`;
        }
        return `    // TODO: parse ${name}: ${arg.type}`;
    }
  }

  protected emitPubkeyDeserialize(start: number, end: number): string {
    return `data[${start}..${end}].try_into().map_err(|_| ProgramError::InvalidInstructionData)?`;
  }

  protected emitPubkeyDeserializeSlice(sliceExpr: string): string {
    return `${sliceExpr}.try_into().map_err(|_| ProgramError::InvalidInstructionData)?`;
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
    const fixedArray = parseFixedArrayType(typeName);
    if (fixedArray) {
      const elementSize = this.resolveTypeSize(fixedArray.elementType, visited);
      const len = resolveConstExprValue(fixedArray.lenExpr, this.currentIr?.constants ?? []);
      if (elementSize > 0 && len !== null) {
        return elementSize * len;
      }
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
        return `#[derive(Clone, Copy, Debug, PartialEq, BorshDeserialize, BorshSerialize)]
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
        .map((field) => `    pub ${snakeCase(field.name)}: ${this.rustTypeForCustomType(field.type)},`)
        .join("\n");
      return `#[derive(Clone, Debug, PartialEq, BorshDeserialize, BorshSerialize)]
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

  // ─── Shared byte-layout serialization helpers ──────────────────────────────
  // These power the read()/write() impls emitted for every account struct.
  // Subclasses inherit them; override rustTypeForFramework() to adapt the Pubkey
  // representation ([u8;32] in Pinocchio, Pubkey in Native/Quasar).

  protected accountDiscriminatorExpr(name: string): string {
    return accountDiscriminator(name);
  }

  protected buildReadLines(acc: AccountDef): string {
    return acc.fields
      .map((f) => this.buildReadLine(f.type, snakeCase(f.name)))
      .join("\n");
  }

  protected buildWriteLines(acc: AccountDef): string {
    return acc.fields
      .map((f) => this.buildWriteLine(f.type, snakeCase(f.name)))
      .join("\n");
  }

  protected buildReadLine(typeName: string, fieldName: string): string {
    const size = this.resolveTypeSize(typeName);
    const typeDef = this.customTypeDef(typeName);
    const rustType = this.rustTypeForFramework(typeName);
    const fixedArray = parseFixedArrayType(typeName);

    if (typeName === "Pubkey") {
      // Use rustTypeForFramework so Pinocchio gets [u8;32], others get Pubkey
      return `        let ${fieldName}: ${rustType} = ${this.emitPubkeyFieldRead(size)};
        offset += ${size};`;
    }
    if (/^\[\s*u8\s*;\s*\d+\s*\]$/.test(typeName)) {
      return `        let ${fieldName}: ${typeName} = data[offset..offset + ${size}]
            .try_into().map_err(|_| ProgramError::InvalidAccountData)?;
        offset += ${size};`;
    }
    if (fixedArray || typeDef?.kind === "struct") {
      return `        let mut ${fieldName}_bytes = &data[offset..offset + ${size}];
        let ${fieldName}: ${typeName} = BorshDeserialize::deserialize(&mut ${fieldName}_bytes)
            .map_err(|_| ProgramError::InvalidAccountData)?;
        offset += ${size};`;
    }
    if (typeDef?.kind === "enum") {
      return `        let ${fieldName}: ${typeName} = ${typeName}::try_from(data[offset])
            .map_err(|_| ProgramError::InvalidAccountData)?;
        offset += 1;`;
    }
    if (typeName === "bool") {
      return `        let ${fieldName}: bool = match data[offset] {
            0 => false,
            1 => true,
            _ => return Err(ProgramError::InvalidAccountData),
        };
        offset += 1;`;
    }
    if (typeName === "u8") {
      return `        let ${fieldName}: u8 = data[offset];
        offset += 1;`;
    }
    if (typeName === "i8") {
      return `        let ${fieldName}: i8 = data[offset] as i8;
        offset += 1;`;
    }
    return `        let ${fieldName}: ${typeName} = ${typeName}::from_le_bytes(
            data[offset..offset + ${size}].try_into().map_err(|_| ProgramError::InvalidAccountData)?
        );
        offset += ${size};`;
  }

  protected buildWriteLine(typeName: string, fieldName: string): string {
    const size = this.resolveTypeSize(typeName);
    const typeDef = this.customTypeDef(typeName);
    const fixedArray = parseFixedArrayType(typeName);

    if (typeName === "Pubkey" || /^\[\s*u8\s*;\s*\d+\s*\]$/.test(typeName)) {
      return `        data[offset..offset + ${size}].copy_from_slice(&value.${fieldName}${this.emitPubkeyFieldAsRef()});
        offset += ${size};`;
    }
    if (fixedArray || typeDef?.kind === "struct") {
      return `        {
            let mut ${fieldName}_bytes = &mut data[offset..offset + ${size}];
            BorshSerialize::serialize(&value.${fieldName}, &mut ${fieldName}_bytes)
                .map_err(|_| ProgramError::InvalidAccountData)?;
        }
        offset += ${size};`;
    }
    if (typeDef?.kind === "enum") {
      return `        data[offset] = value.${fieldName} as u8;
        offset += 1;`;
    }
    if (typeName === "bool") {
      return `        data[offset] = if value.${fieldName} { 1 } else { 0 };
        offset += 1;`;
    }
    if (typeName === "u8" || typeName === "i8") {
      return `        data[offset] = value.${fieldName} as u8;
        offset += 1;`;
    }
    return `        data[offset..offset + ${size}].copy_from_slice(&value.${fieldName}.to_le_bytes());
        offset += ${size};`;
  }

  /**
   * How to deserialize a Pubkey at the current `offset` in a read() body.
   * Pinocchio overrides to return the raw array (since Pubkey IS [u8;32]).
   * Native keeps it as Pubkey::new_from_array(...).
   */
  protected emitPubkeyFieldRead(_size: number): string {
    return `data[offset..offset + 32].try_into().map_err(|_| ProgramError::InvalidAccountData)?`;
  }

  /**
   * Whether a Pubkey field value needs `.as_ref()` to get &[u8] for copy_from_slice.
   * Returns "" for Pinocchio ([u8;32] IS already a byte array),
   * returns ".as_ref()" for frameworks where Pubkey wraps [u8;32].
   */
  protected emitPubkeyFieldAsRef(): string {
    return "";
  }

  protected emitInitAccountPrelude(
    accountRef: Instruction["accounts"][number],
    instr: Instruction,
    ir: SolanaIR,
  ): string {
    const accountName = snakeCase(accountRef.name);
    const payerName = accountRef.initPayer ? snakeCase(accountRef.initPayer) : undefined;
    if (!payerName || !accountRef.initSpace) {
      this.warnings.push(
        `Init account '${accountName}' is missing payer/space metadata; generated output may require manual allocation wiring.`
      );
      return "";
    }

    const payerRef = instr.accounts.find((account) => snakeCase(account.name) === payerName);
    if (!payerRef) {
      this.warnings.push(
        `Init account '${accountName}' references unknown payer '${payerName}'.`
      );
      return "";
    }

    let signerPrelude = "";
    let signerSeedsExpr: string | undefined;
    if (accountRef.isPda) {
      const pdaSeeds = (accountRef.pdaSeeds ?? [`b"${accountName}"`]).map((seed) =>
        this.normalizeInitSeedExpr(seed)
      );
      const bumpLine = this.emitBumpSeed(
        "program_id",
        pdaSeeds,
        accountName,
      )
        .replace(/\blet bump =/g, `let bump_${accountName} =`)
        .replace(/\blet\s+\(expected_key,\s*bump\)\s*=/g, `let (expected_key, bump_${accountName}) =`);
      signerPrelude = `${bumpLine}
    let init_${accountName}_seeds = &[
            ${[...pdaSeeds, `&[bump_${accountName}]`].join(",\n            ")},
        ];
    let init_${accountName}_signer_seeds = &[&init_${accountName}_seeds[..]];`;
      signerSeedsExpr = `init_${accountName}_signer_seeds`;
    }

    const createCall = this.emitCreateProgramAccount(
      accountName,
      payerName,
      accountRef.initSpace,
      signerSeedsExpr,
    );
    return [signerPrelude, createCall].filter(Boolean).join("\n");
  }

  protected normalizeInitSeedExpr(seed: string): string {
    const trimmed = cleanInlineExpr(seed);
    return trimmed
      .replace(/ctx\.accounts\.(\w+)\.key\(\)\.as_ref\(\)/g, (_full, name: string) =>
        this.emitAccountKeyAsRefExpr(snakeCase(name))
      )
      .replace(/ctx\.accounts\.(\w+)\.key\.as_ref\(\)/g, (_full, name: string) =>
        this.emitAccountKeyAsRefExpr(snakeCase(name))
      );
  }

  /**
   * Return the default/zero value for a given Rust type in generated code.
   * Subclasses can override for framework-specific type representations
   * (e.g. Pinocchio uses [0u8; 32] instead of Pubkey::default()).
   */
  protected defaultValueForType(typeName: string): string {
    const normalized = typeName.trim();
    const typeDef = this.customTypeDef(normalized);
    const fixedArray = parseFixedArrayType(normalized);

    if (normalized === "bool") return "false";
    if (/^(u|i)\d+$/.test(normalized)) return "0";
    if (normalized === "Pubkey") return this.defaultPubkeyValue();
    if (fixedArray) {
      return `[${this.defaultValueForType(fixedArray.elementType)}; ${fixedArray.lenExpr.trim()}]`;
    }
    const arrayMatch = normalized.match(/^\[\s*u8\s*;\s*(\d+)\s*\]$/);
    if (arrayMatch?.[1]) return `[0u8; ${arrayMatch[1]}]`;
    if (normalized === "String") return "String::new()";
    if (normalized === "Vec<u8>") return "Vec::new()";
    if (typeDef?.kind === "enum" && typeDef.variants?.[0]) {
      return `${normalized}::${typeDef.variants[0]}`;
    }
    return `${normalized}::default()`;
  }

  /**
   * Returns the zero-value for a Pubkey field in generated struct initialization.
   * Pinocchio overrides this because Pubkey IS [u8; 32] — Pubkey::default() doesn't exist.
   */
  protected defaultPubkeyValue(): string {
    return "Pubkey::default()";
  }

  /**
   * Emit a safe field-by-field initialized local variable for an account struct
   * that is being created (isInit). This avoids reading discriminator-protected
   * account data before the create-account CPI has happened and avoids `unsafe`
   * zeroing in generated output.
   */
  protected emitStateInit(typeName: string, localVar: string): string {
    const accountDef = this.currentIr?.accounts.find((account) => account.name === typeName);
    if (!accountDef) {
      return `    let mut ${localVar} = ${typeName}::default();`;
    }

    const fields = accountDef.fields
      .map((field) => `        ${snakeCase(field.name)}: ${this.defaultValueForType(field.type)},`)
      .join("\n");
    return `    let mut ${localVar} = ${typeName} {
${fields}
    };`;
  }

  /**
   * Wrap a helper function that was carried verbatim from the Anchor source.
   *
   * If the function body contains Anchor-specific API patterns (ctx, CpiContext,
   * system_program::transfer, anchor_spl, require!, emit!) it receives a full
   * ⚠️ warning banner so the developer knows it must be rewritten.
   *
   * Pure Rust helpers (arithmetic, bit manipulation, lookups, etc.) that happen
   * to live in the same Anchor file are plain-correct and get only a light
   * comment — no false-positive warning.
   */
  protected carriedFunctionBlock(rawCode: string): string {
    const transformed = this.transformHelperCode(rawCode);
    if (!hasResidualAnchorPatterns(rawCode)) {
      // No Anchor-specific APIs detected — the function is likely pure Rust
      // and will compile as-is in the target framework.
      return `// Carried from source (pure Rust — no Anchor APIs detected)\n${transformed}`;
    }
    return [
      `// ╔════════════════════════════════════════════════════════════════════════════════╗`,
      `// ║  ⚠️  ANVIL: function below was carried verbatim from the Anchor source.      ║`,
      `// ║  It still uses Anchor APIs (ctx, CpiContext, system_program::transfer, etc.) ║`,
      `// ║  and MUST be rewritten for ${this.frameworkName.padEnd(48)} ║`,
      `// ║  before this code will compile.                                              ║`,
      `// ╚════════════════════════════════════════════════════════════════════════════════╝`,
      transformed,
    ].join("\n");
  }

  protected transformHelperCode(code: string): string {
    let next = code;
    next = next.replace(/&mut\s+Account\s*<\s*(?:'?\w+\s*,\s*)?([\w:]+)\s*>/g, "&mut $1");
    next = next.replace(/&\s*Account\s*<\s*(?:'?\w+\s*,\s*)?([\w:]+)\s*>/g, "&$1");
    next = next.replace(/->\s*Result<\s*\(\s*\)\s*>/g, "-> ProgramResult");
    next = next.replace(/->\s*Result<\s*([^>]+)\s*>/g, "-> Result<$1, ProgramError>");
    next = next.replace(
      /require!\(([\s\S]+?),\s*([\w:]+(?:::\w+)*)\s*\);/g,
      (_full, condition: string, error: string) => emitRequireGuard(condition.trim(), error.trim(), "")
    );
    next = next.replace(
      /emit!\(\s*(\w+)\s*\{\s*([\s\S]*?)\s*\}\s*\);/g,
      (_full, event: string, fields: string) => this.emitEmit(event, fields).replace(/^    /gm, "")
    );
    next = next.replace(
      /(^|[^\w:])msg!\(([\s\S]*?)\);/g,
      (_full, prefix: string, message: string) => `${prefix}${this.emitMsg(cleanInlineExpr(message)).replace(/^    /gm, "")}`
    );
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

/**
 * Returns true if the type should use checked arithmetic (checked_add, checked_sub)
 * to prevent silent overflow in release mode. Applies to 64-bit and wider integer
 * types that are commonly used for financial values (lamports, token amounts, etc.).
 */
export function isCheckedArithmeticType(typeName: string): boolean {
  return typeName === "u64" || typeName === "u128" || typeName === "i64" || typeName === "i128";
}

export function typeSize(typeName: string): number {
  const sizes: Record<string, number> = {
    u8: 1, u16: 2, u32: 4, u64: 8, u128: 16,
    i8: 1, i16: 2, i32: 4, i64: 8, i128: 16,
    bool: 1, Pubkey: 32, String: 64, "Vec<u8>": 4,
  };
  const fixedArray = parseFixedArrayType(typeName);
  if (fixedArray) {
    const elementSize = typeSize(fixedArray.elementType);
    const len = resolveConstExprValue(fixedArray.lenExpr, []);
    if (elementSize > 0 && len !== null) {
      return elementSize * len;
    }
  }
  return sizes[typeName] ?? 32;
}

function parseFixedArrayType(typeName: string): { elementType: string; lenExpr: string } | null {
  const trimmed = typeName.trim();
  if (!trimmed.startsWith("[") || !trimmed.endsWith("]")) return null;

  let depth = 0;
  let splitIdx = -1;
  for (let i = 1; i < trimmed.length - 1; i++) {
    const char = trimmed[i];
    if (char === "[") depth++;
    else if (char === "]") depth--;
    else if (char === ";" && depth === 0) {
      splitIdx = i;
      break;
    }
  }

  if (splitIdx === -1) return null;
  const elementType = trimmed.slice(1, splitIdx).trim();
  const lenExpr = trimmed.slice(splitIdx + 1, -1).trim();
  if (!elementType || !lenExpr) return null;
  return { elementType, lenExpr };
}

function resolveConstExprValue(expr: string, constants: string[], seen = new Set<string>()): number | null {
  const trimmed = expr.trim();
  if (/^\d+$/.test(trimmed)) {
    return Number.parseInt(trimmed, 10);
  }

  const wrappedMatch = trimmed.match(/^\(\s*(.+)\s*\)$/);
  if (wrappedMatch?.[1]) {
    return resolveConstExprValue(wrappedMatch[1], constants, seen);
  }

  if (/^[A-Z_][A-Z0-9_]*$/.test(trimmed)) {
    if (seen.has(trimmed)) return null;
    seen.add(trimmed);
    const constant = constants.find((value) => new RegExp(`(?:pub\\s+)?const\\s+${trimmed}\\s*:`).test(value));
    if (!constant) return null;
    const rhs = constant.match(/=\s*([^;]+);?$/)?.[1]?.trim();
    if (!rhs) return null;
    return resolveConstExprValue(rhs, constants, seen);
  }

  const multMatch = trimmed.match(/^(.+)\*\s*(.+)$/);
  if (multMatch?.[1] && multMatch[2]) {
    const left = resolveConstExprValue(multMatch[1], constants, new Set(seen));
    const right = resolveConstExprValue(multMatch[2], constants, new Set(seen));
    return left !== null && right !== null ? left * right : null;
  }

  const addMatch = trimmed.match(/^(.+)\+\s*(.+)$/);
  if (addMatch?.[1] && addMatch[2]) {
    const left = resolveConstExprValue(addMatch[1], constants, new Set(seen));
    const right = resolveConstExprValue(addMatch[2], constants, new Set(seen));
    return left !== null && right !== null ? left + right : null;
  }

  return null;
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

export function irNeedsInitAccountHelper(ir: SolanaIR): boolean {
  return ir.instructions.some((instr) =>
    instr.accounts.some((account) => account.isInit)
  );
}

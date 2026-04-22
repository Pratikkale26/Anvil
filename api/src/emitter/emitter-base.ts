/**
 * Emitter Base — Shared foundation for all target framework emitters.
 *
 * Provides:
 *   - Abstract interface that each framework emitter implements
 *   - Generic instruction body emitter that walks BodyStatements and
 *     calls framework-specific transform functions for TRANSFORM ops,
 *     while passing through pure Rust code unchanged.
 *   - Multi-file output generation (lib.rs, state.rs, instructions/, errors.rs)
 *
 * Utility functions, IR helpers, body walking, and anchor transforms are
 * factored into separate modules and re-exported from here for backward
 * compatibility.
 */

import type {
  SolanaIR,
  AccountDef,
  Instruction,
  Arg,
  BodyStatement,
  EmitterOutput,
  EmitterFile,
} from "../ir/schema.js";

// ─── Re-export utilities for backward compatibility ──────────────────────────

export {
  instrDiscriminator,
  accountDiscriminator,
  discriminatorBytes,
  formatByteArray,
  isProgramAccount,
  isCheckedArithmeticType,
  typeSize,
  parseFixedArrayType,
  resolveConstExprValue,
  snakeCase,
  toPascalCase,
  capitalize,
  cleanInlineExpr,
  stripAnchorConstraintError,
  indentBlock,
  trimOuterParens,
  unwrapTopLevelNegation,
  normalizeConditionKey,
  emitRequireGuard,
  simplifyPassThroughCode,
} from "./emitter-utils.js";

export {
  irNeedsHelper,
  irNeedsUnsignedLamportsHelper,
  irNeedsSignedLamportsHelper,
  irNeedsTokenAmountHelper,
  irNeedsUnsignedSplMintToHelper,
  irNeedsSignedSplMintToHelper,
  irNeedsUnsignedSplBurnHelper,
  irNeedsSignedSplBurnHelper,
  irNeedsSignedSplCloseAccountHelper,
  irNeedsUnsignedSplCloseAccountHelper,
  irNeedsInitAccountHelper,
  irNeedsToken2022Helper,
  irNeedsAtaCreationHelper,
  hasResidualAnchorPatterns,
} from "./emitter-helpers.js";

// ─── Internal imports ────────────────────────────────────────────────────────

import {
  snakeCase,
  toPascalCase,
  isProgramAccount,
  cleanInlineExpr,
  stripAnchorConstraintError,
  emitRequireGuard,
  typeSize,
  parseFixedArrayType,
  resolveConstExprValue,
  accountDiscriminator,
} from "./emitter-utils.js";
import { hasResidualAnchorPatterns } from "./emitter-helpers.js";
import {
  emitBodyStatements as emitBodyStatementsImpl,
  type BodyEmitterContext,
  type BodyEmitterCallbacks,
} from "./body-emitter.js";
import { transformHelperCode as transformHelperCodeImpl } from "./anchor-transforms.js";

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

  // ── ATA creation ──
  abstract emitCreateAta(
    ata: string,
    payer: string,
    mint: string,
    authority: string,
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
   * Emit a system program create_account CPI.
   * Default implementation emits a generic invoke() call.
   * Framework-specific emitters can override for native helpers.
   */
  emitCreateAccountCpi(
    from: string,
    to: string,
    lamports: string,
    space: string,
    owner: string,
  ): string {
    return `// System Program: create_account\n    invoke(\n        &system_instruction::create_account(\n            ${from}.key,\n            ${to}.key,\n            ${lamports},\n            ${space} as u64,\n            ${owner},\n        ),\n        &[${from}.clone(), ${to}.clone()],\n    )?;`;
  }

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
        // Filter out `use { anchor_lang::..., anchor_spl::... }` block imports
        if (/^use\s*\{[\s\S]*\banchor_lang::/.test(statement)) return false;
        if (/^use\s*\{[\s\S]*\banchor_spl::/.test(statement)) return false;
        // Filter out imports from external Anchor crates that leak through
        if (/\banchor_lang\b/.test(statement)) return false;
        if (/\banchor_spl\b/.test(statement)) return false;
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
      .filter((a) => a.isInit && (isCustomState(a.accountType) || (a.isPda && a.pdaSeeds?.length)))
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
    const ctx: BodyEmitterContext = {
      transformedCount: this.transformedCount,
      passedThroughCount: this.passedThroughCount,
      details: this.details,
      warnings: this.warnings,
    };

    const result = emitBodyStatementsImpl(
      this as unknown as BodyEmitterCallbacks,
      ctx,
      statements,
      instr,
      ir,
    );

    // Sync mutable state back
    this.transformedCount = ctx.transformedCount;
    this.passedThroughCount = ctx.passedThroughCount;

    return result;
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
    let ${name}: ${this.rustTypeForFramework("Pubkey")} = ${this.emitPubkeyDeserializeSlice("arg_bytes")};`;
      case "String":
      case "Vec<u8>":
        return `    let ${name}: ${arg.type} = BorshDeserialize::deserialize(&mut remaining)
        .map_err(|_| ProgramError::InvalidInstructionData)?;`;
      default:
        // Handle Option<T> types — Borsh format: first byte 0=None, 1=Some, then inner value
        if (arg.type.startsWith("Option<") && arg.type.endsWith(">")) {
          return `    let ${name}: ${arg.type} = BorshDeserialize::deserialize(&mut remaining)
        .map_err(|_| ProgramError::InvalidInstructionData)?;`;
        }
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
        // Complex enums with tuple variants need derive macros so they can be
        // used inside structs that derive BorshSerialize/BorshDeserialize.
        const rawCode = typeDef.rawCode.trim();
        const alreadyHasDerive = /^#\[derive\(/.test(rawCode);
        if (alreadyHasDerive) {
          return rawCode;
        }
        return `#[derive(Clone, Debug, PartialEq, BorshSerialize, BorshDeserialize)]\n${rawCode}`;
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

    // ── ATA creation: if the account has associated_token::mint and associated_token::authority,
    // emit an ATA creation CPI instead of create_program_account ──
    const ataMintConstraint = accountRef.constraints.find((c) => c.kind === "associated_token::mint" && c.value);
    const ataAuthorityConstraint = accountRef.constraints.find((c) => c.kind === "associated_token::authority" && c.value);
    if (ataMintConstraint?.value && ataAuthorityConstraint?.value) {
      const mint = snakeCase(ataMintConstraint.value);
      const authority = snakeCase(ataAuthorityConstraint.value);
      const payer = payerName ?? "payer";
      return this.emitCreateAta(accountName, payer, mint, authority);
    }

    if (!payerName || !accountRef.initSpace) {
      // Even without full payer/space info, PDA init accounts still need bump derivation
      // so that body code referencing ctx.bumps.X (e.g., pool.vault_bump = bump_vault) compiles.
      if (accountRef.isPda && accountRef.pdaSeeds?.length) {
        const pdaSeeds = (accountRef.pdaSeeds).map((seed) =>
          this.normalizeInitSeedExpr(seed)
        );
        const bumpOnly = this.emitBumpSeed("program_id", pdaSeeds, accountName)
          .replace(/\blet bump =/g, `let bump_${accountName} =`)
          .replace(/\blet\s+\(expected_key,\s*bump\)\s*=/g, `let (expected_key, bump_${accountName}) =`);
        this.warnings.push(
          `Init account '${accountName}' is missing payer/space metadata (token account?); bump derived but allocation must be handled externally.`
        );
        return bumpOnly;
      }
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

      // Lift to_le_bytes() temporaries out of the init seeds array to avoid
      // E0716 (temporary dropped while borrowed).
      const initSeedPrelude: string[] = [];
      let initTempCount = 0;
      const liftedSeeds = pdaSeeds.map((seed) => {
        // Match patterns like: seed.to_le_bytes().as_ref()
        const asRefMatch = seed.match(/^(.+)\.to_le_bytes\(\)\.as_ref\(\)$/);
        if (asRefMatch?.[1]) {
          const varName = initTempCount === 0 ? `init_seed_bytes` : `init_seed_bytes_${initTempCount + 1}`;
          initTempCount++;
          initSeedPrelude.push(`    let ${varName} = ${asRefMatch[1].trim()}.to_le_bytes();`);
          return `${varName}.as_ref()`;
        }
        // Match patterns like: &seed.to_le_bytes()
        const refMatch = seed.match(/^&(.+)\.to_le_bytes\(\)$/);
        if (refMatch?.[1]) {
          const varName = initTempCount === 0 ? `init_seed_bytes` : `init_seed_bytes_${initTempCount + 1}`;
          initTempCount++;
          initSeedPrelude.push(`    let ${varName} = ${refMatch[1].trim()}.to_le_bytes();`);
          return `&${varName}`;
        }
        return seed;
      });

      const initSeedPreludeStr = initSeedPrelude.length > 0 ? `\n${initSeedPrelude.join("\n")}` : "";
      signerPrelude = `${bumpLine}${initSeedPreludeStr}
    let init_${accountName}_seeds: &[&[u8]] = &[
            ${[...liftedSeeds, `&[bump_${accountName}]`].join(",\n            ")},
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
      )
      // Catch non-prefixed .key().as_ref() forms (e.g. authority.key().as_ref())
      .replace(/(\w+)\.key\(\)\.as_ref\(\)/g, (_full, name: string) =>
        this.emitAccountKeyAsRefExpr(snakeCase(name))
      )
      // Catch non-prefixed .key.as_ref() forms (e.g. authority.key.as_ref())
      .replace(/(\w+)\.key\.as_ref\(\)/g, (_full, name: string) =>
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
   * warning banner so the developer knows it must be rewritten.
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
    return transformHelperCodeImpl(
      code,
      (event, fields) => this.emitEmit(event, fields),
      (message) => this.emitMsg(message),
    );
  }
}

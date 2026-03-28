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
  abstract emitStateRead(accountName: string, typeName: string, localVar: string, mutable: boolean): string;
  abstract emitStateSave(accountName: string, typeName: string, localVar: string): string;
  abstract emitBumpSeed(programId: string, seeds: string[], expectedKey: string): string;

  // ── CPI transforms ──
  abstract emitSystemTransfer(from: string, to: string, amount: string, signerSeeds?: string): string;
  abstract emitSplTransfer(from: string, to: string, authority: string, amount: string, signerSeeds?: string): string;
  abstract emitSplMintTo(mint: string, to: string, authority: string, amount: string, signerSeeds?: string): string;
  abstract emitSplBurn(from: string, mint: string, authority: string, amount: string, signerSeeds?: string): string;
  abstract emitSplCloseAccount(account: string, destination: string, authority: string, signerSeeds?: string): string;

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
    sections.push(this.fileHeader(ir.name));
    sections.push(this.emitUseStatements(ir));

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
      sections.push(`// Carried from source\n${helper.rawCode}`);
    }

    if (sections.length === 0) return "";
    return `//! Helper functions for ${toPascalCase(ir.name)}\n\n` + sections.join("\n\n");
  }

  // ── Combined single-file output ──

  protected emitSingleFile(ir: SolanaIR): string {
    const sections: string[] = [];

    sections.push(this.fileHeader(ir.name));
    sections.push(this.emitUseStatements(ir));
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
      sections.push(`// Carried from source\n${helper.rawCode}`);
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

    // Account bindings
    const bindings = nonProgramAccounts
      .map((acc, idx) => this.emitAccountBinding(snakeCase(acc.name), idx))
      .join("\n");

    // Signer checks
    const signerChecks = nonProgramAccounts
      .filter((a) => a.isSigner)
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
    if accounts.len() < ${nonProgramAccounts.length} {
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
    const mutableStateAccounts = new Set(
      statements
        .filter((stmt): stmt is Extract<BodyStatement, { kind: "state_field_assign" }> => stmt.kind === "state_field_assign")
        .map((stmt) => snakeCase(stmt.account))
    );

    // Collect which accounts are mutated (for auto-save)
    const mutatedAccounts = new Set<string>();
    const stateVars = new Map<string, string>();
    const accountInfoVars = new Map<string, string>();

    const resolveStateVar = (account: string): string => stateVars.get(account) ?? account;
    const resolveAccountInfoVar = (account: string): string => accountInfoVars.get(account) ?? account;
    const emitPendingSaves = (): void => {
      for (const accName of mutatedAccounts) {
        const accRef = instr.accounts.find(a => snakeCase(a.name) === snakeCase(accName));
        const typeName = accRef?.accountType || "Unknown";
        if (!isProgramAccount(typeName) && typeName !== "Unknown" && typeName !== "Signer" && typeName !== "SystemAccount" && typeName !== "UncheckedAccount") {
          lines.push(this.emitStateSave(
            resolveAccountInfoVar(snakeCase(accName)),
            typeName,
            resolveStateVar(snakeCase(accName))
          ));
        }
      }
    };

    for (const stmt of statements) {
      switch (stmt.kind) {
        // ── PASS-THROUGH ──
        case "pass_through": {
          this.passedThroughCount++;
          const rawCode = stmt.code.trim();

          // Skip pass_through Ok(()) — handled by instruction wrapper
          if (rawCode === "Ok(())") {
            emitPendingSaves();
            lines.push(`    Ok(())`);
            break;
          }

          // Transform require!() macros that leaked through as pass_through
          const requireMatch = rawCode.match(/^require!\(([\s\S]+),\s*([\w:]+(?:::\w+)*)\s*\);?$/);
          if (requireMatch?.[1] && requireMatch[2]) {
            this.transformedCount++;
            let condition = requireMatch[1].trim();
            // Transform ctx.accounts references inside the condition
            condition = condition.replace(/ctx\.accounts\.(\w+)\.(\w+\(\))/g, (_, name, method) => `${snakeCase(name)}.${method}`);
            condition = condition.replace(/ctx\.accounts\.(\w+)/g, (_, name) => snakeCase(name));
            lines.push(this.emitRequire(condition, requireMatch[2]));
            break;
          }

          // Don't add extra semicolons if the code already ends with one, with }, or with )
          let code: string;
          if (rawCode.endsWith(";") || rawCode.endsWith("}") || rawCode.endsWith(");")) {
            code = `    ${rawCode}`;
          } else {
            code = `    ${rawCode};`;
          }
          if (stmt.needsReview) {
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
          const accountRef = instr.accounts.find((acc) => snakeCase(acc.name) === accountName);
          const hasOneConstraints = accountRef?.constraints.filter(
            (constraint) => constraint.kind === "has_one" && constraint.value
          ) ?? [];
          for (const constraint of hasOneConstraints) {
            const targetAccount = snakeCase(constraint.value!);
            lines.push(`    if ${localVar}.${snakeCase(constraint.value!)} != *${targetAccount}.key() {`);
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
          // State field assignments are largely pass-through since they're just Rust
          // but we need to adapt ctx.accounts and ctx.bumps references
          let value = stmt.value;
          // Replace ctx.accounts.X.key() with the local variable reference
          value = value.replace(
            /ctx\.accounts\.(\w+)\.key\(\)/g,
            (_, name: string) => `*${snakeCase(name)}.key()`
          );
          // Replace ctx.bumps.X with bump derivation call
          if (value.includes("ctx.bumps.")) {
            const bumpAccount = value.match(/ctx\.bumps\.(\w+)/)?.[1] ?? stmt.account;
            // Derive seeds from the account's PDA constraints in the IR
            const accountRef = instr.accounts.find(a => snakeCase(a.name) === snakeCase(bumpAccount));
            const pdaSeeds = accountRef?.pdaSeeds ?? [`b"${snakeCase(bumpAccount)}"`];
            value = `bump`;
            lines.push(this.emitBumpSeed(
              "program_id",
              pdaSeeds,
              resolveAccountInfoVar(snakeCase(bumpAccount))
            ));
          }
          lines.push(`    ${resolveStateVar(snakeCase(stmt.account))}.${snakeCase(stmt.field)} = ${value};`);
          break;
        }

        // ── TRANSFORM: require macro ──
        case "require": {
          this.transformedCount++;
          lines.push(this.emitRequire(stmt.condition, stmt.error));
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
          const accountName = snakeCase(stmt.account);
          const accRef = instr.accounts.find(a => snakeCase(a.name) === accountName);
          let seedStateAccount: string | undefined;
          for (const seed of stmt.seeds) {
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
          const seedStateVar = seedStateAccount ? stateVars.get(seedStateAccount) : stateVars.get(accountName);
          const seedStateType = seedStateAccount
            ? instr.accounts.find(a => snakeCase(a.name) === seedStateAccount)?.accountType
            : accRef?.accountType;
          lines.push(this.emitPdaSignerSeeds(
            accountName,
            resolveAccountInfoVar(accountName),
            stmt.seeds,
            stmt.bumpField,
            seedStateVar,
            seedStateType
          ));
          break;
        }

        // ── Return Ok(()) ──
        case "return_ok": {
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
      offset += typeSize(arg.type);
      return line;
    });
    return `    // Args\n${lines.join("\n")}`;
  }

  protected emitArgDeserialize(arg: Arg, offset: number): string {
    const start = offset;
    const end = offset + typeSize(arg.type);
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
        return `    // TODO: parse ${name}: ${arg.type}`;
    }
  }

  protected emitPubkeyDeserialize(start: number, end: number): string {
    return `data[${start}..${end}].try_into().unwrap()`;
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

/**
 * Determine what helper functions an IR needs based on its body statements.
 */
export function irNeedsHelper(ir: SolanaIR, helperName: string): boolean {
  for (const instr of ir.instructions) {
    for (const stmt of instr.body) {
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

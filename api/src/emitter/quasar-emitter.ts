/**
 * Quasar Emitter — Generates real quasar-lang code targeting the quasar-lang API.
 *
 * Extends BaseEmitter with Quasar-specific implementations.
 *
 * Multi-file output: Generates proper quasar-lang project structure using
 * macros (#[program], #[derive(Accounts)], #[account], declare_id!).
 *
 * Single-file output: Uses manual entrypoint/routing/serialization with
 * pinocchio-compatible types as a fallback (quasar's macros require multi-file).
 *
 * Key quasar-lang patterns:
 *   - `use quasar_lang::prelude::*;`
 *   - `Address` instead of `Pubkey` (32 bytes)
 *   - `Signer`, `Account<T>`, `UncheckedAccount`, `Program<System>`, `Program<Token>`
 *   - `Ctx<AccountsStruct>` for instruction context
 *   - `#[instruction(discriminator = N)]` for routing
 *   - `Seed::from(...)` for PDA seeds
 *   - `accounts.token_program.transfer(from, to, authority, amount).invoke()`
 *   - `accounts.system_program.transfer(from, to, amount).invoke()`
 *   - `accounts.account.close(destination)`
 *   - `accounts.account.set_inner(field1, field2, ...)`
 *   - `log("...")` for logging
 *   - `require!(condition, error)`
 */

import type {
  SolanaIR,
  AccountDef,
  Instruction,
  EmitterOutput,
  EmitterFile,
} from "../ir/schema.js";
import {
  BaseEmitter,
  instrDiscriminator,
  accountDiscriminator,
  snakeCase,
  toPascalCase,
  isProgramAccount,
  irNeedsHelper,
  irNeedsSignedLamportsHelper,
  irNeedsSignedSplBurnHelper,
  irNeedsSignedSplMintToHelper,
  irNeedsUnsignedLamportsHelper,
  irNeedsUnsignedSplBurnHelper,
  irNeedsUnsignedSplMintToHelper,
  irNeedsSignedSplCloseAccountHelper,
  irNeedsUnsignedSplCloseAccountHelper,
  irNeedsTokenAmountHelper,
  irNeedsInitAccountHelper,
  irNeedsToken2022Helper,
  irNeedsAtaCreationHelper,
  emitRequireGuard,
} from "./emitter-base.js";

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Does the IR use any SPL token operations? */
function irNeedsSpl(ir: SolanaIR): boolean {
  return (
    irNeedsHelper(ir, "spl_transfer") ||
    irNeedsHelper(ir, "spl_mint_to") ||
    irNeedsHelper(ir, "spl_burn") ||
    irNeedsHelper(ir, "spl_close_account") ||
    irNeedsUnsignedSplMintToHelper(ir) ||
    irNeedsSignedSplMintToHelper(ir) ||
    irNeedsUnsignedSplBurnHelper(ir) ||
    irNeedsSignedSplBurnHelper(ir) ||
    irNeedsSignedSplCloseAccountHelper(ir) ||
    irNeedsUnsignedSplCloseAccountHelper(ir) ||
    ir.instructions.some((instr) =>
      instr.accounts.some(
        (a) =>
          a.accountType === "TokenAccount" ||
          a.accountType === "Mint" ||
          a.constraints.some(
            (c) =>
              c.kind.startsWith("token::") ||
              c.kind.startsWith("associated_token::"),
          ),
      ),
    )
  );
}

/** Map IR account type to quasar-lang type for #[derive(Accounts)] struct */
function quasarAccountType(
  accountType: string,
  isMut: boolean,
  isSigner: boolean,
  constraints: { kind: string; value?: string }[],
): { wrapper: string; lifetime: boolean } {
  // System program
  if (
    accountType === "SystemProgram" ||
    accountType === "System" ||
    accountType === "system_program"
  )
    return { wrapper: "Program<System>", lifetime: true };

  // Token program
  if (accountType === "TokenProgram" || accountType === "token_program")
    return { wrapper: "Program<Token>", lifetime: true };

  // Associated token program
  if (
    accountType === "AssociatedTokenProgram" ||
    accountType === "associated_token_program"
  )
    return { wrapper: "Program<Token>", lifetime: true };

  // Rent sysvar
  if (accountType === "Rent" || accountType === "SysvarRent")
    return { wrapper: "Sysvar<Rent>", lifetime: true };

  // Clock sysvar
  if (accountType === "Clock" || accountType === "SysvarClock")
    return { wrapper: "Sysvar<Clock>", lifetime: true };

  // SPL Token Account
  if (
    accountType === "TokenAccount" ||
    constraints.some(
      (c) =>
        c.kind.startsWith("token::") ||
        c.kind.startsWith("associated_token::"),
    )
  ) {
    if (isMut) return { wrapper: "&'info mut Account<Token>", lifetime: false };
    return { wrapper: "&'info Account<Token>", lifetime: false };
  }

  // Mint
  if (accountType === "Mint") {
    if (isMut) return { wrapper: "&'info mut Account<Mint>", lifetime: false };
    return { wrapper: "&'info Account<Mint>", lifetime: false };
  }

  // Signer
  if (isSigner) {
    if (isMut) return { wrapper: "&'info mut Signer", lifetime: false };
    return { wrapper: "&'info Signer", lifetime: false };
  }

  // Program-owned state account
  if (!isProgramAccount(accountType) && accountType !== "Unknown") {
    if (isMut)
      return {
        wrapper: `&'info mut Account<${accountType}>`,
        lifetime: false,
      };
    return { wrapper: `&'info Account<${accountType}>`, lifetime: false };
  }

  // Unchecked / unknown
  if (isMut) return { wrapper: "&'info mut UncheckedAccount", lifetime: false };
  return { wrapper: "&'info UncheckedAccount", lifetime: false };
}

// ─── Quasar Emitter ──────────────────────────────────────────────────────────

class QuasarEmitter extends BaseEmitter {
  override readonly frameworkName = "Quasar";

  // ── Override emit() to generate proper quasar-lang multi-file output ──

  override emit(ir: SolanaIR): EmitterOutput {
    this.currentIr = ir;
    this.warnings = [];
    this.transformedCount = 0;
    this.passedThroughCount = 0;
    this.details = [];

    const files: EmitterFile[] = [];

    // ── lib.rs (quasar-lang #[program] macro) ──
    files.push({ path: "lib.rs", content: this.emitQuasarLibFile(ir) });

    // ── state.rs (#[account] macro) ──
    if (ir.accounts.length > 0) {
      files.push({ path: "state.rs", content: this.emitQuasarStateFile(ir) });
    }

    // ── instructions/ (#[derive(Accounts)] + handler fns) ──
    if (ir.instructions.length > 0) {
      files.push({
        path: "instructions/mod.rs",
        content: this.emitQuasarInstrModFile(ir),
      });
      for (const instr of ir.instructions) {
        files.push({
          path: `instructions/${snakeCase(instr.name)}.rs`,
          content: this.emitQuasarInstrFile(instr, ir),
        });
      }
    }

    // ── errors.rs ──
    if (ir.errors.length > 0) {
      files.push({
        path: "errors.rs",
        content: this.emitQuasarErrorsFile(ir),
      });
    }

    // ── Cargo.toml ──
    files.push({
      path: "Cargo.toml",
      content: this.emitQuasarCargoToml(ir),
    });

    // ── Single-file output: use base emitter's manual entrypoint approach ──
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

  // ── Quasar multi-file generators ──────────────────────────────────────────

  private emitQuasarLibFile(ir: SolanaIR): string {
    const sections: string[] = [];
    const programName = snakeCase(ir.name);
    const needsSpl = irNeedsSpl(ir);
    const constants = ir.constants ?? [];
    const types = ir.types ?? [];

    sections.push(`#![cfg_attr(not(test), no_std)]`);
    sections.push(`use quasar_lang::prelude::*;`);
    if (needsSpl) {
      sections.push(`use quasar_spl::{Mint, Token, TokenCpi};`);
    }

    // Source imports (filtered)
    const sourceImports = this.filteredSourceImports(ir);
    if (sourceImports.length > 0) {
      sections.push(sourceImports.join("\n"));
    }

    // Module declarations
    const mods: string[] = [];
    if (ir.instructions.length > 0) {
      mods.push(`mod instructions;`);
      mods.push(`use instructions::*;`);
    }
    if (ir.accounts.length > 0) {
      mods.push(`mod state;`);
    }
    if (ir.errors.length > 0) {
      mods.push(`mod errors;`);
    }
    mods.push(`#[cfg(test)]`);
    mods.push(`mod tests;`);
    sections.push(mods.join("\n"));

    // Constants
    if (constants.length > 0) {
      sections.push(constants.join("\n\n"));
    }

    // Custom types
    if (types.length > 0) {
      sections.push(this.emitCustomTypes({ ...ir, types }));
    }

    // declare_id! + #[program] block
    sections.push(`declare_id!("${ir.programId ?? "11111111111111111111111111111111111111111111"}");`);

    const instrFns = ir.instructions
      .map((instr, idx) => {
        const name = snakeCase(instr.name);
        const accountsStructName = toPascalCase(instr.name);

        // Build argument list
        const args = instr.args.map(
          (arg) => `${snakeCase(arg.name)}: ${this.quasarArgType(arg.type)}`,
        );
        const allArgs = [`ctx: Ctx<${accountsStructName}>`, ...args].join(
          ", ",
        );

        // Build handler call arguments
        const handlerArgs: string[] = [`&mut ctx.accounts`];

        // Add instruction args (pass by value or reference depending on type)
        for (const arg of instr.args) {
          const argName = snakeCase(arg.name);
          if (arg.type === "String" || arg.type === "Vec<u8>") {
            handlerArgs.push(argName);
          } else {
            handlerArgs.push(argName);
          }
        }

        // Check if instruction uses bumps
        const usesBumps = this.instrUsesBumps(instr);
        if (usesBumps) {
          handlerArgs.push(`&ctx.bumps`);
        }

        return `    #[instruction(discriminator = ${idx})]
    pub fn ${name}(${allArgs}) -> Result<(), ProgramError> {
        instructions::handle_${name}(${handlerArgs.join(", ")})
    }`;
      })
      .join("\n\n");

    sections.push(`#[program]
mod quasar_${programName} {
    use super::*;

${instrFns}
}`);

    return sections.join("\n\n");
  }

  private emitQuasarStateFile(ir: SolanaIR): string {
    const sections: string[] = [];
    sections.push(`use quasar_lang::prelude::*;`);

    for (const [idx, acc] of ir.accounts.entries()) {
      const fields = acc.fields
        .map(
          (f) =>
            `    pub ${snakeCase(f.name)}: ${this.quasarStateFieldType(f.type)},`,
        )
        .join("\n");

      // Check if any field uses a dynamic type (String, Vec)
      const hasDynamicFields = acc.fields.some(
        (f) => f.type === "String" || f.type.startsWith("Vec<"),
      );
      const lifetime = hasDynamicFields ? "<'a>" : "";

      sections.push(`#[account(discriminator = ${idx + 1})]
pub struct ${acc.name}${lifetime} {
${fields}
}`);
    }

    return sections.join("\n\n");
  }

  private emitQuasarInstrModFile(ir: SolanaIR): string {
    const mods = ir.instructions
      .map((i) => {
        const name = snakeCase(i.name);
        return `pub mod ${name};\npub use ${name}::*;`;
      })
      .join("\n\n");
    return `${mods}\n`;
  }

  private emitQuasarInstrFile(instr: Instruction, ir: SolanaIR): string {
    const sections: string[] = [];
    const needsSpl = irNeedsSpl(ir);

    // Imports
    const imports: string[] = [];
    // Collect state types used by this instruction
    const stateTypes = new Set<string>();
    for (const acc of instr.accounts) {
      if (ir.accounts.some((a) => a.name === acc.accountType)) {
        stateTypes.add(acc.accountType);
      }
    }
    if (stateTypes.size > 0) {
      imports.push(
        `crate::state::{${[...stateTypes].join(", ")}}`,
      );
    }
    imports.push(`quasar_lang::prelude::*`);
    if (needsSpl) {
      // Check if this instruction specifically needs SPL
      const instrNeedsSpl = instr.accounts.some(
        (a) =>
          a.accountType === "TokenAccount" ||
          a.accountType === "Mint" ||
          a.accountType === "TokenProgram" ||
          a.constraints.some(
            (c) =>
              c.kind.startsWith("token::") ||
              c.kind.startsWith("associated_token::"),
          ),
      );
      const instrNeedsTokenCpi = instr.body.some(
        (s) =>
          s.kind === "cpi_spl_transfer" ||
          s.kind === "cpi_spl_mint_to" ||
          s.kind === "cpi_spl_burn" ||
          s.kind === "cpi_spl_close_account",
      );
      const splImports: string[] = [];
      if (
        instrNeedsSpl &&
        instr.accounts.some((a) => a.accountType === "Mint")
      )
        splImports.push("Mint");
      if (instrNeedsSpl) splImports.push("Token");
      if (instrNeedsTokenCpi) splImports.push("TokenCpi");
      if (splImports.length > 0) {
        imports.push(`quasar_spl::{${[...new Set(splImports)].join(", ")}}`);
      }
    }
    // Error imports
    if (ir.errors.length > 0) {
      const enumName = this.sourceErrorEnumName(ir);
      imports.push(`crate::errors::${enumName}`);
    }

    if (imports.length === 1) {
      sections.push(`use ${imports[0]};`);
    } else {
      sections.push(`use {\n${imports.map((i) => `    ${i},`).join("\n")}\n};`);
    }

    // #[derive(Accounts)] struct
    sections.push(this.emitQuasarAccountsStruct(instr, ir));

    // Handler function
    sections.push(this.emitQuasarHandler(instr, ir));

    return sections.join("\n\n");
  }

  private emitQuasarAccountsStruct(instr: Instruction, ir: SolanaIR): string {
    const structName = toPascalCase(instr.name);
    const fields = instr.accounts.map((acc) => {
      const name = snakeCase(acc.name);
      const attrs: string[] = [];

      // Build #[account(...)] constraints
      const constraints: string[] = [];
      if (acc.isMut) constraints.push("mut");
      if (acc.isInit) constraints.push("init");
      // init_if_needed for token accounts with token:: constraints
      const hasTokenConstraints = acc.constraints.some(
        (c) =>
          c.kind.startsWith("token::") ||
          c.kind.startsWith("associated_token::"),
      );
      if (!acc.isInit && hasTokenConstraints && acc.isMut) {
        // If it has token constraints but no init, add init_if_needed
        constraints.push("init_if_needed");
      }
      if (acc.initPayer) constraints.push(`payer = ${snakeCase(acc.initPayer)}`);
      // Seeds
      if (acc.isPda && acc.pdaSeeds.length > 0) {
        const seeds = acc.pdaSeeds.map((s) => this.normalizeQuasarSeed(s));
        constraints.push(`seeds = [${seeds.join(", ")}]`);
        constraints.push("bump");
      }
      // has_one constraints
      for (const c of acc.constraints) {
        if (c.kind === "has_one" && c.value) {
          constraints.push(`has_one = ${snakeCase(c.value)}`);
        }
        if (c.kind === "close" && c.value) {
          constraints.push(`close = ${snakeCase(c.value)}`);
        }
        if (c.kind === "constraint" && c.value) {
          constraints.push(`constraint = ${c.value}`);
        }
        if (c.kind === "token::mint" && c.value) {
          constraints.push(`token::mint = ${snakeCase(c.value)}`);
        }
        if (c.kind === "token::authority" && c.value) {
          constraints.push(`token::authority = ${snakeCase(c.value)}`);
        }
        if (c.kind === "associated_token::mint" && c.value) {
          constraints.push(`token::mint = ${snakeCase(c.value)}`);
        }
        if (c.kind === "associated_token::authority" && c.value) {
          constraints.push(`token::authority = ${snakeCase(c.value)}`);
        }
      }
      // Bump = field for non-init PDAs
      if (
        acc.isPda &&
        !acc.isInit &&
        ir.accounts.some((a) => a.name === acc.accountType)
      ) {
        const stateAcc = ir.accounts.find((a) => a.name === acc.accountType);
        if (stateAcc?.fields.some((f) => f.name === "bump")) {
          constraints.push(`bump = ${snakeCase(acc.name)}.bump`);
          // Remove the generic "bump" that was already added
          const bumpIdx = constraints.indexOf("bump");
          if (bumpIdx !== -1) constraints.splice(bumpIdx, 1);
        }
      }

      if (constraints.length > 0) {
        if (constraints.length <= 3) {
          attrs.push(`    #[account(${constraints.join(", ")})]`);
        } else {
          attrs.push(
            `    #[account(\n        ${constraints.join(",\n        ")}\n    )]`,
          );
        }
      }

      // Determine quasar type
      const { wrapper } = quasarAccountType(
        acc.accountType,
        acc.isMut,
        acc.isSigner,
        acc.constraints,
      );

      // For types that already include &'info, don't add it again
      const fullType = wrapper.startsWith("&'info")
        ? wrapper
        : `&'info ${wrapper}`;

      const attrStr = attrs.length > 0 ? `${attrs.join("\n")}\n` : "";
      return `${attrStr}    pub ${name}: ${fullType},`;
    });

    return `#[derive(Accounts)]
pub struct ${structName}<'info> {
${fields.join("\n")}
}`;
  }

  private emitQuasarHandler(instr: Instruction, ir: SolanaIR): string {
    const name = snakeCase(instr.name);
    const structName = toPascalCase(instr.name);
    const usesBumps = this.instrUsesBumps(instr);

    // Build function signature
    const params: string[] = [`accounts: &mut ${structName}`];
    for (const arg of instr.args) {
      const argName = snakeCase(arg.name);
      const argType = this.quasarArgType(arg.type);
      if (argType === "String") {
        params.push(`${argName}: &str`);
      } else {
        params.push(`${argName}: ${argType}`);
      }
    }
    if (usesBumps) {
      params.push(`bumps: &${structName}Bumps`);
    }

    // Emit body
    const body = this.emitQuasarHandlerBody(instr, ir);

    return `#[inline(always)]
pub fn handle_${name}(${params.join(", ")}) -> Result<(), ProgramError> {
${body}
}`;
  }

  private emitQuasarHandlerBody(instr: Instruction, ir: SolanaIR): string {
    const lines: string[] = [];

    for (const stmt of instr.body) {
      switch (stmt.kind) {
        case "pass_through": {
          this.passedThroughCount++;
          let code = stmt.code.trim();
          if (code === "Ok(())") {
            lines.push(`    Ok(())`);
            break;
          }
          // Transform ctx.accounts.X references
          code = this.transformQuasarPassThrough(code, instr, ir);
          if (code.endsWith(";") || code.endsWith("}") || code.endsWith(");")) {
            lines.push(`    ${code}`);
          } else {
            lines.push(`    ${code};`);
          }
          break;
        }

        case "state_read": {
          this.transformedCount++;
          // In quasar, state is accessed directly via accounts.X — no separate deserialization
          break;
        }

        case "bumps_access": {
          this.transformedCount++;
          // In quasar, bumps are accessed via ctx.bumps.X — handled in lib.rs
          break;
        }

        case "state_field_assign": {
          this.transformedCount++;
          const accountName = snakeCase(stmt.account);
          const fieldName = snakeCase(stmt.field);
          let value = this.transformQuasarExpr(stmt.value, instr, ir);

          // Handle compound assignments
          const compoundMatch = value.match(/^__compound_([+\-*\/])=__(.+)$/);
          if (compoundMatch?.[1] && compoundMatch[2]) {
            const op = compoundMatch[1];
            const rhs = this.transformQuasarExpr(
              compoundMatch[2],
              instr,
              ir,
            );
            const stateField = `accounts.${accountName}.${fieldName}`;
            if (op === "+" || op === "-") {
              const method = op === "+" ? "checked_add" : "checked_sub";
              lines.push(
                `    ${stateField} = ${stateField}.${method}(${rhs}).ok_or(ProgramError::ArithmeticOverflow)?;`,
              );
            } else {
              lines.push(`    ${stateField} = ${stateField} ${op} ${rhs};`);
            }
            break;
          }

          // Handle ctx.bumps references
          if (value.includes("ctx.bumps.")) {
            value = value.replace(
              /ctx\.bumps\.(\w+)/g,
              (_: string, bumpName: string) =>
                `bumps.${snakeCase(bumpName)}`,
            );
          }

          // Handle Pubkey/key references
          const accountRef = instr.accounts.find(
            (a) => snakeCase(a.name) === accountName,
          );
          const stateAcc = accountRef
            ? ir.accounts.find((a) => a.name === accountRef.accountType)
            : undefined;
          const fieldDef = stateAcc?.fields.find(
            (f) => snakeCase(f.name) === fieldName,
          );
          if (
            fieldDef &&
            (fieldDef.type === "Pubkey" || fieldDef.type === "Address")
          ) {
            // Convert .key() to .address() for quasar
            value = value.replace(
              /\baccounts\.(\w+)\.key\(\)/g,
              "*accounts.$1.address()",
            );
            value = value.replace(
              /\*(\w+)\.key\b/g,
              "*accounts.$1.address()",
            );
          }

          lines.push(
            `    accounts.${accountName}.${fieldName} = ${value};`,
          );
          break;
        }

        case "require": {
          this.transformedCount++;
          let condition = this.transformQuasarExpr(
            stmt.condition,
            instr,
            ir,
          );
          // Prefix account references with accounts.
          condition = this.prefixAccountRefs(condition, instr);
          lines.push(`    require!(${condition}, ${stmt.error});`);
          break;
        }

        case "msg": {
          this.transformedCount++;
          const literalMatch = stmt.message.match(/^"([^"\\]|\\.)*"/);
          if (literalMatch?.[0]) {
            const literal = literalMatch[0];
            if (literal !== stmt.message.trim()) {
              // Formatted message — collapse to static log
              lines.push(
                `    // Anvil: formatted msg!() collapsed to static log`,
              );
              lines.push(`    log(${literal});`);
            } else {
              lines.push(`    log(${stmt.message});`);
            }
          } else {
            const commaIdx = stmt.message.indexOf(",");
            if (commaIdx !== -1) {
              const literal = stmt.message.slice(0, commaIdx).trim();
              lines.push(
                `    // Anvil: formatted msg!() collapsed to static log`,
              );
              lines.push(`    log(${literal});`);
            } else {
              lines.push(`    log(${stmt.message});`);
            }
          }
          break;
        }

        case "emit": {
          this.transformedCount++;
          lines.push(`    log("event:${stmt.event}");`);
          if (stmt.fields.trim()) {
            lines.push(`    // Event data: ${stmt.fields.replace(/\n/g, " ")}`);
          }
          break;
        }

        case "cpi_system_transfer": {
          this.transformedCount++;
          const amount = this.transformQuasarExpr(stmt.amount, instr, ir);
          if (stmt.signerSeeds) {
            const seedsCode = this.emitQuasarSignerSeeds(stmt.from, instr, ir);
            lines.push(seedsCode);
            lines.push(
              `    accounts.system_program.transfer(accounts.${snakeCase(stmt.from)}, accounts.${snakeCase(stmt.to)}, ${amount}).invoke_signed(seeds)?;`,
            );
          } else {
            lines.push(
              `    accounts.system_program.transfer(accounts.${snakeCase(stmt.from)}, accounts.${snakeCase(stmt.to)}, ${amount}).invoke()?;`,
            );
          }
          break;
        }

        case "cpi_spl_transfer": {
          this.transformedCount++;
          const amount = this.transformQuasarExpr(stmt.amount, instr, ir);
          const from = snakeCase(stmt.from);
          const to = snakeCase(stmt.to);
          const authority = snakeCase(stmt.authority);
          if (stmt.signerSeeds) {
            const seedsCode = this.emitQuasarSignerSeeds(
              stmt.authority,
              instr,
              ir,
            );
            lines.push(seedsCode);
            lines.push(
              `    accounts.token_program.transfer(accounts.${from}, accounts.${to}, accounts.${authority}, ${amount}).invoke_signed(seeds)?;`,
            );
          } else {
            lines.push(
              `    accounts.token_program.transfer(accounts.${from}, accounts.${to}, accounts.${authority}, ${amount}).invoke()?;`,
            );
          }
          break;
        }

        case "cpi_spl_mint_to": {
          this.transformedCount++;
          const amount = this.transformQuasarExpr(stmt.amount, instr, ir);
          const mint = snakeCase(stmt.mint);
          const to = snakeCase(stmt.to);
          const authority = snakeCase(stmt.authority);
          if (stmt.signerSeeds) {
            const seedsCode = this.emitQuasarSignerSeeds(
              stmt.authority,
              instr,
              ir,
            );
            lines.push(seedsCode);
            lines.push(
              `    accounts.token_program.mint_to(accounts.${mint}, accounts.${to}, accounts.${authority}, ${amount}).invoke_signed(seeds)?;`,
            );
          } else {
            lines.push(
              `    accounts.token_program.mint_to(accounts.${mint}, accounts.${to}, accounts.${authority}, ${amount}).invoke()?;`,
            );
          }
          break;
        }

        case "cpi_spl_burn": {
          this.transformedCount++;
          const amount = this.transformQuasarExpr(stmt.amount, instr, ir);
          const from = snakeCase(stmt.from);
          const mint = snakeCase(stmt.mint);
          const authority = snakeCase(stmt.authority);
          if (stmt.signerSeeds) {
            const seedsCode = this.emitQuasarSignerSeeds(
              stmt.authority,
              instr,
              ir,
            );
            lines.push(seedsCode);
            lines.push(
              `    accounts.token_program.burn(accounts.${from}, accounts.${mint}, accounts.${authority}, ${amount}).invoke_signed(seeds)?;`,
            );
          } else {
            lines.push(
              `    accounts.token_program.burn(accounts.${from}, accounts.${mint}, accounts.${authority}, ${amount}).invoke()?;`,
            );
          }
          break;
        }

        case "cpi_spl_close_account": {
          this.transformedCount++;
          const account = snakeCase(stmt.account);
          const destination = snakeCase(stmt.destination);
          const authority = snakeCase(stmt.authority);
          if (stmt.signerSeeds) {
            const seedsCode = this.emitQuasarSignerSeeds(
              stmt.authority,
              instr,
              ir,
            );
            lines.push(seedsCode);
            lines.push(
              `    accounts.token_program.close_account(accounts.${account}, accounts.${destination}, accounts.${authority}).invoke_signed(seeds)?;`,
            );
          } else {
            lines.push(
              `    accounts.token_program.close_account(accounts.${account}, accounts.${destination}, accounts.${authority}).invoke()?;`,
            );
          }
          break;
        }

        case "cpi_custom": {
          this.transformedCount++;
          this.warnings.push(
            `Custom CPI to '${stmt.programAccount}' -- passed through as raw code. Verify quasar-lang compatibility.`,
          );
          lines.push(
            `    // Anvil: Custom CPI -- verify this works with quasar-lang`,
          );
          lines.push(`    ${stmt.rawCode}`);
          break;
        }

        case "sysvar_clock": {
          this.transformedCount++;
          lines.push(
            `    let ${stmt.localVar} = quasar_lang::prelude::Clock::get()?;`,
          );
          break;
        }

        case "sysvar_rent": {
          this.transformedCount++;
          lines.push(
            `    let ${stmt.localVar} = quasar_lang::prelude::Rent::get()?;`,
          );
          break;
        }

        case "pda_signer_seeds": {
          this.transformedCount++;
          // In quasar multi-file, PDA seeds are emitted inline
          const seedsCode = this.emitQuasarPdaSeeds(stmt.account, stmt.seeds, instr, ir);
          lines.push(seedsCode);
          break;
        }

        case "return_ok": {
          // Auto-close accounts with close constraints
          for (const acc of instr.accounts) {
            const closeConstraint = acc.constraints.find(
              (c) => c.kind === "close" && c.value,
            );
            if (closeConstraint?.value) {
              // Quasar handles close via the #[account(close = X)] constraint
              // automatically, but for token accounts owned by the PDA we need
              // explicit close
              for (const dep of instr.accounts) {
                const tokenAuth = dep.constraints.find(
                  (c) =>
                    c.kind === "token::authority" &&
                    c.value === acc.name,
                );
                if (tokenAuth) {
                  const seedsCode = this.emitQuasarSignerSeeds(
                    acc.name,
                    instr,
                    ir,
                  );
                  lines.push(seedsCode);
                  lines.push(
                    `    accounts.token_program.close_account(accounts.${snakeCase(dep.name)}, accounts.${snakeCase(closeConstraint.value)}, accounts.${snakeCase(acc.name)}).invoke_signed(seeds)?;`,
                  );
                }
              }
            }
          }
          lines.push(`    Ok(())`);
          break;
        }

        case "return_err": {
          this.transformedCount++;
          lines.push(`    return Err(${stmt.error});`);
          break;
        }
      }
    }

    // If body didn't end with Ok(()) or return, add it
    const lastStmt = instr.body[instr.body.length - 1];
    const bodyHasReturn =
      lastStmt?.kind === "return_ok" ||
      (lastStmt?.kind === "pass_through" && lastStmt.code.trim() === "Ok(())");
    if (!bodyHasReturn) {
      lines.push(`    Ok(())`);
    }

    return lines.join("\n");
  }

  private emitQuasarErrorsFile(ir: SolanaIR): string {
    const enumName = this.sourceErrorEnumName(ir);
    const seen = new Set<string>();
    const dedupedErrors = ir.errors.filter((e) => {
      if (seen.has(e.name)) return false;
      seen.add(e.name);
      return true;
    });
    const variants = dedupedErrors
      .map((e) => `    /// ${e.msg}\n    ${e.name} = ${e.code},`)
      .join("\n");

    return `use quasar_lang::prelude::*;

#[derive(Clone, Copy, Debug, PartialEq)]
#[repr(u32)]
pub enum ${enumName} {
${variants}
}

impl From<${enumName}> for ProgramError {
    fn from(error: ${enumName}) -> Self {
        ProgramError::Custom(error as u32)
    }
}`;
  }

  private emitQuasarCargoToml(ir: SolanaIR): string {
    const name = snakeCase(ir.name).replace(/_/g, "-");
    const needsSpl = irNeedsSpl(ir);

    let deps = `[dependencies]
quasar-lang = "0.0"
solana-instruction = { version = "3.2.0" }`;

    if (needsSpl) {
      deps += `\nquasar-spl = "0.0"`;
    }

    return `[package]
name = "${name}"
version = "0.1.0"
edition = "2021"

[workspace]

[lints.rust.unexpected_cfgs]
level = "warn"
check-cfg = [
    'cfg(target_os, values("solana"))',
]

[lib]
crate-type = ["cdylib", "lib"]

[features]
alloc = []
client = []
debug = []

${deps}

[dev-dependencies]
quasar-svm = { version = "0.1" }
`;
  }

  // ── Quasar-specific helpers ────────────────────────────────────────────────

  /** Check if an instruction uses ctx.bumps */
  private instrUsesBumps(instr: Instruction): boolean {
    return instr.body.some(
      (s) =>
        s.kind === "bumps_access" ||
        s.kind === "pda_signer_seeds" ||
        (s.kind === "state_field_assign" &&
          s.value.includes("ctx.bumps")) ||
        (s.kind === "pass_through" && s.code.includes("ctx.bumps")) ||
        (s.kind === "cpi_spl_transfer" && s.signerSeeds != null) ||
        (s.kind === "cpi_spl_mint_to" && s.signerSeeds != null) ||
        (s.kind === "cpi_spl_burn" && s.signerSeeds != null) ||
        (s.kind === "cpi_spl_close_account" && s.signerSeeds != null) ||
        (s.kind === "cpi_system_transfer" && s.signerSeeds != null),
    );
  }

  /** Normalize a PDA seed expression for quasar #[account(seeds = [...])] */
  private normalizeQuasarSeed(seed: string): string {
    let s = seed.trim();
    // Remove ctx.accounts. prefix
    s = s.replace(/ctx\.accounts\./g, "");
    // Convert .key().as_ref() or .key.as_ref() to just the account name
    s = s.replace(/(\w+)\.key\(\)\.as_ref\(\)/g, "$1");
    s = s.replace(/(\w+)\.key\.as_ref\(\)/g, "$1");
    return s;
  }

  /** Map IR type to quasar-lang type for instruction arguments */
  private quasarArgType(typeName: string): string {
    if (typeName === "Pubkey") return "Address";
    return typeName;
  }

  /** Map IR type to quasar-lang type for state struct fields */
  private quasarStateFieldType(typeName: string): string {
    if (typeName === "Pubkey") return "Address";
    // Quasar uses raw numeric types in struct definitions
    return typeName;
  }

  /** Transform a pass-through code block for quasar multi-file */
  private transformQuasarPassThrough(
    code: string,
    instr: Instruction,
    ir: SolanaIR,
  ): string {
    let transformed = code;

    // Transform ctx.accounts.X references
    transformed = transformed.replace(
      /ctx\.accounts\.(\w+)/g,
      (_: string, name: string) => `accounts.${snakeCase(name)}`,
    );

    // Transform ctx.bumps.X references
    transformed = transformed.replace(
      /ctx\.bumps\.(\w+)/g,
      (_: string, name: string) => `bumps.${snakeCase(name)}`,
    );

    // Transform .key() to .address() for quasar
    transformed = transformed.replace(
      /accounts\.(\w+)\.key\(\)/g,
      "accounts.$1.address()",
    );

    // Transform require! macros that leaked through
    const requireMatch = transformed.match(
      /^require!\(([\s\S]+),\s*([\w:]+(?:::\w+)*)\s*\);?$/,
    );
    if (requireMatch?.[1] && requireMatch[2]) {
      return `require!(${requireMatch[1].trim()}, ${requireMatch[2]});`;
    }

    // Transform msg! to log
    transformed = transformed.replace(
      /msg!\(([^)]+)\)/g,
      "log($1)",
    );

    // Transform .to_account_info() — not needed in quasar
    transformed = transformed.replace(/\.to_account_info\(\)/g, "");

    // Transform .to_account_view() for close operations
    // In quasar, signers need .to_account_view() for close
    // Leave this as-is since quasar uses it

    // Transform error! macro
    transformed = transformed.replace(
      /error!\s*\(\s*([^)]+)\s*\)/g,
      "ProgramError::from($1)",
    );

    return transformed;
  }

  /** Transform an expression for quasar multi-file */
  private transformQuasarExpr(
    expr: string,
    instr: Instruction,
    _ir: SolanaIR,
  ): string {
    let transformed = expr;

    // Transform ctx.accounts.X references
    transformed = transformed.replace(
      /ctx\.accounts\.(\w+)/g,
      (_: string, name: string) => `accounts.${snakeCase(name)}`,
    );

    // Transform ctx.bumps.X references
    transformed = transformed.replace(
      /ctx\.bumps\.(\w+)/g,
      (_: string, name: string) => `bumps.${snakeCase(name)}`,
    );

    // Transform .key() to *X.address()
    transformed = transformed.replace(
      /(\w+)\.key\(\)/g,
      (_: string, name: string) => {
        const isAccount = instr.accounts.some(
          (a) => snakeCase(a.name) === snakeCase(name),
        );
        if (isAccount) return `*accounts.${snakeCase(name)}.address()`;
        return `${name}.key()`;
      },
    );

    // Transform .amount references for token accounts
    transformed = transformed.replace(
      /(\w+)\.amount\b/g,
      (_: string, name: string) => {
        const acc = instr.accounts.find(
          (a) => snakeCase(a.name) === snakeCase(name),
        );
        if (
          acc &&
          (acc.accountType === "TokenAccount" ||
            acc.constraints.some(
              (c) =>
                c.kind.startsWith("token::") ||
                c.kind.startsWith("associated_token::"),
            ))
        ) {
          return `accounts.${snakeCase(name)}.amount()`;
        }
        return `${name}.amount`;
      },
    );

    return transformed;
  }

  /** Prefix account name references with accounts. for quasar handler */
  private prefixAccountRefs(code: string, instr: Instruction): string {
    let transformed = code;
    for (const acc of instr.accounts) {
      const name = snakeCase(acc.name);
      // Only prefix standalone references, not already-prefixed ones
      transformed = transformed.replace(
        new RegExp(`(?<!accounts\\.)\\b${name}\\b(?!\\s*:)`, "g"),
        `accounts.${name}`,
      );
    }
    return transformed;
  }

  /** Emit quasar-style PDA signer seeds using Seed::from */
  private emitQuasarSignerSeeds(
    accountName: string,
    instr: Instruction,
    ir: SolanaIR,
  ): string {
    const normalized = snakeCase(accountName);
    const accRef = instr.accounts.find(
      (a) => snakeCase(a.name) === normalized,
    );

    if (!accRef?.isPda || accRef.pdaSeeds.length === 0) {
      return `    // Anvil: could not determine PDA seeds for '${normalized}'`;
    }

    const stateAcc = ir.accounts.find((a) => a.name === accRef.accountType);
    const hasBumpField = stateAcc?.fields.some((f) => f.name === "bump");

    const lines: string[] = [];

    // Emit any key captures needed by seeds
    for (const seed of accRef.pdaSeeds) {
      const keyMatch = seed.match(
        /(?:ctx\.accounts\.)?(\w+)\.key(?:\(\))?\.as_ref\(\)/,
      );
      if (keyMatch?.[1]) {
        const name = snakeCase(keyMatch[1]);
        lines.push(
          `    let ${name}_key = *accounts.${name}.address();`,
        );
      }
    }

    // Get bump value
    if (hasBumpField) {
      lines.push(
        `    let bump = [accounts.${normalized}.bump];`,
      );
    } else {
      lines.push(`    let bump = [bumps.${normalized}];`);
    }

    // Build seed expressions
    const seedExprs: string[] = [];
    for (const seed of accRef.pdaSeeds) {
      if (seed.startsWith('b"') || seed.startsWith("b'")) {
        seedExprs.push(`Seed::from(${seed} as &[u8])`);
      } else {
        const keyMatch = seed.match(
          /(?:ctx\.accounts\.)?(\w+)\.key(?:\(\))?\.as_ref\(\)/,
        );
        if (keyMatch?.[1]) {
          seedExprs.push(
            `Seed::from(${snakeCase(keyMatch[1])}_key.as_ref())`,
          );
        } else {
          // Generic seed — try to convert
          let normalized_seed = seed
            .replace(/ctx\.accounts\./g, "accounts.")
            .replace(/\.as_ref\(\)/g, "");
          seedExprs.push(`Seed::from(${normalized_seed}.as_ref())`);
        }
      }
    }
    seedExprs.push(`Seed::from(&bump as &[u8])`);

    lines.push(`    let seeds: &[Seed] = &[`);
    for (const expr of seedExprs) {
      lines.push(`        ${expr},`);
    }
    lines.push(`    ];`);

    return lines.join("\n");
  }

  /** Emit quasar-style PDA seeds for pda_signer_seeds body statement */
  private emitQuasarPdaSeeds(
    accountName: string,
    seeds: string[],
    instr: Instruction,
    ir: SolanaIR,
  ): string {
    // Delegate to the shared signer seeds helper
    return this.emitQuasarSignerSeeds(accountName, instr, ir);
  }

  // ── Single-file output methods (for base emitter's emitSingleFile) ────────
  // These use pinocchio-compatible types for the manual entrypoint approach.

  override emitUseStatements(_ir: SolanaIR): string {
    const imports = [
      `use core::convert::TryInto;`,
      `use borsh::{BorshDeserialize, BorshSerialize};`,
      `use pinocchio::{
    account_info::AccountInfo,
    entrypoint,
    program_error::ProgramError,
    pubkey::Pubkey,
    ProgramResult,
};`,
    ];

    if (irNeedsHelper(_ir, "transfer_lamports")) {
      imports.push(
        `use pinocchio_system::instructions::Transfer as SystemTransfer;`,
      );
    }

    const needsSeedSigner =
      irNeedsInitAccountHelper(_ir) ||
      irNeedsSignedLamportsHelper(_ir) ||
      irNeedsSignedSplMintToHelper(_ir) ||
      irNeedsSignedSplBurnHelper(_ir) ||
      irNeedsSignedSplCloseAccountHelper(_ir) ||
      irNeedsHelper(_ir, "spl_transfer");
    if (needsSeedSigner) {
      imports.push(`use pinocchio::instruction::{Seed, Signer};`);
    }
    if (irNeedsInitAccountHelper(_ir)) {
      imports.push(
        `use pinocchio_system::create_account_with_minimum_balance_signed;`,
      );
    }

    if (
      irNeedsHelper(_ir, "spl_transfer") ||
      irNeedsHelper(_ir, "spl_mint_to") ||
      irNeedsHelper(_ir, "spl_burn")
    ) {
      imports.push(
        `use pinocchio_token::instructions::Transfer as TokenTransfer;`,
      );
    }
    if (irNeedsHelper(_ir, "spl_mint_to")) {
      imports.push(
        `use pinocchio_token::instructions::MintTo as TokenMintTo;`,
      );
    }
    if (irNeedsHelper(_ir, "spl_burn")) {
      imports.push(
        `use pinocchio_token::instructions::Burn as TokenBurn;`,
      );
    }
    if (irNeedsHelper(_ir, "spl_close_account")) {
      imports.push(
        `use pinocchio_token::instructions::CloseAccount as TokenCloseAccount;`,
      );
    }
    if (irNeedsToken2022Helper(_ir)) {
      imports.push(
        `// Token-2022: same instruction structs, routed to token_2022 program at runtime`,
      );
      imports.push(
        `use pinocchio_token::instructions::TransferChecked as Token2022TransferChecked;`,
      );
    }
    if (irNeedsAtaCreationHelper(_ir)) {
      imports.push(
        `use pinocchio_associated_token_account::instructions::Create as CreateAssociatedToken;`,
      );
    }

    imports.push(...this.filteredSourceImports(_ir));

    return imports.join("\n");
  }

  override emitEntrypoint(_ir: SolanaIR): string {
    return `entrypoint!(process_instruction);

pub fn process_instruction(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    instruction_data: &[u8],
) -> ProgramResult {
    if instruction_data.len() < 8 {
        return Err(ProgramError::InvalidInstructionData);
    }

    let (discriminator, data) = instruction_data.split_at(8);
    router(program_id, accounts, discriminator, data)
}`;
  }

  override emitRouter(ir: SolanaIR): string {
    const arms = ir.instructions
      .map(
        (instr) =>
          `        ${instrDiscriminator(instr.name)} => ${snakeCase(instr.name)}(program_id, accounts, data),`,
      )
      .join("\n");

    return `fn router(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    discriminator: &[u8],
    data: &[u8],
) -> ProgramResult {
    match discriminator {
${arms}
        _ => Err(ProgramError::InvalidInstructionData),
    }
}`;
  }

  override emitAccountBinding(name: string, index: number): string {
    return `    let ${name} = &accounts[${index}];`;
  }

  override emitSignerCheck(name: string): string {
    return `    if !${name}.is_signer() {
        return Err(ProgramError::MissingRequiredSignature);
    }`;
  }

  override emitOwnerCheck(name: string): string {
    return `    if ${name}.owner() != program_id {
        return Err(ProgramError::IncorrectProgramId);
    }`;
  }

  override emitWritableCheck(names: string[]): string {
    const checks = names.map((n) => `!${n}.is_writable()`).join(" || ");
    return `    if ${checks} {
        return Err(ProgramError::InvalidAccountData);
    }`;
  }

  override emitAccountKeyExpr(accountName: string): string {
    return `*${accountName}.key()`;
  }

  override emitAccountKeyAsRefExpr(accountName: string): string {
    return `${accountName}.key().as_ref()`;
  }

  override emitAccountLamportsExpr(accountName: string): string {
    return `${accountName}.lamports()`;
  }

  override emitStateRead(
    accountName: string,
    typeName: string,
    localVar: string,
    mutable: boolean,
  ): string {
    const mutKeyword = mutable ? "mut " : "";
    return `    let ${mutKeyword}${localVar} = ${typeName}::from_account_info(${accountName})?;`;
  }

  override emitStateSave(
    accountName: string,
    typeName: string,
    localVar: string,
  ): string {
    return `    ${typeName}::save(${accountName}, &${localVar})?;`;
  }

  override emitBumpSeed(
    _programId: string,
    seeds: string[],
    expectedKey: string,
  ): string {
    const prelude: string[] = [];
    let tempCount = 0;
    const transformedSeeds = seeds.map((seed) => {
      const bytesMatch = seed.match(/^&(.*)\.to_le_bytes\(\)$/);
      if (bytesMatch?.[1]) {
        const varName =
          tempCount === 0 ? "seed_bytes" : `seed_bytes_${tempCount + 1}`;
        tempCount++;
        prelude.push(
          `    let ${varName} = ${bytesMatch[1].trim()}.to_le_bytes();`,
        );
        return `&${varName}`;
      }
      const match = seed.match(/^(.*)\.to_le_bytes\(\)\.as_ref\(\)$/);
      if (!match?.[1]) return seed;
      const varName =
        tempCount === 0 ? "seed_bytes" : `seed_bytes_${tempCount + 1}`;
      tempCount++;
      prelude.push(
        `    let ${varName} = ${match[1].trim()}.to_le_bytes();`,
      );
      return `${varName}.as_ref()`;
    });
    const seedsStr = transformedSeeds.map((s) => `${s}`).join(", ");
    const bumpLine = `    let bump = bump_seed(program_id, &[${seedsStr}], ${expectedKey}.key())?;`;
    return prelude.length > 0
      ? `${prelude.join("\n")}\n${bumpLine}`
      : bumpLine;
  }

  override emitSystemTransfer(
    from: string,
    to: string,
    amount: string,
    signerSeeds?: string,
  ): string {
    if (signerSeeds) {
      return `    // System transfer with PDA signer
    transfer_lamports_signed(${from}, ${to}, ${amount}, ${signerSeeds})?;`;
    }
    return `    transfer_lamports(${from}, ${to}, ${amount})?;`;
  }

  override emitSplTransfer(
    from: string,
    to: string,
    authority: string,
    amount: string,
    signerSeeds?: string,
  ): string {
    if (signerSeeds) {
      return `    // SPL Token transfer (PDA signed)
    spl_token_transfer_signed(${from}, ${to}, ${authority}, ${amount}, ${signerSeeds})?;`;
    }
    return `    // SPL Token transfer
    spl_token_transfer(${from}, ${to}, ${authority}, ${amount})?;`;
  }

  override emitSplMintTo(
    mint: string,
    to: string,
    authority: string,
    amount: string,
    signerSeeds?: string,
  ): string {
    const signed = signerSeeds ? "_signed" : "";
    return `    // SPL Token mint_to
    spl_token_mint_to${signed}(${mint}, ${to}, ${authority}, ${amount}${signerSeeds ? `, ${signerSeeds}` : ""})?;`;
  }

  override emitSplBurn(
    from: string,
    mint: string,
    authority: string,
    amount: string,
    signerSeeds?: string,
  ): string {
    const signed = signerSeeds ? "_signed" : "";
    return `    // SPL Token burn
    spl_token_burn${signed}(${from}, ${mint}, ${authority}, ${amount}${signerSeeds ? `, ${signerSeeds}` : ""})?;`;
  }

  override emitSplCloseAccount(
    account: string,
    destination: string,
    authority: string,
    signerSeeds?: string,
  ): string {
    const signed = signerSeeds ? "_signed" : "";
    return `    // SPL Token close account
    spl_token_close_account${signed}(${account}, ${destination}, ${authority}${signerSeeds ? `, ${signerSeeds}` : ""})?;`;
  }

  override emitProgramAccountClose(
    account: string,
    destination: string,
  ): string {
    return `    close_program_account(${account}, ${destination})?;`;
  }

  override emitCreateProgramAccount(
    account: string,
    payer: string,
    spaceExpr: string,
    signerSeeds?: string,
  ): string {
    return `    create_program_account(${account}, ${payer}, (${spaceExpr}) as u64, program_id, ${signerSeeds ?? "&[]"})?;`;
  }

  override emitCreateAta(
    ata: string,
    payer: string,
    mint: string,
    authority: string,
    _signerSeeds?: string,
  ): string {
    return `    // Create Associated Token Account: ${ata}
    CreateAssociatedToken {
        funding_account: ${payer},
        associated_account: ${ata},
        wallet_address: ${authority},
        token_mint: ${mint},
    }
    .invoke()?;`;
  }

  override emitPdaSignerSeeds(
    account: string,
    accountInfoVar: string,
    seeds: string[],
    _bumpField?: string,
    stateVar?: string,
    typeName?: string,
  ): string {
    const dataVar = stateVar || `${account}_data`;
    const rewritePrefix = stateVar ? account : undefined;
    const shouldReadState =
      !!typeName &&
      !!this.currentIr?.accounts.find((acc) => acc.name === typeName);
    const resolvedTypeName =
      typeName ||
      account.charAt(0).toUpperCase() +
        account
          .slice(1)
          .replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());

    const prelude: string[] = [];
    let tempCount = 0;
    const transformedSeeds = seeds.map((seed) => {
      if (seed.startsWith('b"') || seed.startsWith("b'")) return seed;
      const bytesMatch = seed.match(/^&(.+)\.to_le_bytes\(\)$/);
      if (bytesMatch?.[1]) {
        const varName =
          tempCount === 0 ? "seed_bytes" : `seed_bytes_${tempCount + 1}`;
        tempCount++;
        prelude.push(
          `    let ${varName} = ${bytesMatch[1].trim()}.to_le_bytes();`,
        );
        return `&${varName}`;
      }
      const asRefMatch = seed.match(/^(.*)\.to_le_bytes\(\)\.as_ref\(\)$/);
      if (asRefMatch?.[1]) {
        const varName =
          tempCount === 0 ? "seed_bytes" : `seed_bytes_${tempCount + 1}`;
        tempCount++;
        prelude.push(
          `    let ${varName} = ${asRefMatch[1].trim()}.to_le_bytes();`,
        );
        return `${varName}.as_ref()`;
      }
      const keyAsRefMatch = seed.match(/^(\w+)\.key\(\)\.as_ref\(\)$/);
      if (keyAsRefMatch?.[1]) {
        const name = keyAsRefMatch[1];
        if (name.endsWith("_account"))
          return `${name}.key().as_ref()`;
        if (name === account) return `${accountInfoVar}.key().as_ref()`;
        if (stateVar && name === stateVar)
          return `${accountInfoVar}.key().as_ref()`;
        return `${name}_account.key().as_ref()`;
      }
      const keyFieldAsRefMatch = seed.match(/^(\w+)\.key\.as_ref\(\)$/);
      if (keyFieldAsRefMatch?.[1]) {
        const name = keyFieldAsRefMatch[1];
        if (name.endsWith("_account"))
          return `${name}.key().as_ref()`;
        if (name === account) return `${accountInfoVar}.key().as_ref()`;
        if (stateVar && name === stateVar)
          return `${accountInfoVar}.key().as_ref()`;
        return `${name}_account.key().as_ref()`;
      }
      if (rewritePrefix && seed.startsWith("&[")) {
        return seed.replace(
          new RegExp(`&\\[${rewritePrefix}\\.`),
          `&[${dataVar}.`,
        );
      }
      if (rewritePrefix) {
        return seed.replace(
          new RegExp(`^${rewritePrefix}\\.`),
          `${dataVar}.`,
        );
      }
      return seed;
    });

    const seedsStr = transformedSeeds.join(",\n            ");
    const maybeRead =
      stateVar || !shouldReadState
        ? ""
        : `    let ${dataVar} = ${resolvedTypeName}::from_account_info(${accountInfoVar})?;\n`;
    return `    // PDA signer seeds for '${account}'
${maybeRead}${prelude.length > 0 ? `${prelude.join("\n")}\n` : ""}    let seeds = &[
            ${seedsStr},
        ];
    let signer_seeds = &[&seeds[..]];`;
  }

  override emitRequire(condition: string, error: string): string {
    return emitRequireGuard(condition, error);
  }

  override emitMsg(message: string): string {
    const literalMatch = message.match(/^"([^"\\]|\\.)*"/);
    if (literalMatch?.[0]) {
      const literal = literalMatch[0];
      if (literal !== message.trim()) {
        return `    // Anvil: formatted msg!() collapsed to static log\n    pinocchio::msg!(${literal});`;
      }
    }
    const commaIdx = message.indexOf(",");
    if (commaIdx !== -1) {
      const literal = message.slice(0, commaIdx).trim();
      return `    // Anvil: formatted msg!() collapsed to static log\n    pinocchio::msg!(${literal});`;
    }
    return `    pinocchio::msg!(${message});`;
  }

  override emitEmit(event: string, fields: string): string {
    if (!fields.trim()) {
      return `    pinocchio::msg!("event:${event}");`;
    }
    return `    // Event: ${event}
    pinocchio::msg!("event:${event}");
    // Event data: ${fields.replace(/\n/g, " ")}`;
  }

  override emitClockGet(localVar: string): string {
    return `    let ${localVar} = pinocchio::sysvars::clock::Clock::get()?;`;
  }

  override emitRentGet(localVar: string): string {
    return `    let ${localVar} = pinocchio::sysvars::rent::Rent::get()?;`;
  }

  override rustTypeForFramework(typeName: string): string {
    // In single-file mode, use pinocchio types (Pubkey = [u8; 32])
    if (typeName === "Pubkey") return "[u8; 32]";
    if (typeName === "String") return "[u8; 64]";
    return typeName;
  }

  protected override emitPubkeyDeserialize(
    start: number,
    end: number,
  ): string {
    return `data[${start}..${end}].try_into().map_err(|_| ProgramError::InvalidInstructionData)?`;
  }

  protected override emitPubkeyDeserializeSlice(sliceExpr: string): string {
    return `${sliceExpr}.try_into().map_err(|_| ProgramError::InvalidInstructionData)?`;
  }

  protected override emitPubkeyFieldRead(_size: number): string {
    return `data[offset..offset + 32].try_into().map_err(|_| ProgramError::InvalidAccountData)?`;
  }

  override emitAccountStruct(acc: AccountDef): string {
    // Single-file: manual byte-layout serialization (pinocchio-compatible)
    const fields = acc.fields
      .map(
        (f) =>
          `    pub ${snakeCase(f.name)}: ${this.rustTypeForFramework(f.type)},`,
      )
      .join("\n");
    const bodyLen = acc.fields.reduce(
      (s, f) => s + this.resolveTypeSize(f.type),
      0,
    );
    const readLines = this.buildReadLines(acc);
    const writeLines = this.buildWriteLines(acc);
    const ctorFields = acc.fields.map((f) => snakeCase(f.name)).join(", ");

    return `#[repr(C)]
pub struct ${acc.name} {
${fields}
}

impl ${acc.name} {
    pub const DISCRIMINATOR: [u8; 8] = ${accountDiscriminator(acc.name)};
    pub const INIT_SPACE: usize = ${bodyLen};
    pub const LEN: usize = ${bodyLen};
    pub const TOTAL_LEN: usize = 8 + Self::LEN;
    pub const SPACE: usize = Self::TOTAL_LEN;

    pub fn read(data: &[u8]) -> Result<Self, ProgramError> {
        if data.len() < Self::TOTAL_LEN {
            return Err(ProgramError::InvalidAccountData);
        }
        if data[..8] != Self::DISCRIMINATOR {
            return Err(ProgramError::InvalidAccountData);
        }
        let mut offset = 8usize;
${readLines}
        Ok(Self { ${ctorFields} })
    }

    pub fn write(data: &mut [u8], value: &Self) -> Result<(), ProgramError> {
        if data.len() < Self::TOTAL_LEN {
            return Err(ProgramError::InvalidAccountData);
        }
        data[..8].copy_from_slice(&Self::DISCRIMINATOR);
        let mut offset = 8usize;
${writeLines}
        Ok(())
    }

    pub fn from_account_info(account: &AccountInfo) -> Result<Self, ProgramError> {
        let data = account.borrow_data_unchecked();
        Self::read(data)
    }

    pub fn save(account: &AccountInfo, value: &Self) -> Result<(), ProgramError> {
        let mut data = account.borrow_mut_data_unchecked();
        Self::write(&mut data, value)
    }
}`;
  }

  override emitErrorEnum(ir: SolanaIR): string {
    const seen = new Set<string>();
    const dedupedErrors = ir.errors.filter((e) => {
      if (seen.has(e.name)) return false;
      seen.add(e.name);
      return true;
    });
    const variants = dedupedErrors
      .map((e) => `    /// ${e.msg}\n    ${e.name} = ${e.code},`)
      .join("\n");

    const enumName = this.sourceErrorEnumName(ir);

    return `#[derive(Clone, Copy, Debug, PartialEq)]
#[repr(u32)]
pub enum ${enumName} {
${variants}
}

impl From<${enumName}> for ProgramError {
    fn from(error: ${enumName}) -> Self {
        ProgramError::Custom(error as u32)
    }
}`;
  }

  override emitHelperFunctions(ir: SolanaIR): string {
    // Single-file helpers use pinocchio types
    const helpers: string[] = [];

    helpers.push(`fn bump_seed(
    program_id: &Pubkey,
    seeds: &[&[u8]],
    expected: &Pubkey,
) -> Result<u8, ProgramError> {
    let (derived, bump) = Pubkey::find_program_address(seeds, program_id);
    if &derived != expected {
        return Err(ProgramError::InvalidSeeds);
    }
    Ok(bump)
}`);

    if (irNeedsInitAccountHelper(ir)) {
      helpers.push(`fn create_program_account<'a>(
    account: &'a AccountInfo,
    payer: &'a AccountInfo,
    space: u64,
    program_id: &Pubkey,
    signer_seeds: &[&[&[u8]]],
) -> ProgramResult {
    let signer = signer_seeds
        .iter()
        .map(|seeds| seeds.iter().map(|s| Seed::from(*s)).collect::<Vec<_>>())
        .collect::<Vec<_>>();
    let signers: Vec<Signer> = signer.iter().map(|s| Signer::from(s.as_slice())).collect();
    create_account_with_minimum_balance_signed(payer, account, space, program_id, &signers)
}`);
    }

    if (irNeedsUnsignedLamportsHelper(ir)) {
      helpers.push(`fn transfer_lamports(
    from: &AccountInfo,
    to: &AccountInfo,
    amount: u64,
) -> ProgramResult {
    if from.key() == to.key() {
        return Err(ProgramError::InvalidAccountData);
    }
    unsafe {
        *from.borrow_mut_lamports_unchecked() = from
            .lamports()
            .checked_sub(amount)
            .ok_or(ProgramError::InsufficientFunds)?;
        *to.borrow_mut_lamports_unchecked() = to
            .lamports()
            .checked_add(amount)
            .ok_or(ProgramError::ArithmeticOverflow)?;
    }
    Ok(())
}`);
    }

    if (irNeedsSignedLamportsHelper(ir)) {
      helpers.push(`fn transfer_lamports_signed(
    from: &AccountInfo,
    to: &AccountInfo,
    amount: u64,
    _signer_seeds: &[&[&[u8]]],
) -> ProgramResult {
    if from.key() == to.key() {
        return Err(ProgramError::InvalidAccountData);
    }
    unsafe {
        *from.borrow_mut_lamports_unchecked() = from
            .lamports()
            .checked_sub(amount)
            .ok_or(ProgramError::InsufficientFunds)?;
        *to.borrow_mut_lamports_unchecked() = to
            .lamports()
            .checked_add(amount)
            .ok_or(ProgramError::ArithmeticOverflow)?;
    }
    Ok(())
}`);
    }

    if (irNeedsHelper(ir, "spl_transfer")) {
      helpers.push(`fn spl_token_transfer(
    from: &AccountInfo,
    to: &AccountInfo,
    authority: &AccountInfo,
    amount: u64,
) -> ProgramResult {
    TokenTransfer {
        from,
        to,
        authority,
        amount,
    }
    .invoke()
}

fn spl_token_transfer_signed(
    from: &AccountInfo,
    to: &AccountInfo,
    authority: &AccountInfo,
    amount: u64,
    signer_seeds: &[&[&[u8]]],
) -> ProgramResult {
    TokenTransfer {
        from,
        to,
        authority,
        amount,
    }
    .invoke_signed(signer_seeds)
}`);
    }

    const needsUnsignedMintTo = irNeedsUnsignedSplMintToHelper(ir);
    const needsSignedMintTo = irNeedsSignedSplMintToHelper(ir);
    if (needsUnsignedMintTo) {
      helpers.push(`fn spl_token_mint_to(
    mint: &AccountInfo,
    to: &AccountInfo,
    authority: &AccountInfo,
    amount: u64,
) -> ProgramResult {
    TokenMintTo {
        mint,
        to,
        authority,
        amount,
    }
    .invoke()
}`);
    }
    if (needsSignedMintTo) {
      helpers.push(`fn spl_token_mint_to_signed(
    mint: &AccountInfo,
    to: &AccountInfo,
    authority: &AccountInfo,
    amount: u64,
    signer_seeds: &[&[&[u8]]],
) -> ProgramResult {
    TokenMintTo {
        mint,
        to,
        authority,
        amount,
    }
    .invoke_signed(signer_seeds)
}`);
    }

    const needsUnsignedBurn = irNeedsUnsignedSplBurnHelper(ir);
    const needsSignedBurn = irNeedsSignedSplBurnHelper(ir);
    if (needsUnsignedBurn) {
      helpers.push(`fn spl_token_burn(
    from: &AccountInfo,
    mint: &AccountInfo,
    authority: &AccountInfo,
    amount: u64,
) -> ProgramResult {
    TokenBurn {
        from,
        mint,
        authority,
        amount,
    }
    .invoke()
}`);
    }
    if (needsSignedBurn) {
      helpers.push(`fn spl_token_burn_signed(
    from: &AccountInfo,
    mint: &AccountInfo,
    authority: &AccountInfo,
    amount: u64,
    signer_seeds: &[&[&[u8]]],
) -> ProgramResult {
    TokenBurn {
        from,
        mint,
        authority,
        amount,
    }
    .invoke_signed(signer_seeds)
}`);
    }

    const needsUnsignedCloseHelper = irNeedsUnsignedSplCloseAccountHelper(ir);
    const needsSignedCloseHelper = irNeedsSignedSplCloseAccountHelper(ir);
    if (needsUnsignedCloseHelper) {
      helpers.push(`fn spl_token_close_account(
    account: &AccountInfo,
    destination: &AccountInfo,
    authority: &AccountInfo,
) -> ProgramResult {
    TokenCloseAccount {
        account,
        destination,
        authority,
    }
    .invoke()
}`);
    }

    if (needsSignedCloseHelper) {
      helpers.push(`fn spl_token_close_account_signed(
    account: &AccountInfo,
    destination: &AccountInfo,
    authority: &AccountInfo,
    signer_seeds: &[&[&[u8]]],
) -> ProgramResult {
    TokenCloseAccount {
        account,
        destination,
        authority,
    }
    .invoke_signed(signer_seeds)
}`);
    }

    if (irNeedsHelper(ir, "close_program_account")) {
      helpers.push(`fn close_program_account(
    account: &AccountInfo,
    destination: &AccountInfo,
) -> ProgramResult {
    if account.key() == destination.key() {
        return Err(ProgramError::InvalidAccountData);
    }
    let lamports = account.lamports();
    unsafe {
        *destination.borrow_mut_lamports_unchecked() = destination
            .lamports()
            .checked_add(lamports)
            .ok_or(ProgramError::ArithmeticOverflow)?;
        *account.borrow_mut_lamports_unchecked() = 0;
    }
    account.borrow_mut_data_unchecked().fill(0);
    Ok(())
}`);
    }

    if (irNeedsTokenAmountHelper(ir)) {
      helpers.push(`/// Read the amount field from an SPL Token Account (offset 64, 8 bytes LE u64)
fn token_account_amount(account: &AccountInfo) -> Result<u64, ProgramError> {
    let data = account.borrow_data_unchecked();
    if data.len() < 72 {
        return Err(ProgramError::InvalidAccountData);
    }
    Ok(u64::from_le_bytes(
        data[64..72]
            .try_into()
            .map_err(|_| ProgramError::InvalidAccountData)?
    ))
}`);
    }

    return helpers.join("\n\n");
  }
}

const emitter = new QuasarEmitter();

export function emitQuasar(ir: SolanaIR): string {
  return emitter.emit(ir).singleFile;
}

export function emitQuasarFull(ir: SolanaIR) {
  return emitter.emit(ir);
}

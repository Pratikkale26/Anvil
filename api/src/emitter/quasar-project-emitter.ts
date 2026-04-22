/**
 * Quasar Project Emitter — Multi-file quasar-lang project generation.
 *
 * Generates a proper quasar-lang project structure with:
 *   - lib.rs (#[program] macro, module declarations, declare_id!)
 *   - state.rs (#[account] macro for program-owned accounts)
 *   - instructions/<name>.rs (#[derive(Accounts)] + handler functions)
 *   - errors.rs (custom error enum)
 *   - Cargo.toml (workspace configuration)
 *
 * This module is consumed by QuasarEmitter to produce multi-file output.
 */

import type {
  SolanaIR,
  Instruction,
  EmitterFile,
} from "../ir/schema.js";
import {
  snakeCase,
  toPascalCase,
  isProgramAccount,
} from "./emitter-utils.js";
import {
  irNeedsHelper,
  irNeedsUnsignedSplMintToHelper,
  irNeedsSignedSplMintToHelper,
  irNeedsUnsignedSplBurnHelper,
  irNeedsSignedSplBurnHelper,
  irNeedsSignedSplCloseAccountHelper,
  irNeedsUnsignedSplCloseAccountHelper,
} from "./emitter-helpers.js";

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Does the IR use any SPL token operations? */
export function irNeedsSpl(ir: SolanaIR): boolean {
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
export function quasarAccountType(
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

// ─── QuasarProjectEmitter ────────────────────────────────────────────────────

/**
 * Interface for the QuasarEmitter methods that the project emitter needs
 * to call back into (type mapping, expression transforms, etc.).
 */
export interface QuasarEmitterBridge {
  quasarArgType(typeName: string): string;
  quasarStateFieldType(typeName: string): string;
  filteredSourceImports(ir: SolanaIR): string[];
  emitCustomTypes(ir: SolanaIR): string;
  sourceErrorEnumName(ir: SolanaIR): string;
  instrUsesBumps(instr: Instruction): boolean;
  normalizeQuasarSeed(seed: string): string;
  transformQuasarPassThrough(code: string, instr: Instruction, ir: SolanaIR): string;
  transformQuasarExpr(expr: string, instr: Instruction, ir: SolanaIR): string;
  prefixAccountRefs(code: string, instr: Instruction): string;
  emitQuasarSignerSeeds(accountName: string, instr: Instruction, ir: SolanaIR): string;
  /** Tracking counters */
  transformedCount: number;
  passedThroughCount: number;
  warnings: string[];
}

/**
 * Generate all multi-file output for a quasar-lang project.
 */
export function emitQuasarProjectFiles(
  ir: SolanaIR,
  bridge: QuasarEmitterBridge,
): EmitterFile[] {
  const files: EmitterFile[] = [];

  // lib.rs
  files.push({ path: "lib.rs", content: emitQuasarLibFile(ir, bridge) });

  // state.rs
  if (ir.accounts.length > 0) {
    files.push({ path: "state.rs", content: emitQuasarStateFile(ir, bridge) });
  }

  // instructions/
  if (ir.instructions.length > 0) {
    files.push({
      path: "instructions/mod.rs",
      content: emitQuasarInstrModFile(ir),
    });
    for (const instr of ir.instructions) {
      files.push({
        path: `instructions/${snakeCase(instr.name)}.rs`,
        content: emitQuasarInstrFile(instr, ir, bridge),
      });
    }
  }

  // errors.rs
  if (ir.errors.length > 0) {
    files.push({
      path: "errors.rs",
      content: emitQuasarErrorsFile(ir, bridge),
    });
  }

  // Cargo.toml
  files.push({
    path: "Cargo.toml",
    content: emitQuasarCargoToml(ir),
  });

  return files;
}

// ─── File generators ─────────────────────────────────────────────────────────

function emitQuasarLibFile(ir: SolanaIR, bridge: QuasarEmitterBridge): string {
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
  const sourceImports = bridge.filteredSourceImports(ir);
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
    sections.push(bridge.emitCustomTypes({ ...ir, types }));
  }

  // declare_id! + #[program] block
  sections.push(`declare_id!("${ir.programId ?? "11111111111111111111111111111111111111111111"}");`);

  const instrFns = ir.instructions
    .map((instr, idx) => {
      const name = snakeCase(instr.name);
      const accountsStructName = toPascalCase(instr.name);

      // Build argument list
      const args = instr.args.map(
        (arg) => `${snakeCase(arg.name)}: ${bridge.quasarArgType(arg.type)}`,
      );
      const allArgs = [`ctx: Ctx<${accountsStructName}>`, ...args].join(
        ", ",
      );

      // Build handler call arguments
      const handlerArgs: string[] = [`&mut ctx.accounts`];

      // Add instruction args (pass by value or reference depending on type)
      for (const arg of instr.args) {
        const argName = snakeCase(arg.name);
        handlerArgs.push(argName);
      }

      // Check if instruction uses bumps
      const usesBumps = bridge.instrUsesBumps(instr);
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

function emitQuasarStateFile(ir: SolanaIR, bridge: QuasarEmitterBridge): string {
  const sections: string[] = [];
  sections.push(`use quasar_lang::prelude::*;`);

  for (const [idx, acc] of ir.accounts.entries()) {
    const fields = acc.fields
      .map(
        (f) =>
          `    pub ${snakeCase(f.name)}: ${bridge.quasarStateFieldType(f.type)},`,
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

function emitQuasarInstrModFile(ir: SolanaIR): string {
  const mods = ir.instructions
    .map((i) => {
      const name = snakeCase(i.name);
      return `pub mod ${name};\npub use ${name}::*;`;
    })
    .join("\n\n");
  return `${mods}\n`;
}

function emitQuasarInstrFile(
  instr: Instruction,
  ir: SolanaIR,
  bridge: QuasarEmitterBridge,
): string {
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
    const enumName = bridge.sourceErrorEnumName(ir);
    imports.push(`crate::errors::${enumName}`);
  }

  if (imports.length === 1) {
    sections.push(`use ${imports[0]};`);
  } else {
    sections.push(`use {\n${imports.map((i) => `    ${i},`).join("\n")}\n};`);
  }

  // #[derive(Accounts)] struct
  sections.push(emitQuasarAccountsStruct(instr, ir, bridge));

  // Handler function
  sections.push(emitQuasarHandler(instr, ir, bridge));

  return sections.join("\n\n");
}

function emitQuasarAccountsStruct(
  instr: Instruction,
  ir: SolanaIR,
  bridge: QuasarEmitterBridge,
): string {
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
      constraints.push("init_if_needed");
    }
    if (acc.initPayer) constraints.push(`payer = ${snakeCase(acc.initPayer)}`);
    // Seeds
    if (acc.isPda && acc.pdaSeeds.length > 0) {
      const seeds = acc.pdaSeeds.map((s) => bridge.normalizeQuasarSeed(s));
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

function emitQuasarHandler(
  instr: Instruction,
  ir: SolanaIR,
  bridge: QuasarEmitterBridge,
): string {
  const name = snakeCase(instr.name);
  const structName = toPascalCase(instr.name);
  const usesBumps = bridge.instrUsesBumps(instr);

  // Build function signature
  const params: string[] = [`accounts: &mut ${structName}`];
  for (const arg of instr.args) {
    const argName = snakeCase(arg.name);
    const argType = bridge.quasarArgType(arg.type);
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
  const body = emitQuasarHandlerBody(instr, ir, bridge);

  return `#[inline(always)]
pub fn handle_${name}(${params.join(", ")}) -> Result<(), ProgramError> {
${body}
}`;
}

function emitQuasarHandlerBody(
  instr: Instruction,
  ir: SolanaIR,
  bridge: QuasarEmitterBridge,
): string {
  const lines: string[] = [];

  for (const stmt of instr.body) {
    switch (stmt.kind) {
      case "pass_through": {
        bridge.passedThroughCount++;
        let code = stmt.code.trim();
        if (code === "Ok(())") {
          lines.push(`    Ok(())`);
          break;
        }
        // Transform ctx.accounts.X references
        code = bridge.transformQuasarPassThrough(code, instr, ir);
        if (code.endsWith(";") || code.endsWith("}") || code.endsWith(");")) {
          lines.push(`    ${code}`);
        } else {
          lines.push(`    ${code};`);
        }
        break;
      }

      case "state_read": {
        bridge.transformedCount++;
        // In quasar, state is accessed directly via accounts.X -- no separate deserialization
        break;
      }

      case "bumps_access": {
        bridge.transformedCount++;
        // In quasar, bumps are accessed via ctx.bumps.X -- handled in lib.rs
        break;
      }

      case "state_field_assign": {
        bridge.transformedCount++;
        const accountName = snakeCase(stmt.account);
        const fieldName = snakeCase(stmt.field);
        let value = bridge.transformQuasarExpr(stmt.value, instr, ir);

        // Handle compound assignments
        const compoundMatch = value.match(/^__compound_([+\-*\/])=__(.+)$/);
        if (compoundMatch?.[1] && compoundMatch[2]) {
          const op = compoundMatch[1];
          const rhs = bridge.transformQuasarExpr(
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
        bridge.transformedCount++;
        let condition = bridge.transformQuasarExpr(
          stmt.condition,
          instr,
          ir,
        );
        // Prefix account references with accounts.
        condition = bridge.prefixAccountRefs(condition, instr);
        lines.push(`    require!(${condition}, ${stmt.error});`);
        break;
      }

      case "msg": {
        bridge.transformedCount++;
        const literalMatch = stmt.message.match(/^"([^"\\]|\\.)*"/);
        if (literalMatch?.[0]) {
          const literal = literalMatch[0];
          if (literal !== stmt.message.trim()) {
            // Formatted message -- collapse to static log
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
        bridge.transformedCount++;
        lines.push(`    log("event:${stmt.event}");`);
        if (stmt.fields.trim()) {
          lines.push(`    // Event data: ${stmt.fields.replace(/\n/g, " ")}`);
        }
        break;
      }

      case "cpi_system_transfer": {
        bridge.transformedCount++;
        const amount = bridge.transformQuasarExpr(stmt.amount, instr, ir);
        if (stmt.signerSeeds) {
          const seedsCode = bridge.emitQuasarSignerSeeds(stmt.from, instr, ir);
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
        bridge.transformedCount++;
        const amount = bridge.transformQuasarExpr(stmt.amount, instr, ir);
        const from = snakeCase(stmt.from);
        const to = snakeCase(stmt.to);
        const authority = snakeCase(stmt.authority);
        if (stmt.signerSeeds) {
          const seedsCode = bridge.emitQuasarSignerSeeds(
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
        bridge.transformedCount++;
        const amount = bridge.transformQuasarExpr(stmt.amount, instr, ir);
        const mint = snakeCase(stmt.mint);
        const to = snakeCase(stmt.to);
        const authority = snakeCase(stmt.authority);
        if (stmt.signerSeeds) {
          const seedsCode = bridge.emitQuasarSignerSeeds(
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
        bridge.transformedCount++;
        const amount = bridge.transformQuasarExpr(stmt.amount, instr, ir);
        const from = snakeCase(stmt.from);
        const mint = snakeCase(stmt.mint);
        const authority = snakeCase(stmt.authority);
        if (stmt.signerSeeds) {
          const seedsCode = bridge.emitQuasarSignerSeeds(
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
        bridge.transformedCount++;
        const account = snakeCase(stmt.account);
        const destination = snakeCase(stmt.destination);
        const authority = snakeCase(stmt.authority);
        if (stmt.signerSeeds) {
          const seedsCode = bridge.emitQuasarSignerSeeds(
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
        bridge.transformedCount++;
        bridge.warnings.push(
          `Custom CPI to '${stmt.programAccount}' -- passed through as raw code. Verify quasar-lang compatibility.`,
        );
        lines.push(
          `    // Anvil: Custom CPI -- verify this works with quasar-lang`,
        );
        lines.push(`    ${stmt.rawCode}`);
        break;
      }

      case "sysvar_clock": {
        bridge.transformedCount++;
        lines.push(
          `    let ${stmt.localVar} = quasar_lang::prelude::Clock::get()?;`,
        );
        break;
      }

      case "sysvar_rent": {
        bridge.transformedCount++;
        lines.push(
          `    let ${stmt.localVar} = quasar_lang::prelude::Rent::get()?;`,
        );
        break;
      }

      case "pda_signer_seeds": {
        bridge.transformedCount++;
        // In quasar multi-file, PDA seeds are emitted inline
        const seedsCode = bridge.emitQuasarSignerSeeds(stmt.account, instr, ir);
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
                const seedsCode = bridge.emitQuasarSignerSeeds(
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
        bridge.transformedCount++;
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

function emitQuasarErrorsFile(ir: SolanaIR, bridge: QuasarEmitterBridge): string {
  const enumName = bridge.sourceErrorEnumName(ir);
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

function emitQuasarCargoToml(ir: SolanaIR): string {
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

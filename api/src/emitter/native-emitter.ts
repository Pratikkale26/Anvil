import type { SolanaIR, AccountDef, Instruction, AccountRef } from "../ir/schema.js";

/**
 * Emit a Native Rust Solana program from a SolanaIR.
 *
 * Native Rust = using solana_program directly, no framework.
 * More verbose than Anchor, less optimized than Pinocchio/Quasar.
 * Useful for: learning, auditing, comparison story.
 */
export function emitNative(ir: SolanaIR): string {
  const sections: string[] = [];

  sections.push(fileHeader(ir.name));
  sections.push(nativeUseStatements());
  sections.push(instructionEnum(ir));
  sections.push(entryPoint(ir));

  for (const instr of ir.instructions) {
    sections.push(nativeInstruction(instr, ir));
  }

  for (const acc of ir.accounts) {
    sections.push(nativeAccountStruct(acc));
  }

  if (ir.errors.length > 0) {
    sections.push(errorEnum(ir));
  }

  return sections.join("\n\n");
}

// ─── Use statements ───────────────────────────────────────────────────────────

function nativeUseStatements(): string {
  return `use borsh::{BorshDeserialize, BorshSerialize};
use solana_program::{
    account_info::{next_account_info, AccountInfo},
    entrypoint,
    entrypoint::ProgramResult,
    msg,
    program::invoke,
    program_error::ProgramError,
    pubkey::Pubkey,
    rent::Rent,
    system_instruction,
    sysvar::Sysvar,
};`;
}

// ─── Instruction enum (for borsh dispatch) ───────────────────────────────────

function instructionEnum(ir: SolanaIR): string {
  const variants = ir.instructions
    .map((instr) => {
      if (instr.args.length === 0) {
        return `    ${toPascalCase(instr.name)},`;
      }
      const fields = instr.args.map((a) => `${snakeCase(a.name)}: ${rustType(a.type)}`).join(", ");
      return `    ${toPascalCase(instr.name)} { ${fields} },`;
    })
    .join("\n");

  return `#[derive(BorshDeserialize, BorshSerialize, Debug)]
pub enum ${toPascalCase(ir.name)}Instruction {
${variants}
}`;
}

// ─── Entrypoint ───────────────────────────────────────────────────────────────

function entryPoint(ir: SolanaIR): string {
  const arms = ir.instructions
    .map((instr) => {
      if (instr.args.length === 0) {
        return `        ${toPascalCase(ir.name)}Instruction::${toPascalCase(instr.name)} => {
            process_${snakeCase(instr.name)}(program_id, accounts)?
        }`;
      }
      const argNames = instr.args.map((a) => snakeCase(a.name)).join(", ");
      return `        ${toPascalCase(ir.name)}Instruction::${toPascalCase(instr.name)} { ${argNames} } => {
            process_${snakeCase(instr.name)}(program_id, accounts, ${argNames})?
        }`;
    })
    .join("\n");

  return `entrypoint!(process_instruction);

pub fn process_instruction(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    instruction_data: &[u8],
) -> ProgramResult {
    let instruction = ${toPascalCase(ir.name)}Instruction::try_from_slice(instruction_data)
        .map_err(|_| ProgramError::InvalidInstructionData)?;

    match instruction {
${arms}
    }
    Ok(())
}`;
}

// ─── Processor function ───────────────────────────────────────────────────────

function nativeInstruction(instr: Instruction, _ir: SolanaIR): string {
  const nonProgramAccounts = instr.accounts.filter(
    (a) => !isProgramAccount(a.accountType)
  );

  const argParams =
    instr.args.length > 0
      ? ", " + instr.args.map((a) => `${snakeCase(a.name)}: ${rustType(a.type)}`).join(", ")
      : "";

  const accountIter = nonProgramAccounts
    .map((acc) => `    let ${snakeCase(acc.name)} = next_account_info(account_info_iter)?;`)
    .join("\n");

  const checks = buildChecks(instr.accounts);

  return `pub fn process_${snakeCase(instr.name)}(
    program_id: &Pubkey,
    accounts: &[AccountInfo]${argParams},
) -> ProgramResult {
    let account_info_iter = &mut accounts.iter();
${accountIter}
${checks}
    msg!("${instr.name} called");

    // TODO: implement ${instr.name} business logic

    Ok(())
}`;
}

// ─── Account struct ───────────────────────────────────────────────────────────

function nativeAccountStruct(acc: AccountDef): string {
  const fields = acc.fields
    .map((f) => `    pub ${snakeCase(f.name)}: ${rustType(f.type)},`)
    .join("\n");

  return `#[derive(BorshSerialize, BorshDeserialize, Debug, Clone)]
pub struct ${acc.name} {
${fields}
}

impl ${acc.name} {
    pub const LEN: usize = ${acc.space ?? acc.fields.reduce((s, f) => s + typeSize(f.type), 0)};

    pub fn from_account_info(account: &AccountInfo) -> Result<Self, ProgramError> {
        let data = account.try_borrow_data()?;
        // Skip 8-byte discriminator
        ${acc.name}::try_from_slice(&data[8..])
            .map_err(|_| ProgramError::InvalidAccountData)
    }

    pub fn save(&self, account: &AccountInfo) -> ProgramResult {
        let mut data = account.try_borrow_mut_data()?;
        let serialized = borsh::to_vec(self).map_err(|_| ProgramError::AccountDataTooSmall)?;
        data[8..8 + serialized.len()].copy_from_slice(&serialized);
        Ok(())
    }
}`;
}

// ─── Error enum ───────────────────────────────────────────────────────────────

function errorEnum(ir: SolanaIR): string {
  const variants = ir.errors
    .map((e) => `    /// ${e.msg}\n    ${e.name},`)
    .join("\n");

  return `use solana_program::decode_error::DecodeError;
use num_derive::FromPrimitive;
use thiserror::Error;

#[derive(Clone, Copy, Debug, Eq, Error, FromPrimitive, PartialEq)]
pub enum ${toPascalCase(ir.name)}Error {
${variants}
}

impl From<${toPascalCase(ir.name)}Error> for ProgramError {
    fn from(e: ${toPascalCase(ir.name)}Error) -> Self {
        ProgramError::Custom(e as u32)
    }
}`;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function fileHeader(name: string): string {
  return `//! ${toPascalCase(name)} — generated by Anvil v0.1.0
//! Source framework: Anchor → Target: Native Rust (solana_program)
//!
//! Uses borsh serialization. More verbose than Anchor but fully transparent.
//! ⚠️  Review before deploying. Business logic marked with TODO.`;
}

function buildChecks(accounts: AccountRef[]): string {
  const lines: string[] = [];

  for (const acc of accounts) {
    if (isProgramAccount(acc.accountType)) continue;

    if (acc.isSigner) {
      lines.push(
        `    if !${snakeCase(acc.name)}.is_signer {\n        return Err(ProgramError::MissingRequiredSignature);\n    }`
      );
    }
    for (const c of acc.constraints) {
      if (c.kind === "owner") {
        lines.push(
          `    if ${snakeCase(acc.name)}.owner != program_id {\n        return Err(ProgramError::IncorrectProgramId);\n    }`
        );
      }
      if (c.kind === "has_one" && c.value) {
        lines.push(
          `    // TODO: verify ${snakeCase(acc.name)}.${c.value} == ${c.value}.key`
        );
      }
    }
  }

  return lines.length > 0 ? "\n" + lines.join("\n") : "";
}

function isProgramAccount(t: string): boolean {
  return (
    t.includes("Program") ||
    t === "SystemProgram" ||
    t === "TokenProgram" ||
    t === "AssociatedTokenProgram"
  );
}

function rustType(t: string): string {
  if (t === "Pubkey") return "Pubkey";
  return t;
}

function typeSize(t: string): number {
  const sizes: Record<string, number> = {
    u8: 1, u16: 2, u32: 4, u64: 8, u128: 16,
    i8: 1, i16: 2, i32: 4, i64: 8, i128: 16,
    bool: 1, Pubkey: 32, String: 36, "Vec<u8>": 4,
  };
  return sizes[t] ?? 32;
}

function snakeCase(s: string): string {
  return s.replace(/([A-Z])/g, "_$1").toLowerCase().replace(/^_/, "");
}

function toPascalCase(s: string): string {
  return s.replace(/(^|_)([a-z])/g, (_, __, c) => c.toUpperCase());
}

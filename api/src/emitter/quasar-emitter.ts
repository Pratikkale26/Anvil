import type { SolanaIR, AccountDef, Instruction, AccountRef } from "../ir/schema.js";

/**
 * Emit a Quasar Solana program from a SolanaIR.
 *
 * Quasar (by Blueshift): https://github.com/blueshift-labs/quasar
 * - Zero-copy, zero-allocation
 * - Achieves ~96% program size reduction vs Anchor
 * - Uses raw byte slices + const generics for account validation
 */
export function emitQuasar(ir: SolanaIR): string {
  const sections: string[] = [];

  sections.push(fileHeader(ir.name, "quasar"));
  sections.push(quasarUseStatements());
  sections.push(entryPoint(ir));
  sections.push(discriminatorRouter(ir));

  for (const instr of ir.instructions) {
    sections.push(quasarInstruction(instr, ir));
  }

  for (const acc of ir.accounts) {
    sections.push(quasarAccountStruct(acc));
  }

  if (ir.errors.length > 0) {
    sections.push(errorEnum(ir));
  }

  return sections.join("\n\n");
}

// ─── Use statements ───────────────────────────────────────────────────────────

function quasarUseStatements(): string {
  return `use solana_program::{
    account_info::AccountInfo,
    entrypoint::ProgramResult,
    program_error::ProgramError,
    pubkey::Pubkey,
};

// Quasar zero-allocation primitives
type ZeroCopyAccount<'a> = &'a [u8];`;
}

// ─── Entrypoint ───────────────────────────────────────────────────────────────

function entryPoint(ir: SolanaIR): string {
  return `solana_program::entrypoint!(process_instruction);

pub fn process_instruction(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    instruction_data: &[u8],
) -> ProgramResult {
    if instruction_data.len() < 8 {
        return Err(ProgramError::InvalidInstructionData);
    }
    // Quasar: discriminator match with zero-allocation dispatch
    match instruction_data.split_at(8) {
        (disc, data) => route(program_id, accounts, disc, data),
        #[allow(unreachable_patterns)]
        _ => Err(ProgramError::InvalidInstructionData),
    }
}

#[inline(always)]
fn route(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    disc: &[u8],
    data: &[u8],
) -> ProgramResult {
${ir.instructions
  .map((instr) => {
    return `    if disc == &${instrDiscriminatorArray(instr.name)} {
        return ${snakeCase(instr.name)}(program_id, accounts, data);
    }`;
  })
  .join("\n")}
    Err(ProgramError::InvalidInstructionData)
}`;
}

function discriminatorRouter(_ir: SolanaIR): string {
  return ""; // Inlined into entryPoint for Quasar
}

// ─── Instruction handler ──────────────────────────────────────────────────────

function quasarInstruction(instr: Instruction, _ir: SolanaIR): string {
  const nonProgramAccounts = instr.accounts.filter(
    (a) => !isProgramAccount(a.accountType)
  );

  const accountDestructure = nonProgramAccounts
    .map(
      (acc, i) =>
        `    let ${snakeCase(acc.name)} = accounts.get(${i}).ok_or(ProgramError::NotEnoughAccountKeys)?;`
    )
    .join("\n");

  const checks = buildChecks(instr.accounts);

  const argParsers =
    instr.args.length > 0
      ? `\n    // Parse args (zero-allocation, direct from byte slice)\n    let mut _offset = 0usize;\n    ${instr.args
          .map(
            (a) =>
              `let _${snakeCase(a.name)}: ${quasarType(a.type)} = 0; // TODO: parse from data[offset..]`
          )
          .join("\n    ")}`
      : "";

  return `#[inline(always)]
fn ${snakeCase(instr.name)}(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    data: &[u8],
) -> ProgramResult {
${accountDestructure}
${checks}${argParsers}

    // TODO: implement ${instr.name} business logic

    Ok(())
}`;
}

// ─── Account struct ───────────────────────────────────────────────────────────

function quasarAccountStruct(acc: AccountDef): string {
  const fields = acc.fields
    .map((f) => `    pub ${snakeCase(f.name)}: ${quasarType(f.type)},`)
    .join("\n");

  const totalSize = acc.fields.reduce((s, f) => s + typeSize(f.type), 0);

  return `/// ${acc.name} — zero-allocation layout (Quasar)
/// Total size: ${acc.space ?? totalSize + 8} bytes (including 8-byte discriminator)
#[repr(C, packed)]
pub struct ${acc.name} {
${fields}
}

impl ${acc.name} {
    pub const DISCRIMINATOR: [u8; 8] = [/* sha256("account:${acc.name}")[..8] */ 0u8; 8];
    pub const SIZE: usize = 8 + core::mem::size_of::<Self>();

    /// Read account data with zero-allocation (Quasar style)
    #[inline(always)]
    pub fn load(data: &[u8]) -> Result<&Self, ProgramError> {
        if data.len() < Self::SIZE {
            return Err(ProgramError::AccountDataTooSmall);
        }
        // Skip discriminator
        Ok(unsafe { &*(data.as_ptr().add(8) as *const Self) })
    }

    #[inline(always)]
    pub fn load_mut(data: &mut [u8]) -> Result<&mut Self, ProgramError> {
        if data.len() < Self::SIZE {
            return Err(ProgramError::AccountDataTooSmall);
        }
        Ok(unsafe { &mut *(data.as_mut_ptr().add(8) as *mut Self) })
    }
}`;
}

// ─── Error enum ───────────────────────────────────────────────────────────────

function errorEnum(ir: SolanaIR): string {
  const variants = ir.errors
    .map((e) => `    /// ${e.msg}\n    ${e.name} = ${e.code},`)
    .join("\n");

  return `#[repr(u32)]
#[derive(Clone, Copy, Debug)]
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

function fileHeader(name: string, framework: string): string {
  return `//! ${toPascalCase(name)} — generated by Anvil v0.1.0
//! Source framework: Anchor → Target: ${framework}
//!
//! Quasar (Blueshift): zero-copy, zero-allocation Solana programs.
//! Estimated CU reduction: ~79-82% vs Anchor.
//!
//! ⚠️  Review before deploying. Business logic marked with TODO.
#![no_std]
#![deny(clippy::all)]`;
}

function instrDiscriminatorArray(name: string): string {
  return `[/* ${name} disc */ 0u8, 0, 0, 0, 0, 0, 0, ${name.length}]`;
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

function quasarType(t: string): string {
  if (t === "Pubkey") return "[u8; 32]";
  if (t === "String") return "[u8; 64]";
  return t;
}

function typeSize(t: string): number {
  const sizes: Record<string, number> = {
    u8: 1, u16: 2, u32: 4, u64: 8, u128: 16,
    i8: 1, i16: 2, i32: 4, i64: 8, i128: 16,
    bool: 1, Pubkey: 32, String: 64, "Vec<u8>": 4,
  };
  return sizes[t] ?? 32;
}

function snakeCase(s: string): string {
  return s.replace(/([A-Z])/g, "_$1").toLowerCase().replace(/^_/, "");
}

function toPascalCase(s: string): string {
  return s.replace(/(^|_)([a-z])/g, (_, __, c) => c.toUpperCase());
}

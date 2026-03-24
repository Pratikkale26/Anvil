import type { SolanaIR, AccountDef, Instruction, AccountRef } from "../ir/schema.js";

/**
 * Emit a Pinocchio Solana program from a SolanaIR.
 *
 * Pinocchio (by Anza): https://github.com/anza-xyz/pinocchio
 * - Zero-copy, zero-dependency
 * - No proc macros — everything is manual
 * - Zero-copy account deserialization via raw byte slices
 */
export function emitPinocchio(ir: SolanaIR): string {
  const sections: string[] = [];

  sections.push(fileHeader(ir.name, "pinocchio"));
  sections.push(pinocchioUseStatements());
  sections.push(entryPoint(ir));
  sections.push(discriminatorRouter(ir));

  for (const instr of ir.instructions) {
    sections.push(pinocchioInstruction(instr, ir));
  }

  for (const acc of ir.accounts) {
    sections.push(pinocchioAccountStruct(acc));
  }

  if (ir.errors.length > 0) {
    sections.push(errorEnum(ir));
  }

  return sections.join("\n\n");
}

// ─── Use statements ───────────────────────────────────────────────────────────

function pinocchioUseStatements(): string {
  return `use pinocchio::{
    account_info::AccountInfo,
    entrypoint,
    program_error::ProgramError,
    pubkey::Pubkey,
    ProgramResult,
};
use pinocchio_system::instructions::Transfer;`;
}

// ─── Entrypoint ───────────────────────────────────────────────────────────────

function entryPoint(ir: SolanaIR): string {
  return `entrypoint!(process_instruction);

pub fn process_instruction(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    instruction_data: &[u8],
) -> ProgramResult {
    // First 8 bytes = instruction discriminator
    if instruction_data.len() < 8 {
        return Err(ProgramError::InvalidInstructionData);
    }
    let discriminator = &instruction_data[..8];
    let data = &instruction_data[8..];

    router(program_id, accounts, discriminator, data)
}`;
}

// ─── Router ───────────────────────────────────────────────────────────────────

function discriminatorRouter(ir: SolanaIR): string {
  const arms = ir.instructions
    .map((instr, i) => {
      const disc = instrDiscriminator(instr.name);
      return `    ${disc} => ${snakeCase(instr.name)}(program_id, accounts, data),`;
    })
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

// ─── Instruction handler ──────────────────────────────────────────────────────

function pinocchioInstruction(instr: Instruction, ir: SolanaIR): string {
  const nonProgramAccounts = instr.accounts.filter(
    (a) => !isProgramAccount(a.accountType)
  );

  const accountDestructure = nonProgramAccounts
    .map((acc, i) => `    let ${snakeCase(acc.name)} = &accounts[${i}];`)
    .join("\n");

  const checks = buildChecks(instr.accounts);

  const args = parseArgsFromInstr(instr);
  const argsComment =
    instr.args.length > 0
      ? `\n    // Args: ${instr.args.map((a) => `${a.name}: ${a.type}`).join(", ")}\n    let _data_offset = 0usize;\n    ${args}`
      : "";

  return `fn ${snakeCase(instr.name)}(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    data: &[u8],
) -> ProgramResult {
${accountDestructure}
${checks}${argsComment}

    // TODO: implement ${instr.name} business logic

    Ok(())
}`;
}

// ─── Account struct ───────────────────────────────────────────────────────────

function pinocchioAccountStruct(acc: AccountDef): string {
  const fields = acc.fields
    .map((f) => `    pub ${snakeCase(f.name)}: ${rustTypeForPinocchio(f.type)},`)
    .join("\n");

  const fieldParsers = acc.fields
    .map((f, i) => {
      const size = typeSize(f.type);
      if (f.type === "Pubkey") {
        return `        let ${snakeCase(f.name)} = unsafe { &*(ptr as *const [u8; 32]) };
        ptr = ptr.add(32);`;
      }
      return `        let ${snakeCase(f.name)} = unsafe { *(ptr as *const ${rustTypeForPinocchio(f.type)}) };
        ptr = ptr.add(${size});`;
    })
    .join("\n");

  return `/// Zero-copy view into ${acc.name} account data (Pinocchio style)
#[repr(C)]
pub struct ${acc.name} {
${fields}
}

impl ${acc.name} {
    pub const LEN: usize = ${acc.space ?? acc.fields.reduce((s, f) => s + typeSize(f.type), 0)};

    /// Parse account data zero-copy — no allocations
    pub unsafe fn from_account_info(account: &AccountInfo) -> &Self {
        let data = account.borrow_data_unchecked();
        // Skip 8-byte discriminator
        &*(data.as_ptr().add(8) as *const Self)
    }
}`;
}

// ─── Error enum ───────────────────────────────────────────────────────────────

function errorEnum(ir: SolanaIR): string {
  const variants = ir.errors
    .map((e) => `    /// ${e.msg}\n    ${e.name} = ${e.code},`)
    .join("\n");

  return `#[derive(Clone, Copy, Debug, PartialEq)]
#[repr(u32)]
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
//! ⚠️  This is generated reference output. Review before deploying.
//!    Edge cases and business logic are marked with TODO.
#![deny(clippy::all)]
#![forbid(unsafe_code)]`;
}

function instrDiscriminator(name: string): string {
  // Anchor-style discriminator: sha256("global:<name>")[..8] as byte array literal
  // We approximate with a comment — real impl needs sha256
  return `[/* ${name} discriminator: sha256("global:${name}")[..8] */0u8, 0, 0, 0, 0, 0, 0, ${name.length}]`;
}

function buildChecks(accounts: AccountRef[]): string {
  const lines: string[] = [];

  for (const acc of accounts) {
    if (isProgramAccount(acc.accountType)) continue;

    if (acc.isSigner) {
      lines.push(
        `    // Verify ${acc.name} is signer\n    if !${snakeCase(acc.name)}.is_signer() {\n        return Err(ProgramError::MissingRequiredSignature);\n    }`
      );
    }

    for (const c of acc.constraints) {
      if (c.kind === "owner") {
        lines.push(
          `    // Verify ${acc.name} owned by this program\n    if ${snakeCase(acc.name)}.owner() != program_id {\n        return Err(ProgramError::IncorrectProgramId);\n    }`
        );
      }
      if (c.kind === "has_one" && c.value) {
        lines.push(
          `    // has_one: ${acc.name}.${c.value}\n    // TODO: verify ${snakeCase(acc.name)}.${c.value} == ${c.value}.key()`
        );
      }
    }
  }

  return lines.length > 0 ? "\n" + lines.join("\n") : "";
}

function parseArgsFromInstr(instr: Instruction): string {
  if (instr.args.length === 0) return "";
  return instr.args
    .map(
      (a) =>
        `let _${snakeCase(a.name)}: ${rustTypeForPinocchio(a.type)} = 0; // TODO: parse from data`
    )
    .join("\n    ");
}

function isProgramAccount(t: string): boolean {
  return (
    t.includes("Program") ||
    t === "SystemProgram" ||
    t === "TokenProgram" ||
    t === "AssociatedTokenProgram"
  );
}

function rustTypeForPinocchio(t: string): string {
  if (t === "Pubkey") return "[u8; 32]";
  if (t === "String") return "[u8; 64]"; // fixed-size in pinocchio
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

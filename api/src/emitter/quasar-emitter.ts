import { createHash } from "crypto";
import type { SolanaIR, AccountDef, Instruction, Arg } from "../ir/schema.js";

export function emitQuasar(ir: SolanaIR): string {
  const sections: string[] = [];

  sections.push(fileHeader(ir.name, "quasar"));
  sections.push(quasarUseStatements());
  sections.push(entryPoint());
  sections.push(routeFunction(ir));

  for (const instr of ir.instructions) {
    sections.push(quasarInstruction(instr, ir));
  }

  for (const acc of ir.accounts) {
    sections.push(quasarAccountStruct(acc));
  }

  sections.push(quasarHelpers());

  if (ir.errors.length > 0) {
    sections.push(errorEnum(ir));
  }

  return sections.join("\n\n");
}

function quasarUseStatements(): string {
  return `use core::convert::TryInto;
use solana_program::{
    account_info::AccountInfo,
    entrypoint,
    entrypoint::ProgramResult,
    program_error::ProgramError,
    pubkey::Pubkey,
};`;
}

function entryPoint(): string {
  return `entrypoint!(process_instruction);

pub fn process_instruction(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    instruction_data: &[u8],
) -> ProgramResult {
    if instruction_data.len() < 8 {
        return Err(ProgramError::InvalidInstructionData);
    }

    let (disc, data) = instruction_data.split_at(8);
    route(program_id, accounts, disc, data)
}`;
}

function routeFunction(ir: SolanaIR): string {
  const arms = ir.instructions
    .map(
      (instr) =>
        `    if disc == &${instrDiscriminatorArray(instr.name)} {\n        return ${snakeCase(instr.name)}(program_id, accounts, data);\n    }`
    )
    .join("\n");

  return `fn route(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    disc: &[u8],
    data: &[u8],
) -> ProgramResult {
${arms}
    Err(ProgramError::InvalidInstructionData)
}`;
}

function quasarInstruction(instr: Instruction, ir: SolanaIR): string {
  const nonProgramAccounts = instr.accounts.filter((account) => !isProgramAccount(account.accountType));
  const bindings = nonProgramAccounts
    .map((account, index) => `    let ${snakeCase(account.name)} = accounts.get(${index}).ok_or(ProgramError::NotEnoughAccountKeys)?;`)
    .join("\n");
  const signerChecks = nonProgramAccounts
    .filter((account) => account.isSigner)
    .map(
      (account) =>
        `    if !${snakeCase(account.name)}.is_signer {\n        return Err(ProgramError::MissingRequiredSignature);\n    }`
    )
    .join("\n");
  const argsBlock = parseArgs(instr.args);
  const logic = buildQuasarLogic(ir.name, instr.name);

  return `fn ${snakeCase(instr.name)}(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    data: &[u8],
) -> ProgramResult {
${bindings}
${signerChecks ? `\n${signerChecks}` : ""}
${argsBlock}
${logic}

    Ok(())
}`;
}

function quasarAccountStruct(acc: AccountDef): string {
  const fields = acc.fields
    .map((field) => `    pub ${snakeCase(field.name)}: ${quasarType(field.type)},`)
    .join("\n");
  const bodyLen = acc.space ?? acc.fields.reduce((size, field) => size + typeSize(field.type), 0);
  const readLines = buildQuasarReadLines(acc);
  const writeLines = buildQuasarWriteLines(acc);
  const ctorFields = acc.fields.map((field) => snakeCase(field.name)).join(", ");

  return `#[repr(C)]
pub struct ${acc.name} {
${fields}
}

impl ${acc.name} {
    pub const DISCRIMINATOR: [u8; 8] = ${accountDiscriminator(acc.name)};
    pub const LEN: usize = ${bodyLen};
    pub const TOTAL_LEN: usize = 8 + Self::LEN;

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

    pub fn write(data: &mut [u8], value: &Self) -> ProgramResult {
        if data.len() < Self::TOTAL_LEN {
            return Err(ProgramError::InvalidAccountData);
        }
        data[..8].copy_from_slice(&Self::DISCRIMINATOR);
        let mut offset = 8usize;
${writeLines}
        Ok(())
    }

    pub fn from_account_info(account: &AccountInfo) -> Result<Self, ProgramError> {
        let data = account.try_borrow_data()?;
        Self::read(&data)
    }

    pub fn save(account: &AccountInfo, value: &Self) -> ProgramResult {
        let mut data = account.try_borrow_mut_data()?;
        Self::write(&mut data, value)
    }
}`;
}

function errorEnum(ir: SolanaIR): string {
  const variants = ir.errors
    .map((error) => `    /// ${error.msg}\n    ${error.name} = ${error.code},`)
    .join("\n");

  return `#[derive(Clone, Copy, Debug, PartialEq)]
#[repr(u32)]
pub enum ${toPascalCase(ir.name)}Error {
${variants}
}

impl From<${toPascalCase(ir.name)}Error> for ProgramError {
    fn from(error: ${toPascalCase(ir.name)}Error) -> Self {
        ProgramError::Custom(error as u32)
    }
}`;
}

function fileHeader(name: string, framework: string): string {
  return `//! ${toPascalCase(name)} — generated by Anvil v0.1.0
//! Source framework: Anchor → Target: ${framework}
//!
//! Supported reference paths are currently focused on the simpler demos.
#![deny(clippy::all)]`;
}

function parseArgs(args: Arg[]): string {
  if (args.length === 0) {
    return `    if !data.is_empty() {
        return Err(ProgramError::InvalidInstructionData);
    }`;
  }

  let offset = 0;
  const lines = args.map((arg) => {
    const line = parseArg(arg, offset);
    offset += typeSize(arg.type);
    return line;
  });
  return `    // Args\n${lines.join("\n")}`;
}

function parseArg(arg: Arg, offset: number): string {
  const start = offset;
  const end = offset + typeSize(arg.type);
  const name = snakeCase(arg.name);

  switch (arg.type) {
    case "u8":
      return `    if data.len() < ${end} {
        return Err(ProgramError::InvalidInstructionData);
    }
    let ${name}: u8 = data[${start}];`;
    case "u16":
    case "u32":
    case "u64":
    case "u128":
    case "i16":
    case "i32":
    case "i64":
    case "i128":
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
    let ${name}: Pubkey = Pubkey::new_from_array(data[${start}..${end}].try_into().unwrap());`;
    default:
      return `    // TODO: parse ${name}: ${arg.type}`;
  }
}

function buildQuasarLogic(programName: string, instructionName: string): string {
  if (programName === "counter") {
    return buildQuasarCounterLogic(instructionName);
  }
  if (programName === "vault") {
    return buildQuasarVaultLogic(instructionName);
  }
  return `    // TODO: ${programName}.${instructionName} is not in the supported reference set yet.`;
}

function buildQuasarCounterLogic(instructionName: string): string {
  switch (instructionName) {
    case "initialize":
      return `    let counter_bump = bump_seed(program_id, &[b"counter", authority.key.as_ref()], counter.key)?;
    if counter.owner != program_id {
        return Err(ProgramError::IncorrectProgramId);
    }
    if !counter.is_writable {
        return Err(ProgramError::InvalidAccountData);
    }
    let counter_state = CounterAccount {
        authority: *authority.key,
        count: start_value,
        bump: counter_bump,
    };
    CounterAccount::save(counter, &counter_state)?;`;
    case "increment":
      return `    if counter.owner != program_id {
        return Err(ProgramError::IncorrectProgramId);
    }
    if !counter.is_writable {
        return Err(ProgramError::InvalidAccountData);
    }
    let counter_bump = bump_seed(program_id, &[b"counter", authority.key.as_ref()], counter.key)?;
    let mut counter_state = CounterAccount::from_account_info(counter)?;
    if counter_state.authority != *authority.key {
        return Err(ProgramError::InvalidAccountData);
    }
    if counter_state.bump != counter_bump {
        return Err(ProgramError::InvalidSeeds);
    }
    counter_state.count = counter_state
        .count
        .checked_add(amount)
        .ok_or(CounterError::Overflow)?;
    CounterAccount::save(counter, &counter_state)?;`;
    case "decrement":
      return `    if counter.owner != program_id {
        return Err(ProgramError::IncorrectProgramId);
    }
    if !counter.is_writable {
        return Err(ProgramError::InvalidAccountData);
    }
    let counter_bump = bump_seed(program_id, &[b"counter", authority.key.as_ref()], counter.key)?;
    let mut counter_state = CounterAccount::from_account_info(counter)?;
    if counter_state.authority != *authority.key {
        return Err(ProgramError::InvalidAccountData);
    }
    if counter_state.bump != counter_bump {
        return Err(ProgramError::InvalidSeeds);
    }
    counter_state.count = counter_state
        .count
        .checked_sub(amount)
        .ok_or(CounterError::Underflow)?;
    CounterAccount::save(counter, &counter_state)?;`;
    case "reset":
      return `    if counter.owner != program_id {
        return Err(ProgramError::IncorrectProgramId);
    }
    if !counter.is_writable {
        return Err(ProgramError::InvalidAccountData);
    }
    let counter_bump = bump_seed(program_id, &[b"counter", authority.key.as_ref()], counter.key)?;
    let mut counter_state = CounterAccount::from_account_info(counter)?;
    if counter_state.authority != *authority.key {
        return Err(ProgramError::InvalidAccountData);
    }
    if counter_state.bump != counter_bump {
        return Err(ProgramError::InvalidSeeds);
    }
    counter_state.count = 0;
    CounterAccount::save(counter, &counter_state)?;`;
    default:
      return `    // TODO: counter.${instructionName}`;
  }
}

function buildQuasarVaultLogic(instructionName: string): string {
  switch (instructionName) {
    case "initialize":
      return `    let vault_state_bump = bump_seed(program_id, &[b"vault_state", authority.key.as_ref()], vault_state.key)?;
    let vault_bump = bump_seed(program_id, &[b"vault", authority.key.as_ref()], vault.key)?;
    if vault_state.owner != program_id {
        return Err(ProgramError::IncorrectProgramId);
    }
    if !vault_state.is_writable || !vault.is_writable {
        return Err(ProgramError::InvalidAccountData);
    }
    let vault_state_state = VaultState {
        authority: *authority.key,
        total_deposited: 0,
        bump: vault_state_bump,
        vault_bump,
    };
    VaultState::save(vault_state, &vault_state_state)?;`;
    case "deposit":
      return `    if amount == 0 {
        return Err(VaultError::InvalidAmount.into());
    }
    if vault_state.owner != program_id {
        return Err(ProgramError::IncorrectProgramId);
    }
    if !vault_state.is_writable || !vault.is_writable || !user.is_writable {
        return Err(ProgramError::InvalidAccountData);
    }
    let vault_state_bump = bump_seed(program_id, &[b"vault_state", authority.key.as_ref()], vault_state.key)?;
    let vault_bump = bump_seed(program_id, &[b"vault", authority.key.as_ref()], vault.key)?;
    let mut vault_state_state = VaultState::from_account_info(vault_state)?;
    if vault_state_state.authority != *authority.key {
        return Err(ProgramError::InvalidAccountData);
    }
    if vault_state_state.bump != vault_state_bump || vault_state_state.vault_bump != vault_bump {
        return Err(ProgramError::InvalidSeeds);
    }
    transfer_lamports(user, vault, amount)?;
    vault_state_state.total_deposited = vault_state_state
        .total_deposited
        .checked_add(amount)
        .ok_or(VaultError::Overflow)?;
    VaultState::save(vault_state, &vault_state_state)?;`;
    case "withdraw":
      return `    if amount == 0 {
        return Err(VaultError::InvalidAmount.into());
    }
    if vault_state.owner != program_id {
        return Err(ProgramError::IncorrectProgramId);
    }
    if !vault_state.is_writable || !vault.is_writable || !user.is_writable {
        return Err(ProgramError::InvalidAccountData);
    }
    if vault.lamports() < amount {
        return Err(VaultError::InsufficientFunds.into());
    }
    let vault_state_bump = bump_seed(program_id, &[b"vault_state", authority.key.as_ref()], vault_state.key)?;
    let vault_bump = bump_seed(program_id, &[b"vault", authority.key.as_ref()], vault.key)?;
    let mut vault_state_state = VaultState::from_account_info(vault_state)?;
    if vault_state_state.authority != *authority.key {
        return Err(ProgramError::InvalidAccountData);
    }
    if vault_state_state.bump != vault_state_bump || vault_state_state.vault_bump != vault_bump {
        return Err(ProgramError::InvalidSeeds);
    }
    transfer_lamports(vault, user, amount)?;
    vault_state_state.total_deposited = vault_state_state
        .total_deposited
        .checked_sub(amount)
        .ok_or(VaultError::Underflow)?;
    VaultState::save(vault_state, &vault_state_state)?;`;
    default:
      return `    // TODO: vault.${instructionName}`;
  }
}

function quasarHelpers(): string {
  return `fn bump_seed(
    program_id: &Pubkey,
    seeds: &[&[u8]],
    expected: &Pubkey,
) -> Result<u8, ProgramError> {
    let (derived, bump) = Pubkey::find_program_address(seeds, program_id);
    if &derived != expected {
        return Err(ProgramError::InvalidSeeds);
    }
    Ok(bump)
}

fn transfer_lamports(
    from: &AccountInfo,
    to: &AccountInfo,
    amount: u64,
) -> ProgramResult {
    let mut from_lamports = from.try_borrow_mut_lamports()?;
    let mut to_lamports = to.try_borrow_mut_lamports()?;
    **from_lamports = from_lamports
        .checked_sub(amount)
        .ok_or(ProgramError::InsufficientFunds)?;
    **to_lamports = to_lamports
        .checked_add(amount)
        .ok_or(ProgramError::ArithmeticOverflow)?;
    Ok(())
}`;
}

function buildQuasarReadLines(acc: AccountDef): string {
  return acc.fields.map((field) => buildQuasarReadLine(field.type, snakeCase(field.name))).join("\n");
}

function buildQuasarWriteLines(acc: AccountDef): string {
  return acc.fields.map((field) => buildQuasarWriteLine(field.type, snakeCase(field.name))).join("\n");
}

function buildQuasarReadLine(typeName: string, fieldName: string): string {
  const size = typeSize(typeName);
  if (typeName === "Pubkey") {
    return `        let ${fieldName}: Pubkey = Pubkey::new_from_array(data[offset..offset + 32].try_into().unwrap());
        offset += 32;`;
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
  return `        let ${fieldName}: ${typeName} = ${typeName}::from_le_bytes(data[offset..offset + ${size}].try_into().unwrap());
        offset += ${size};`;
}

function buildQuasarWriteLine(typeName: string, fieldName: string): string {
  if (typeName === "Pubkey") {
    return `        data[offset..offset + 32].copy_from_slice(value.${fieldName}.as_ref());
        offset += 32;`;
  }
  if (typeName === "bool") {
    return `        data[offset] = if value.${fieldName} { 1 } else { 0 };
        offset += 1;`;
  }
  if (typeName === "u8" || typeName === "i8") {
    return `        data[offset] = value.${fieldName} as u8;
        offset += 1;`;
  }
  const size = typeSize(typeName);
  return `        data[offset..offset + ${size}].copy_from_slice(&value.${fieldName}.to_le_bytes());
        offset += ${size};`;
}

function instrDiscriminatorArray(name: string): string {
  return formatByteArray(discriminatorBytes(`global:${name}`));
}

function accountDiscriminator(name: string): string {
  return formatByteArray(discriminatorBytes(`account:${name}`));
}

function discriminatorBytes(namespace: string): number[] {
  return [...createHash("sha256").update(namespace).digest().subarray(0, 8)];
}

function formatByteArray(bytes: number[]): string {
  return `[${bytes.join(", ")}]`;
}

function isProgramAccount(accountType: string): boolean {
  return (
    accountType.includes("Program") ||
    accountType === "SystemProgram" ||
    accountType === "TokenProgram" ||
    accountType === "AssociatedTokenProgram"
  );
}

function quasarType(typeName: string): string {
  if (typeName === "Pubkey") return "Pubkey";
  if (typeName === "String") return "[u8; 64]";
  return typeName;
}

function typeSize(typeName: string): number {
  const sizes: Record<string, number> = {
    u8: 1,
    u16: 2,
    u32: 4,
    u64: 8,
    u128: 16,
    i8: 1,
    i16: 2,
    i32: 4,
    i64: 8,
    i128: 16,
    bool: 1,
    Pubkey: 32,
    String: 64,
    "Vec<u8>": 4,
  };

  return sizes[typeName] ?? 32;
}

function snakeCase(value: string): string {
  return value.replace(/([A-Z])/g, "_$1").toLowerCase().replace(/^_/, "");
}

function toPascalCase(value: string): string {
  return value.replace(/(^|_)([a-z])/g, (_, __, char: string) => char.toUpperCase());
}

/**
 * Pinocchio Emitter — Generic target emitter for the Pinocchio framework.
 *
 * Extends BaseEmitter with Pinocchio-specific implementations.
 * All hardcoded counter/vault logic has been removed.
 * Business logic is now driven entirely by IR body statements.
 */

import type { SolanaIR, AccountDef } from "../ir/schema.js";
import {
  BaseEmitter,
  instrDiscriminator,
  accountDiscriminator,
  typeSize,
  snakeCase,
  toPascalCase,
  isProgramAccount,
  irNeedsHelper,
} from "./emitter-base.js";

class PinocchioEmitter extends BaseEmitter {
  override readonly frameworkName = "Pinocchio";

  override emitUseStatements(_ir: SolanaIR): string {
    return `use core::convert::TryInto;
use pinocchio::{
    account_info::AccountInfo,
    entrypoint,
    program_error::ProgramError,
    pubkey::Pubkey,
    ProgramResult,
};`;
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
          `        ${instrDiscriminator(instr.name)} => ${snakeCase(instr.name)}(program_id, accounts, data),`
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

  override emitStateRead(accountName: string, typeName: string, localVar: string, mutable: boolean): string {
    const mutKeyword = mutable ? "mut " : "";
    return `    let ${mutKeyword}${localVar} = ${typeName}::from_account_info(${accountName})?;`;
  }

  override emitStateSave(accountName: string, _typeName: string, localVar: string): string {
    return `    ${_typeName}::save(${accountName}, &${localVar})?;`;
  }

  override emitBumpSeed(_programId: string, seeds: string[], expectedKey: string): string {
    const seedsStr = seeds.map((s) => `${s}`).join(", ");
    return `    let bump = bump_seed(program_id, &[${seedsStr}], ${expectedKey}.key())?;`;
  }

  override emitSystemTransfer(from: string, to: string, amount: string, signerSeeds?: string): string {
    if (signerSeeds) {
      return `    // System transfer with PDA signer
    transfer_lamports_signed(${from}, ${to}, ${amount}, ${signerSeeds})?;`;
    }
    return `    transfer_lamports(${from}, ${to}, ${amount})?;`;
  }

  override emitSplTransfer(from: string, to: string, authority: string, amount: string, signerSeeds?: string): string {
    if (signerSeeds) {
      return `    // SPL Token transfer (PDA signed) — ${from} → ${to}
    spl_token_transfer_signed(${from}, ${to}, ${authority}, ${amount}, ${signerSeeds})?;`;
    }
    return `    // SPL Token transfer — ${from} → ${to}
    spl_token_transfer(${from}, ${to}, ${authority}, ${amount})?;`;
  }

  override emitSplMintTo(mint: string, to: string, authority: string, amount: string, signerSeeds?: string): string {
    const signed = signerSeeds ? "_signed" : "";
    return `    // SPL Token mint_to — ${mint} → ${to}
    spl_token_mint_to${signed}(${mint}, ${to}, ${authority}, ${amount}${signerSeeds ? `, ${signerSeeds}` : ""})?;`;
  }

  override emitSplBurn(from: string, mint: string, authority: string, amount: string, signerSeeds?: string): string {
    const signed = signerSeeds ? "_signed" : "";
    return `    // SPL Token burn — ${from}
    spl_token_burn${signed}(${from}, ${mint}, ${authority}, ${amount}${signerSeeds ? `, ${signerSeeds}` : ""})?;`;
  }

  override emitSplCloseAccount(account: string, destination: string, authority: string, signerSeeds?: string): string {
    const signed = signerSeeds ? "_signed" : "";
    return `    // SPL Token close account — ${account}
    spl_token_close_account${signed}(${account}, ${destination}, ${authority}${signerSeeds ? `, ${signerSeeds}` : ""})?;`;
  }

  override emitPdaSignerSeeds(account: string, seeds: string[], bumpField?: string): string {
    // Detect the account name used as prefix in seed expressions
    // e.g. seeds like "escrow.maker.as_ref()" → prefix is "escrow"
    let statePrefix = account;
    for (const seed of seeds) {
      const prefixMatch = seed.match(/^(\w+)\.\w+/);
      if (prefixMatch?.[1] && !seed.startsWith('b"') && !seed.startsWith("&[")) {
        statePrefix = prefixMatch[1];
        break;
      }
    }

    const dataVar = `${account}_data`;

    // Transform seed expressions from Anchor-style to Pinocchio-style
    const transformedSeeds = seeds.map(seed => {
      // b"literal" stays unchanged
      if (seed.startsWith('b"') || seed.startsWith("b'")) return seed;
      // &[prefix.bump] → &[data_var.bump]
      if (seed.startsWith("&[")) {
        return seed.replace(new RegExp(`&\\[${statePrefix}\\.`), `&[${dataVar}.`);
      }
      // prefix.field.method() → data_var.field.method()
      return seed.replace(new RegExp(`^${statePrefix}\\.`), `${dataVar}.`);
    });

    const seedsStr = transformedSeeds.join(",\n            ");

    // Determine the type name — capitalize the account name
    const typeName = account.charAt(0).toUpperCase() + account.slice(1).replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());

    return `    // PDA signer seeds for '${account}'
    let ${dataVar} = ${typeName}::from_account_info(${account})?;
    let seeds = &[
            ${seedsStr},
        ];
    let signer_seeds = &[&seeds[..]];`;
  }

  override emitRequire(condition: string, error: string): string {
    return `    if !(${condition}) {
        return Err(${error}.into());
    }`;
  }

  override emitMsg(message: string): string {
    return `    pinocchio::msg!(${message});`;
  }

  override emitEmit(event: string, _fields: string): string {
    return `    // Event: ${event}
    // ⚠️ Anvil: Pinocchio doesn't have Anchor's emit!() — log via msg! or instruction data
    pinocchio::msg!("event:${event}");`;
  }

  override emitClockGet(localVar: string): string {
    return `    let ${localVar} = pinocchio::sysvar::clock::Clock::get()?;`;
  }

  override emitRentGet(localVar: string): string {
    return `    let ${localVar} = pinocchio::sysvar::rent::Rent::get()?;`;
  }

  override rustTypeForFramework(typeName: string): string {
    if (typeName === "Pubkey") return "[u8; 32]";
    if (typeName === "String") return "[u8; 64]";
    return typeName;
  }

  protected override emitPubkeyDeserialize(start: number, end: number): string {
    return `data[${start}..${end}].try_into().unwrap()`;
  }

  override emitAccountStruct(acc: AccountDef): string {
    const fields = acc.fields
      .map((f) => `    pub ${snakeCase(f.name)}: ${this.rustTypeForFramework(f.type)},`)
      .join("\n");
    const bodyLen =
      acc.space ?? acc.fields.reduce((s, f) => s + typeSize(f.type), 0);
    const readLines = this.buildReadLines(acc);
    const writeLines = this.buildWriteLines(acc);
    const ctorFields = acc.fields.map((f) => snakeCase(f.name)).join(", ");

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
        let data = unsafe { account.borrow_data_unchecked() };
        Self::read(&data)
    }

    pub fn save(account: &AccountInfo, value: &Self) -> ProgramResult {
        let mut data = unsafe { account.borrow_mut_data_unchecked() };
        Self::write(&mut data, value)
    }
}`;
  }

  override emitErrorEnum(ir: SolanaIR): string {
    const variants = ir.errors
      .map((e) => `    /// ${e.msg}\n    ${e.name} = ${e.code},`)
      .join("\n");

    const enumName = `${toPascalCase(ir.name)}Error`;

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

    if (irNeedsHelper(ir, "transfer_lamports")) {
      helpers.push(`fn transfer_lamports(
    from: &AccountInfo,
    to: &AccountInfo,
    amount: u64,
) -> ProgramResult {
    if from.key() == to.key() {
        return Err(ProgramError::InvalidAccountData);
    }
    let from_lamports = unsafe { from.borrow_mut_lamports_unchecked() };
    let to_lamports = unsafe { to.borrow_mut_lamports_unchecked() };
    *from_lamports = from_lamports
        .checked_sub(amount)
        .ok_or(ProgramError::InsufficientFunds)?;
    *to_lamports = to_lamports
        .checked_add(amount)
        .ok_or(ProgramError::ArithmeticOverflow)?;
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
    let ix = spl_token::instruction::transfer(
        &spl_token::id(),
        from.key(),
        to.key(),
        authority.key(),
        &[],
        amount,
    )?;
    pinocchio::program::invoke(&ix, &[from.clone(), to.clone(), authority.clone()])
}

fn spl_token_transfer_signed(
    from: &AccountInfo,
    to: &AccountInfo,
    authority: &AccountInfo,
    amount: u64,
    signer_seeds: &[&[&[u8]]],
) -> ProgramResult {
    let ix = spl_token::instruction::transfer(
        &spl_token::id(),
        from.key(),
        to.key(),
        authority.key(),
        &[],
        amount,
    )?;
    pinocchio::program::invoke_signed(&ix, &[from.clone(), to.clone(), authority.clone()], signer_seeds)
}`);
    }

    if (irNeedsHelper(ir, "spl_close_account")) {
      helpers.push(`fn spl_token_close_account(
    account: &AccountInfo,
    destination: &AccountInfo,
    authority: &AccountInfo,
) -> ProgramResult {
    let ix = spl_token::instruction::close_account(
        &spl_token::id(),
        account.key(),
        destination.key(),
        authority.key(),
        &[],
    )?;
    pinocchio::program::invoke(&ix, &[account.clone(), destination.clone(), authority.clone()])
}

fn spl_token_close_account_signed(
    account: &AccountInfo,
    destination: &AccountInfo,
    authority: &AccountInfo,
    signer_seeds: &[&[&[u8]]],
) -> ProgramResult {
    let ix = spl_token::instruction::close_account(
        &spl_token::id(),
        account.key(),
        destination.key(),
        authority.key(),
        &[],
    )?;
    pinocchio::program::invoke_signed(&ix, &[account.clone(), destination.clone(), authority.clone()], signer_seeds)
}`);
    }

    // Always emit the token account amount reader — it's commonly needed
    helpers.push(`/// Read the amount field from an SPL Token Account (offset 64, 8 bytes LE u64)
fn token_account_amount(account: &AccountInfo) -> Result<u64, ProgramError> {
    let data = unsafe { account.borrow_data_unchecked() };
    if data.len() < 72 {
        return Err(ProgramError::InvalidAccountData);
    }
    Ok(u64::from_le_bytes(data[64..72].try_into().unwrap()))
}`);

    return helpers.join("\n\n");
  }

  // ── Read/Write lines for account structs ──

  private buildReadLines(acc: AccountDef): string {
    return acc.fields
      .map((f) => this.buildReadLine(f.type, snakeCase(f.name)))
      .join("\n");
  }

  private buildWriteLines(acc: AccountDef): string {
    return acc.fields
      .map((f) => this.buildWriteLine(f.type, snakeCase(f.name)))
      .join("\n");
  }

  private buildReadLine(typeName: string, fieldName: string): string {
    const size = typeSize(typeName);
    if (typeName === "Pubkey") {
      return `        let ${fieldName}: [u8; 32] = data[offset..offset + 32].try_into().unwrap();
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

  private buildWriteLine(typeName: string, fieldName: string): string {
    if (typeName === "Pubkey") {
      return `        data[offset..offset + 32].copy_from_slice(&value.${fieldName});
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
}

// ─── Public API ──────────────────────────────────────────────────────────────

const emitter = new PinocchioEmitter();

export function emitPinocchio(ir: SolanaIR): string {
  return emitter.emit(ir).singleFile;
}

export function emitPinocchioFull(ir: SolanaIR) {
  return emitter.emit(ir);
}

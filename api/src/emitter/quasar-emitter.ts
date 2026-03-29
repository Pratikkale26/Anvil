/**
 * Quasar Emitter — Generic target emitter for the Quasar framework.
 *
 * Extends BaseEmitter with Quasar-specific implementations.
 * All hardcoded counter/vault logic has been removed.
 * Business logic is now driven entirely by IR body statements.
 *
 * Key differences from Pinocchio:
 *   - Uses try_borrow_data() instead of borrow_data_unchecked()
 *   - Uses .key (field) instead of .key() (method)
 *   - More Anchor-like safety model
 */

import type { SolanaIR, AccountDef } from "../ir/schema.js";
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
  emitRequireGuard,
} from "./emitter-base.js";

class QuasarEmitter extends BaseEmitter {
  override readonly frameworkName = "Quasar";

  override emitUseStatements(_ir: SolanaIR): string {
    const imports = [`use core::convert::TryInto;`,
`use quasar::{
    account_info::AccountInfo,
    entrypoint,
    program_error::ProgramError,
    pubkey::Pubkey,
    ProgramResult,
};`];

    if (irNeedsHelper(_ir, "spl_transfer") || irNeedsHelper(_ir, "spl_mint_to") || irNeedsHelper(_ir, "spl_burn")) {
      imports.push(`use quasar_token::instructions::Transfer as TokenTransfer;`);
    }
    if (irNeedsHelper(_ir, "spl_mint_to")) {
      imports.push(`use quasar_token::instructions::MintTo as TokenMintTo;`);
    }
    if (irNeedsHelper(_ir, "spl_burn")) {
      imports.push(`use quasar_token::instructions::Burn as TokenBurn;`);
    }
    if (irNeedsHelper(_ir, "spl_close_account")) {
      imports.push(`use quasar_token::instructions::CloseAccount as TokenCloseAccount;`);
    }

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
    return `    if !${name}.is_signer {
        return Err(ProgramError::MissingRequiredSignature);
    }`;
  }

  override emitOwnerCheck(name: string): string {
    return `    if ${name}.owner != program_id {
        return Err(ProgramError::IncorrectProgramId);
    }`;
  }

  override emitWritableCheck(names: string[]): string {
    const checks = names.map((n) => `!${n}.is_writable`).join(" || ");
    return `    if ${checks} {
        return Err(ProgramError::InvalidAccountData);
    }`;
  }

  override emitAccountKeyExpr(accountName: string): string {
    return `*${accountName}.key`;
  }

  override emitAccountKeyAsRefExpr(accountName: string): string {
    return `${accountName}.key.as_ref()`;
  }

  override emitAccountLamportsExpr(accountName: string): string {
    return `${accountName}.lamports()`;
  }

  override emitStateRead(accountName: string, typeName: string, localVar: string, mutable: boolean): string {
    const mutKeyword = mutable ? "mut " : "";
    return `    let ${mutKeyword}${localVar} = ${typeName}::from_account_info(${accountName})?;`;
  }

  override emitStateSave(accountName: string, typeName: string, localVar: string): string {
    return `    ${typeName}::save(${accountName}, &${localVar})?;`;
  }

  override emitBumpSeed(_programId: string, seeds: string[], expectedKey: string): string {
    const prelude: string[] = [];
    let tempCount = 0;
    const transformedSeeds = seeds.map((seed) => {
      const bytesMatch = seed.match(/^&(.*)\.to_le_bytes\(\)$/);
      if (bytesMatch?.[1]) {
        const varName = tempCount === 0 ? "seed_bytes" : `seed_bytes_${tempCount + 1}`;
        tempCount++;
        prelude.push(`    let ${varName} = ${bytesMatch[1].trim()}.to_le_bytes();`);
        return `&${varName}`;
      }
      const match = seed.match(/^(.*)\.to_le_bytes\(\)\.as_ref\(\)$/);
      if (!match?.[1]) return seed;
      const varName = tempCount === 0 ? "seed_bytes" : `seed_bytes_${tempCount + 1}`;
      tempCount++;
      prelude.push(`    let ${varName} = ${match[1].trim()}.to_le_bytes();`);
      return `${varName}.as_ref()`;
    });
    const seedsStr = transformedSeeds.map((s) => `${s}`).join(", ");
    const bumpLine = `    let bump = bump_seed(program_id, &[${seedsStr}], ${expectedKey}.key)?;`;
    return prelude.length > 0 ? `${prelude.join("\n")}\n${bumpLine}` : bumpLine;
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

  override emitProgramAccountClose(account: string, destination: string): string {
    return `    close_program_account(${account}, ${destination})?;`;
  }

  override emitPdaSignerSeeds(
    account: string,
    accountInfoVar: string,
    seeds: string[],
    _bumpField?: string,
    stateVar?: string,
    typeName?: string,
  ): string {
    // Detect the account name used as prefix in seed expressions
    let statePrefix = account;
    for (const seed of seeds) {
      const prefixMatch = seed.match(/^(\w+)\.\w+/);
      if (prefixMatch?.[1] && !seed.startsWith('b"') && !seed.startsWith("&[")) {
        statePrefix = prefixMatch[1];
        break;
      }
    }

    const dataVar = stateVar || `${account}_data`;
    const resolvedTypeName = typeName || account.charAt(0).toUpperCase() + account.slice(1).replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());

    const prelude: string[] = [];
    let tempCount = 0;
    const transformedSeeds = seeds.map(seed => {
      if (seed.startsWith('b"') || seed.startsWith("b'")) return seed;
      const bytesMatch = seed.match(/^&(.+)\.to_le_bytes\(\)$/);
      if (bytesMatch?.[1]) {
        const varName = tempCount === 0 ? "seed_bytes" : `seed_bytes_${tempCount + 1}`;
        tempCount++;
        prelude.push(`    let ${varName} = ${bytesMatch[1].trim()}.to_le_bytes();`);
        return `&${varName}`;
      }
      const asRefMatch = seed.match(/^(.*)\.to_le_bytes\(\)\.as_ref\(\)$/);
      if (asRefMatch?.[1]) {
        const varName = tempCount === 0 ? "seed_bytes" : `seed_bytes_${tempCount + 1}`;
        tempCount++;
        prelude.push(`    let ${varName} = ${asRefMatch[1].trim()}.to_le_bytes();`);
        return `${varName}.as_ref()`;
      }
      if (seed.startsWith("&[")) {
        return seed.replace(new RegExp(`&\\[${statePrefix}\\.`), `&[${dataVar}.`);
      }
      return seed.replace(new RegExp(`^${statePrefix}\\.`), `${dataVar}.`);
    });

    const seedsStr = transformedSeeds.join(",\n            ");
    const maybeRead = stateVar ? "" : `    let ${dataVar} = ${resolvedTypeName}::from_account_info(${accountInfoVar})?;\n`;
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
    return `    quasar::log::sol_log(${message});`;
  }

  override emitEmit(event: string, _fields: string): string {
    return `    // Event: ${event}
    // ⚠️ Anvil: Quasar doesn't have Anchor's emit!() — logging event name only
    quasar::log::sol_log("event:${event}");`;
  }

  override emitClockGet(localVar: string): string {
    return `    let ${localVar} = quasar::sysvar::clock::Clock::get()?;`;
  }

  override emitRentGet(localVar: string): string {
    return `    let ${localVar} = quasar::sysvar::rent::Rent::get()?;`;
  }

  override rustTypeForFramework(typeName: string): string {
    if (typeName === "Pubkey") return "Pubkey";
    if (typeName === "String") return "[u8; 64]";
    return typeName;
  }

  protected override emitPubkeyDeserialize(start: number, end: number): string {
    return `Pubkey::try_from(&data[${start}..${end}]).unwrap()`;
  }

  override emitAccountStruct(acc: AccountDef): string {
    const fields = acc.fields
      .map((f) => `    pub ${snakeCase(f.name)}: ${this.rustTypeForFramework(f.type)},`)
      .join("\n");
    const bodyLen = acc.fields.reduce((s, f) => s + this.resolveTypeSize(f.type), 0);
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
        let data = account.try_borrow_data()?;
        Self::read(&data)
    }

    pub fn save(account: &AccountInfo, value: &Self) -> ProgramResult {
        let mut data = account.try_borrow_mut_data()?;
        Self::write(&mut data, value)
    }
}`;
  }

  override emitErrorEnum(ir: SolanaIR): string {
    const variants = ir.errors
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

    if (irNeedsUnsignedLamportsHelper(ir)) {
      helpers.push(`fn transfer_lamports(
    from: &AccountInfo,
    to: &AccountInfo,
    amount: u64,
) -> ProgramResult {
    if from.key == to.key {
        return Err(ProgramError::InvalidAccountData);
    }
    **from.try_borrow_mut_lamports()? = from
        .lamports()
        .checked_sub(amount)
        .ok_or(ProgramError::InsufficientFunds)?;
    **to.try_borrow_mut_lamports()? = to
        .lamports()
        .checked_add(amount)
        .ok_or(ProgramError::ArithmeticOverflow)?;
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
    if from.key == to.key {
        return Err(ProgramError::InvalidAccountData);
    }
    **from.try_borrow_mut_lamports()? = from
        .lamports()
        .checked_sub(amount)
        .ok_or(ProgramError::InsufficientFunds)?;
    **to.try_borrow_mut_lamports()? = to
        .lamports()
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
    if account.key == destination.key {
        return Err(ProgramError::InvalidAccountData);
    }
    let lamports = account.lamports();
    **destination.try_borrow_mut_lamports()? = destination
        .lamports()
        .checked_add(lamports)
        .ok_or(ProgramError::ArithmeticOverflow)?;
    **account.try_borrow_mut_lamports()? = 0;
    account.try_borrow_mut_data()?.fill(0);
    Ok(())
}`);
    }

    return helpers.join("\n\n");
  }

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
    const size = this.resolveTypeSize(typeName);
    const typeDef = this.customTypeDef(typeName);
    if (typeName === "Pubkey") {
      return `        let ${fieldName} = Pubkey::try_from(&data[offset..offset + 32]).unwrap();
        offset += 32;`;
    }
    if (/^\[\s*u8\s*;\s*\d+\s*\]$/.test(typeName)) {
      return `        let ${fieldName}: ${typeName} = data[offset..offset + ${size}].try_into().unwrap();
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
    return `        let ${fieldName}: ${typeName} = ${typeName}::from_le_bytes(data[offset..offset + ${size}].try_into().unwrap());
        offset += ${size};`;
  }

  private buildWriteLine(typeName: string, fieldName: string): string {
    const size = this.resolveTypeSize(typeName);
    const typeDef = this.customTypeDef(typeName);
    if (typeName === "Pubkey") {
      return `        data[offset..offset + 32].copy_from_slice(value.${fieldName}.as_ref());
        offset += 32;`;
    }
    if (/^\[\s*u8\s*;\s*\d+\s*\]$/.test(typeName)) {
      return `        data[offset..offset + ${size}].copy_from_slice(&value.${fieldName});
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
}

const emitter = new QuasarEmitter();

export function emitQuasar(ir: SolanaIR): string {
  return emitter.emit(ir).singleFile;
}

export function emitQuasarFull(ir: SolanaIR) {
  return emitter.emit(ir);
}

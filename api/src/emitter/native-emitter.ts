/**
 * Native Emitter — Generic target emitter for native solana_program Rust.
 *
 * Extends BaseEmitter with native solana_program implementations.
 * No framework abstractions — uses raw solana_program and borsh for serialization.
 * Complete business logic generation via the BaseEmitter body walker.
 */

import type { SolanaIR, AccountDef } from "../ir/schema.js";
import {
  BaseEmitter,
  instrDiscriminator,
  snakeCase,
  toPascalCase,
  isProgramAccount,
  irNeedsHelper,
  irNeedsUnsignedLamportsHelper,
  irNeedsSignedLamportsHelper,
  irNeedsUnsignedSplMintToHelper,
  irNeedsSignedSplMintToHelper,
  irNeedsUnsignedSplBurnHelper,
  irNeedsSignedSplBurnHelper,
  irNeedsSignedSplCloseAccountHelper,
  irNeedsUnsignedSplCloseAccountHelper,
  irNeedsTokenAmountHelper,
  irNeedsInitAccountHelper,
  emitRequireGuard,
} from "./emitter-base.js";

class NativeEmitter extends BaseEmitter {
  override readonly frameworkName = "Native";

  override emitUseStatements(_ir: SolanaIR): string {
    const needsInvoke = irNeedsUnsignedLamportsHelper(_ir)
      || irNeedsUnsignedSplMintToHelper(_ir)
      || irNeedsUnsignedSplBurnHelper(_ir)
      || irNeedsUnsignedSplCloseAccountHelper(_ir);
    const needsInvokeSigned = irNeedsSignedLamportsHelper(_ir)
      || irNeedsSignedSplMintToHelper(_ir)
      || irNeedsSignedSplBurnHelper(_ir)
      || irNeedsSignedSplCloseAccountHelper(_ir)
      || irNeedsInitAccountHelper(_ir);
    const needsSystemInstruction = irNeedsUnsignedLamportsHelper(_ir)
      || irNeedsSignedLamportsHelper(_ir)
      || irNeedsInitAccountHelper(_ir);
    const needsMsg = _ir.instructions.some((instr) =>
      instr.body.some((stmt) =>
        stmt.kind === "msg" ||
        stmt.kind === "emit" ||
        (stmt.kind === "pass_through" && /\bmsg!\(/.test(stmt.code))
      )
    );

    const solanaItems = [
      `account_info::AccountInfo`,
      `entrypoint`,
      `entrypoint::ProgramResult`,
      needsMsg ? `msg` : null,
      needsInvoke ? `program::invoke` : null,
      needsInvokeSigned ? `program::invoke_signed` : null,
      `program_error::ProgramError`,
      `pubkey::Pubkey`,
      needsSystemInstruction ? `system_instruction` : null,
      `sysvar::Sysvar`,
    ].filter(Boolean).join(",\n    ");

    const imports = [`use borsh::{BorshDeserialize, BorshSerialize};
use solana_program::{
    ${solanaItems},
};`];
    imports.push(...this.filteredSourceImports(_ir));
    return imports.join("\n");
  }

  protected override emitPubkeyDeserializeSlice(sliceExpr: string): string {
    return `Pubkey::new_from_array(${sliceExpr}.try_into().map_err(|_| ProgramError::InvalidInstructionData)?)`;
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
    // Use the manually-emitted read() method — correct for all account structs
    // including those containing non-Borsh enum fields (which would fail try_from_slice)
    return `    let ${mutKeyword}${localVar} = ${typeName}::read(&${accountName}.data.borrow())?;`;
  }

  override emitStateSave(accountName: string, typeName: string, localVar: string): string {
    // Use the manually-emitted write() method — consistent with read()
    return `    ${typeName}::write(&mut ${accountName}.data.borrow_mut(), &${localVar})?;`;
  }

  override emitBumpSeed(_programId: string, seeds: string[], expectedKey: string): string {
    const seedsStr = seeds.map((s) => `${s}`).join(", ");
    return `    let (expected_key, bump) = Pubkey::find_program_address(&[${seedsStr}], program_id);
    if expected_key != *${expectedKey}.key {
        return Err(ProgramError::InvalidSeeds);
    }`;
  }

  override emitSystemTransfer(from: string, to: string, amount: string, signerSeeds?: string): string {
    if (signerSeeds) {
      return `    // System transfer with PDA signer
    let transfer_ix = system_instruction::transfer(${from}.key, ${to}.key, ${amount});
    invoke_signed(
        &transfer_ix,
        &[${from}.clone(), ${to}.clone()],
        ${signerSeeds},
    )?;`;
    }
    return `    // System transfer
    let transfer_ix = system_instruction::transfer(${from}.key, ${to}.key, ${amount});
    invoke(
        &transfer_ix,
        &[${from}.clone(), ${to}.clone()],
    )?;`;
  }

  override emitSplTransfer(from: string, to: string, authority: string, amount: string, signerSeeds?: string): string {
    if (signerSeeds) {
      return `    // SPL Token transfer (PDA signed) — ${from} → ${to}
    let transfer_ix = spl_token::instruction::transfer(
        &spl_token::id(),
        ${from}.key,
        ${to}.key,
        ${authority}.key,
        &[],
        ${amount},
    )?;
    invoke_signed(
        &transfer_ix,
        &[${from}.clone(), ${to}.clone(), ${authority}.clone()],
        ${signerSeeds},
    )?;`;
    }
    return `    // SPL Token transfer — ${from} → ${to}
    let transfer_ix = spl_token::instruction::transfer(
        &spl_token::id(),
        ${from}.key,
        ${to}.key,
        ${authority}.key,
        &[],
        ${amount},
    )?;
    invoke(
        &transfer_ix,
        &[${from}.clone(), ${to}.clone(), ${authority}.clone()],
    )?;`;
  }

  override emitSplMintTo(mint: string, to: string, authority: string, amount: string, signerSeeds?: string): string {
    const invokeType = signerSeeds ? "invoke_signed" : "invoke";
    const signerArg = signerSeeds ? `\n        ${signerSeeds},` : "";
    return `    // SPL Token mint_to — ${mint} → ${to}
    let mint_ix = spl_token::instruction::mint_to(
        &spl_token::id(),
        ${mint}.key,
        ${to}.key,
        ${authority}.key,
        &[],
        ${amount},
    )?;
    ${invokeType}(
        &mint_ix,
        &[${mint}.clone(), ${to}.clone(), ${authority}.clone()],${signerArg}
    )?;`;
  }

  override emitSplBurn(from: string, mint: string, authority: string, amount: string, signerSeeds?: string): string {
    const invokeType = signerSeeds ? "invoke_signed" : "invoke";
    const signerArg = signerSeeds ? `\n        ${signerSeeds},` : "";
    return `    // SPL Token burn — ${from}
    let burn_ix = spl_token::instruction::burn(
        &spl_token::id(),
        ${from}.key,
        ${mint}.key,
        ${authority}.key,
        &[],
        ${amount},
    )?;
    ${invokeType}(
        &burn_ix,
        &[${from}.clone(), ${mint}.clone(), ${authority}.clone()],${signerArg}
    )?;`;
  }

  override emitSplCloseAccount(account: string, destination: string, authority: string, signerSeeds?: string): string {
    const invokeType = signerSeeds ? "invoke_signed" : "invoke";
    const signerArg = signerSeeds ? `\n        ${signerSeeds},` : "";
    return `    // SPL Token close account — ${account}
    let close_ix = spl_token::instruction::close_account(
        &spl_token::id(),
        ${account}.key,
        ${destination}.key,
        ${authority}.key,
        &[],
    )?;
    ${invokeType}(
        &close_ix,
        &[${account}.clone(), ${destination}.clone(), ${authority}.clone()],${signerArg}
    )?;`;
  }

  override emitProgramAccountClose(account: string, destination: string): string {
    return `    close_program_account(${account}, ${destination})?;`;
  }

  override emitCreateProgramAccount(account: string, payer: string, spaceExpr: string, signerSeeds?: string): string {
    return `    create_program_account(${account}, ${payer}, (${spaceExpr}) as u64, program_id, ${signerSeeds ?? "&[]"})?;`;
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
    const resolvedTypeName = typeName || account.charAt(0).toUpperCase() + account.slice(1).replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());

    const transformedSeeds = seeds.map(seed => {
      if (seed.startsWith('b"') || seed.startsWith("b'")) return seed;
      if (seed.startsWith("&[") && stateVar) {
        return seed.replace(new RegExp(`&\\[${stateVar}\\.`), `&[${dataVar}.`);
      }
      if (stateVar && seed.startsWith(`${stateVar}.`)) {
        return seed.replace(new RegExp(`^${stateVar}\\.`), `${dataVar}.`);
      }
      if (!stateVar && seed.startsWith(`${account}.`)) {
        return seed.replace(new RegExp(`^${account}\\.`), `${dataVar}.`);
      }
      return seed;
    });

    const seedsStr = transformedSeeds.join(",\n            ");
    const shouldReadState = !!typeName && !!this.currentIr?.accounts.find((acc) => acc.name === typeName);
    const maybeRead = stateVar || !shouldReadState
      ? ""
      : `    let ${dataVar} = ${resolvedTypeName}::try_from_slice(&${accountInfoVar}.data.borrow()[8..])?;\n`;
    return `    // PDA signer seeds for '${account}'
${maybeRead}    let seeds = &[
            ${seedsStr},
        ];
    let signer_seeds = &[&seeds[..]];`;
  }

  override emitRequire(condition: string, error: string): string {
    return emitRequireGuard(condition, error);
  }

  override emitMsg(message: string): string {
    return `    msg!(${message});`;
  }

  override emitEmit(event: string, _fields: string): string {
    return `    // Event: ${event}
    msg!("event:${event}");`;
  }

  override emitClockGet(localVar: string): string {
    return `    let ${localVar} = solana_program::sysvar::clock::Clock::get()?;`;
  }

  override emitRentGet(localVar: string): string {
    return `    let ${localVar} = solana_program::sysvar::rent::Rent::get()?;`;
  }

  override rustTypeForFramework(typeName: string): string {
    return typeName;
  }

  override emitPubkeyDeserialize(start: number, end: number): string {
    return `Pubkey::new_from_array(
        data[${start}..${end}]
            .try_into()
            .map_err(|_| ProgramError::InvalidInstructionData)?
    )`;
  }

  // Native Pubkey wraps [u8;32] via new_from_array — so field reads use that constructor
  protected override emitPubkeyFieldRead(_size: number): string {
    return `Pubkey::new_from_array(
            data[offset..offset + 32]
                .try_into()
                .map_err(|_| ProgramError::InvalidAccountData)?
        )`;
  }

  // Native Pubkey.as_ref() gives &[u8] for copy_from_slice
  protected override emitPubkeyFieldAsRef(): string {
    return ".as_ref()";
  }

  override emitAccountStruct(acc: AccountDef): string {
    const fields = acc.fields
      .map((f) => `    pub ${snakeCase(f.name)}: ${this.rustTypeForFramework(f.type)},`)
      .join("\n");

    const bodyLen = acc.fields.reduce((s, f) => s + this.resolveTypeSize(f.type), 0);
    const readLines = this.buildReadLines(acc);
    const writeLines = this.buildWriteLines(acc);
    const ctorFields = acc.fields.map((f) => snakeCase(f.name)).join(", ");

    // We emit a #[repr(C)] struct with a complete manual read()/write() implementation.
    // We do NOT emit #[derive(BorshSerialize, BorshDeserialize)] because:
    //  - The struct already has a correct byte-layout via read()/write().
    //  - Structs containing custom enum fields (e.g. #[repr(u8)] enums) would
    //    fail Borsh compilation since those enums don't implement BorshSerialize.
    return `#[repr(C)]
pub struct ${acc.name} {
${fields}
}

impl ${acc.name} {
    pub const DISCRIMINATOR: [u8; 8] = ${this.accountDiscriminatorExpr(acc.name)};
    pub const INIT_SPACE: usize = ${bodyLen};
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
}

impl std::fmt::Display for ${enumName} {
    fn fmt(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
        write!(f, "{:?}", self)
    }
}

impl std::error::Error for ${enumName} {}`;
  }

  override emitHelperFunctions(_ir: SolanaIR): string {
    const helpers: string[] = [];

    if (irNeedsInitAccountHelper(_ir)) {
      helpers.push(`fn create_program_account(
    account: &AccountInfo,
    payer: &AccountInfo,
    space: u64,
    program_id: &Pubkey,
    signer_seeds: &[&[&[u8]]],
) -> ProgramResult {
    let rent = solana_program::sysvar::rent::Rent::get()?;
    let lamports = rent.minimum_balance(space as usize);
    let create_ix = system_instruction::create_account(
        payer.key,
        account.key,
        lamports,
        space,
        program_id,
    );
    invoke_signed(
        &create_ix,
        &[payer.clone(), account.clone()],
        signer_seeds,
    )?;
    Ok(())
}`);
    }

    if (irNeedsUnsignedLamportsHelper(_ir)) {
      helpers.push(`fn transfer_lamports(
    from: &AccountInfo,
    to: &AccountInfo,
    amount: u64,
) -> ProgramResult {
    let transfer_ix = system_instruction::transfer(from.key, to.key, amount);
    invoke(
        &transfer_ix,
        &[from.clone(), to.clone()],
    )?;
    Ok(())
}`);
    }

    if (irNeedsSignedLamportsHelper(_ir)) {
      helpers.push(`fn transfer_lamports_signed(
    from: &AccountInfo,
    to: &AccountInfo,
    amount: u64,
    signer_seeds: &[&[&[u8]]],
) -> ProgramResult {
    let transfer_ix = system_instruction::transfer(from.key, to.key, amount);
    invoke_signed(
        &transfer_ix,
        &[from.clone(), to.clone()],
        signer_seeds,
    )?;
    Ok(())
}`);
    }

    if (irNeedsHelper(_ir, "spl_transfer")) {
      helpers.push(`fn spl_token_transfer(
    from: &AccountInfo,
    to: &AccountInfo,
    authority: &AccountInfo,
    amount: u64,
) -> ProgramResult {
    let transfer_ix = spl_token::instruction::transfer(
        &spl_token::id(),
        from.key,
        to.key,
        authority.key,
        &[],
        amount,
    )?;
    invoke(
        &transfer_ix,
        &[from.clone(), to.clone(), authority.clone()],
    )?;
    Ok(())
}

fn spl_token_transfer_signed(
    from: &AccountInfo,
    to: &AccountInfo,
    authority: &AccountInfo,
    amount: u64,
    signer_seeds: &[&[&[u8]]],
) -> ProgramResult {
    let transfer_ix = spl_token::instruction::transfer(
        &spl_token::id(),
        from.key,
        to.key,
        authority.key,
        &[],
        amount,
    )?;
    invoke_signed(
        &transfer_ix,
        &[from.clone(), to.clone(), authority.clone()],
        signer_seeds,
    )?;
    Ok(())
}`);
    }

    const needsUnsignedMintTo = irNeedsUnsignedSplMintToHelper(_ir);
    if (needsUnsignedMintTo) {
      helpers.push(`fn spl_token_mint_to(
    mint: &AccountInfo,
    to: &AccountInfo,
    authority: &AccountInfo,
    amount: u64,
) -> ProgramResult {
    let mint_ix = spl_token::instruction::mint_to(
        &spl_token::id(),
        mint.key,
        to.key,
        authority.key,
        &[],
        amount,
    )?;
    invoke(
        &mint_ix,
        &[mint.clone(), to.clone(), authority.clone()],
    )?;
    Ok(())
}`);
    }

    const needsSignedMintTo = irNeedsSignedSplMintToHelper(_ir);
    if (needsSignedMintTo) {
      helpers.push(`fn spl_token_mint_to_signed(
    mint: &AccountInfo,
    to: &AccountInfo,
    authority: &AccountInfo,
    amount: u64,
    signer_seeds: &[&[&[u8]]],
) -> ProgramResult {
    let mint_ix = spl_token::instruction::mint_to(
        &spl_token::id(),
        mint.key,
        to.key,
        authority.key,
        &[],
        amount,
    )?;
    invoke_signed(
        &mint_ix,
        &[mint.clone(), to.clone(), authority.clone()],
        signer_seeds,
    )?;
    Ok(())
}`);
    }

    const needsUnsignedBurn = irNeedsUnsignedSplBurnHelper(_ir);
    if (needsUnsignedBurn) {
      helpers.push(`fn spl_token_burn(
    from: &AccountInfo,
    mint: &AccountInfo,
    authority: &AccountInfo,
    amount: u64,
) -> ProgramResult {
    let burn_ix = spl_token::instruction::burn(
        &spl_token::id(),
        from.key,
        mint.key,
        authority.key,
        &[],
        amount,
    )?;
    invoke(
        &burn_ix,
        &[from.clone(), mint.clone(), authority.clone()],
    )?;
    Ok(())
}`);
    }

    const needsSignedBurn = irNeedsSignedSplBurnHelper(_ir);
    if (needsSignedBurn) {
      helpers.push(`fn spl_token_burn_signed(
    from: &AccountInfo,
    mint: &AccountInfo,
    authority: &AccountInfo,
    amount: u64,
    signer_seeds: &[&[&[u8]]],
) -> ProgramResult {
    let burn_ix = spl_token::instruction::burn(
        &spl_token::id(),
        from.key,
        mint.key,
        authority.key,
        &[],
        amount,
    )?;
    invoke_signed(
        &burn_ix,
        &[from.clone(), mint.clone(), authority.clone()],
        signer_seeds,
    )?;
    Ok(())
}`);
    }

    const needsUnsignedClose = irNeedsUnsignedSplCloseAccountHelper(_ir);
    if (needsUnsignedClose) {
      helpers.push(`fn spl_token_close_account(
    account: &AccountInfo,
    destination: &AccountInfo,
    authority: &AccountInfo,
) -> ProgramResult {
    let close_ix = spl_token::instruction::close_account(
        &spl_token::id(),
        account.key,
        destination.key,
        authority.key,
        &[],
    )?;
    invoke(
        &close_ix,
        &[account.clone(), destination.clone(), authority.clone()],
    )?;
    Ok(())
}`);
    }

    const needsSignedClose = irNeedsSignedSplCloseAccountHelper(_ir);
    if (needsSignedClose) {
      helpers.push(`fn spl_token_close_account_signed(
    account: &AccountInfo,
    destination: &AccountInfo,
    authority: &AccountInfo,
    signer_seeds: &[&[&[u8]]],
) -> ProgramResult {
    let close_ix = spl_token::instruction::close_account(
        &spl_token::id(),
        account.key,
        destination.key,
        authority.key,
        &[],
    )?;
    invoke_signed(
        &close_ix,
        &[account.clone(), destination.clone(), authority.clone()],
        signer_seeds,
    )?;
    Ok(())
}`);
    }

    if (irNeedsHelper(_ir, "close_program_account")) {
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
    account.data.borrow_mut().fill(0);
    Ok(())
}`);
    }

    if (irNeedsTokenAmountHelper(_ir)) {
      helpers.push(`/// Read the amount field from an SPL Token Account (offset 64, 8 bytes LE u64)
fn token_account_amount(account: &AccountInfo) -> Result<u64, ProgramError> {
    let data = account.data.borrow();
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

const emitter = new NativeEmitter();

export function emitNative(ir: SolanaIR): string {
  return emitter.emit(ir).singleFile;
}

export function emitNativeFull(ir: SolanaIR) {
  return emitter.emit(ir);
}

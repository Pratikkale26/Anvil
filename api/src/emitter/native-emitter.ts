/**
 * Native Emitter — Generic target emitter for native solana_program Rust.
 *
 * Extends BaseEmitter with native solana_program implementations.
 * No framework abstractions — uses raw solana_program and borsh for serialization.
 * Complete business logic generation via the BaseEmitter body walker.
 */

import type { SolanaIR, AccountDef } from "../ir/schema.js";
import type { Token2022Opts } from "./body-emitter/index.js";
import { BaseEmitter } from "./emitter-base.js";
import {
  instrDiscriminator,
  snakeCase,
  toPascalCase,
  isProgramAccount,
  emitRequireGuard,
} from "./emitter-utils.js";
import {
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
  irNeedsToken2022Helper,
  irNeedsAtaCreationHelper,
  irNeedsMemoHelper,
} from "./emitter-helpers.js";

/**
 * Token-2022 checked variants need the mint's `.decimals`. In Anchor source
 * code that's read via `ctx.accounts.<mint>.decimals` because Anchor parses
 * the mint account into a typed view; in native code we get a bare
 * `&AccountInfo` and have to unpack it ourselves. When the detector hands us
 * a decimals expression of the form `<mint>.decimals`, generate the unpack
 * prelude and substitute a local var. Otherwise (e.g. a literal `9` or some
 * other expression), pass through unchanged.
 */
function resolveT22Decimals(mint: string, decimals: string | undefined): { decimalsExpr: string; prelude: string } {
  const fallback = decimals ?? "/* TODO: decimals */";
  if (!decimals) return { decimalsExpr: fallback, prelude: "" };
  const accessRe = new RegExp(`^${mint}\\.decimals$`);
  if (!accessRe.test(decimals.trim())) return { decimalsExpr: fallback, prelude: "" };
  const localVar = `${mint}_decimals`;
  const prelude = `    let ${localVar} = {
        use solana_program::program_pack::Pack;
        spl_token_2022::state::Mint::unpack(&${mint}.data.borrow())?.decimals
    };
`;
  return { decimalsExpr: localVar, prelude };
}

class NativeEmitter extends BaseEmitter {
  override readonly frameworkName = "Native";

  override emitUseStatements(_ir: SolanaIR): string {
    // Token-2022 typed CPIs are inlined directly in the instruction body —
    // they don't go through the spl_token_*  helper functions, so the
    // helper-based triggers below miss them. Track them explicitly.
    const t22Cpis = _ir.instructions.flatMap((i) =>
      (i.body ?? []).filter((s) =>
        (s.kind === "cpi_spl_transfer" ||
          s.kind === "cpi_spl_mint_to" ||
          s.kind === "cpi_spl_burn" ||
          s.kind === "cpi_spl_close_account") &&
        s.tokenProgram === "token_2022"
      )
    );
    const t22NeedsInvoke = t22Cpis.some((s) => !(s as { signerSeeds?: string }).signerSeeds);
    const t22NeedsInvokeSigned = t22Cpis.some((s) => !!(s as { signerSeeds?: string }).signerSeeds);

    const needsInvoke = irNeedsUnsignedLamportsHelper(_ir)
      || irNeedsHelper(_ir, "spl_transfer")
      || irNeedsUnsignedSplMintToHelper(_ir)
      || irNeedsUnsignedSplBurnHelper(_ir)
      || irNeedsUnsignedSplCloseAccountHelper(_ir)
      || irNeedsAtaCreationHelper(_ir)
      || irNeedsMemoHelper(_ir)
      || t22NeedsInvoke;
    const needsInvokeSigned = irNeedsSignedLamportsHelper(_ir)
      || irNeedsSignedSplMintToHelper(_ir)
      || irNeedsSignedSplBurnHelper(_ir)
      || irNeedsSignedSplCloseAccountHelper(_ir)
      || irNeedsInitAccountHelper(_ir)
      || t22NeedsInvokeSigned;
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
    if (irNeedsToken2022Helper(_ir)) {
      imports.push(`// Token-2022: uses spl_token_2022 crate for instruction building`);
      imports.push(`use spl_token_2022;`);
    }
    if (irNeedsAtaCreationHelper(_ir)) {
      imports.push(`use spl_associated_token_account::instruction::create_associated_token_account;`);
    }
    if (irNeedsMemoHelper(_ir)) {
      imports.push(`use spl_memo;`);
    }

    // Add Clock import when any instruction uses sysvar_clock or pass_through references Clock::get
    const needsClock = _ir.instructions.some(i =>
      i.body.some(s =>
        s.kind === 'sysvar_clock' ||
        (s.kind === 'pass_through' && /\bClock::get\(\)/.test(s.code)) ||
        (s.kind === 'state_field_assign' && /\bClock::get\(\)/.test(s.value))
      )
    );
    if (needsClock) {
      imports.push(`use solana_program::sysvar::clock::Clock;`);
    }
    const needsRent = _ir.instructions.some(i =>
      i.body.some(s =>
        s.kind === 'sysvar_rent' ||
        (s.kind === 'pass_through' && /\bRent::\w/.test(s.code)) ||
        (s.kind === 'state_field_assign' && /\bRent::\w/.test(s.value))
      )
    );
    if (needsRent) {
      imports.push(`use solana_program::sysvar::rent::Rent;`);
    }

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

  override emitSplTransfer(from: string, to: string, authority: string, amount: string, signerSeeds?: string, opts?: Token2022Opts): string {
    const t22 = opts?.tokenProgram === "token_2022";
    const crate = t22 ? "spl_token_2022" : "spl_token";
    if (t22) {
      // Token-2022 deprecates `transfer`; must use `transfer_checked` with
      // mint + decimals. Detector backfills these from the TransferChecked
      // accounts struct + trailing decimals arg.
      const mint = opts?.mint ?? "/* TODO: mint */";
      const { decimalsExpr, prelude } = resolveT22Decimals(mint, opts?.decimals);
      const invokeType = signerSeeds ? "invoke_signed" : "invoke";
      const signerArg = signerSeeds ? `\n        ${signerSeeds},` : "";
      return `    // Token-2022 transfer_checked — ${from} → ${to}
${prelude}    let transfer_ix = ${crate}::instruction::transfer_checked(
        &${crate}::id(),
        ${from}.key,
        ${mint}.key,
        ${to}.key,
        ${authority}.key,
        &[],
        ${amount},
        ${decimalsExpr},
    )?;
    ${invokeType}(
        &transfer_ix,
        &[${from}.clone(), ${mint}.clone(), ${to}.clone(), ${authority}.clone()],${signerArg}
    )?;`;
    }
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

  override emitSplMintTo(mint: string, to: string, authority: string, amount: string, signerSeeds?: string, opts?: Token2022Opts): string {
    const t22 = opts?.tokenProgram === "token_2022";
    const crate = t22 ? "spl_token_2022" : "spl_token";
    const invokeType = signerSeeds ? "invoke_signed" : "invoke";
    const signerArg = signerSeeds ? `\n        ${signerSeeds},` : "";
    if (t22) {
      const { decimalsExpr, prelude } = resolveT22Decimals(mint, opts?.decimals);
      return `    // Token-2022 mint_to_checked — ${mint} → ${to}
${prelude}    let mint_ix = ${crate}::instruction::mint_to_checked(
        &${crate}::id(),
        ${mint}.key,
        ${to}.key,
        ${authority}.key,
        &[],
        ${amount},
        ${decimalsExpr},
    )?;
    ${invokeType}(
        &mint_ix,
        &[${mint}.clone(), ${to}.clone(), ${authority}.clone()],${signerArg}
    )?;`;
    }
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

  override emitSplBurn(from: string, mint: string, authority: string, amount: string, signerSeeds?: string, opts?: Token2022Opts): string {
    const t22 = opts?.tokenProgram === "token_2022";
    const crate = t22 ? "spl_token_2022" : "spl_token";
    const invokeType = signerSeeds ? "invoke_signed" : "invoke";
    const signerArg = signerSeeds ? `\n        ${signerSeeds},` : "";
    if (t22) {
      const { decimalsExpr, prelude } = resolveT22Decimals(mint, opts?.decimals);
      return `    // Token-2022 burn_checked — ${from}
${prelude}    let burn_ix = ${crate}::instruction::burn_checked(
        &${crate}::id(),
        ${from}.key,
        ${mint}.key,
        ${authority}.key,
        &[],
        ${amount},
        ${decimalsExpr},
    )?;
    ${invokeType}(
        &burn_ix,
        &[${from}.clone(), ${mint}.clone(), ${authority}.clone()],${signerArg}
    )?;`;
    }
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

  override emitSplCloseAccount(account: string, destination: string, authority: string, signerSeeds?: string, opts?: Token2022Opts): string {
    const crate = opts?.tokenProgram === "token_2022" ? "spl_token_2022" : "spl_token";
    const invokeType = signerSeeds ? "invoke_signed" : "invoke";
    const signerArg = signerSeeds ? `\n        ${signerSeeds},` : "";
    return `    // ${crate === "spl_token_2022" ? "Token-2022" : "SPL Token"} close account — ${account}
    let close_ix = ${crate}::instruction::close_account(
        &${crate}::id(),
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

  override emitCreateAta(ata: string, payer: string, mint: string, authority: string, _signerSeeds?: string): string {
    return `    // Create Associated Token Account: ${ata}
    let create_ata_ix = create_associated_token_account(
        ${payer}.key,
        ${authority}.key,
        ${mint}.key,
        &spl_token::id(),
    );
    invoke(
        &create_ata_ix,
        &[${payer}.clone(), ${ata}.clone(), ${authority}.clone(), ${mint}.clone()],
    )?;`;
  }

  override emitMemo(data: string, _signerSeeds?: string): string {
    // spl_memo crate exposes build_memo(memo: &[u8], signer_pubkeys: &[&Pubkey]).
    // We coerce string literals to bytes via .as_bytes(); other expressions
    // are passed through as a slice — caller is responsible for &[u8] shape.
    const bytesExpr = /^".*"$/.test(data.trim()) ? `${data}.as_bytes()` : data;
    return `    // SPL Memo CPI
    invoke(
        &spl_memo::build_memo(${bytesExpr}, &[]),
        &[],
    )?;`;
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
      // Don't rewrite key references — they are account key accesses, not state field reads
      if (/\.key\(\)\.as_ref\(\)$/.test(seed) || /\.key\.as_ref\(\)$/.test(seed)) return seed;
      if (seed.startsWith("&[") && stateVar) {
        return seed.replace(new RegExp(`&\\[${stateVar}\\.`), `&[${dataVar}.`);
      }
      if (stateVar && seed.startsWith(`${stateVar}.`)) {
        return seed.replace(new RegExp(`^${stateVar}\\.`), `${dataVar}.`);
      }
      if (!stateVar && seed.startsWith(`${account}.`)) {
        // Don't rewrite if the rest is just .as_ref(), .key(), etc. — not a state field
        const rest = seed.slice(account.length + 1);
        if (/^(?:as_ref\(\)|key|key\(\)|key\(\)\.as_ref\(\)|key\.as_ref\(\))$/.test(rest)) return seed;
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

  override emitEmit(event: string, fields: string): string {
    if (!fields.trim()) {
      return `    msg!("event:${event}");`;
    }
    // Preserve event field data as comments so the developer can add proper serialization
    return `    // Event: ${event}
    msg!("event:${event}");
    // Event data: ${fields.replace(/\n/g, " ")}`;
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
    pub const SPACE: usize = Self::TOTAL_LEN;
    pub const SIZE: usize = Self::TOTAL_LEN;

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

    /// Borsh-style convenience wrapper: borrow the account's data buffer
    /// and write the value into it. Mirrors Pinocchio's save() so the same
    /// emitter call site (\`Type::save(account, &value)\`) works on both.
    pub fn save(account: &AccountInfo, value: &Self) -> ProgramResult {
        let mut data = account.try_borrow_mut_data()?;
        Self::write(&mut data, value)
    }
}`;
  }

  override emitErrorEnum(ir: SolanaIR): string {
    // Deduplicate error variants by name (keep first occurrence)
    const seen = new Set<string>();
    const dedupedErrors = ir.errors.filter(e => {
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
      helpers.push(`pub fn create_program_account<'a>(
    account: &AccountInfo<'a>,
    payer: &AccountInfo<'a>,
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
      helpers.push(`pub fn transfer_lamports<'a>(
    from: &AccountInfo<'a>,
    to: &AccountInfo<'a>,
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
      helpers.push(`pub fn transfer_lamports_signed<'a>(
    from: &AccountInfo<'a>,
    to: &AccountInfo<'a>,
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
      helpers.push(`pub fn spl_token_transfer<'a>(
    from: &AccountInfo<'a>,
    to: &AccountInfo<'a>,
    authority: &AccountInfo<'a>,
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

pub fn spl_token_transfer_signed<'a>(
    from: &AccountInfo<'a>,
    to: &AccountInfo<'a>,
    authority: &AccountInfo<'a>,
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
      helpers.push(`pub fn spl_token_mint_to<'a>(
    mint: &AccountInfo<'a>,
    to: &AccountInfo<'a>,
    authority: &AccountInfo<'a>,
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
      helpers.push(`pub fn spl_token_mint_to_signed<'a>(
    mint: &AccountInfo<'a>,
    to: &AccountInfo<'a>,
    authority: &AccountInfo<'a>,
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
      helpers.push(`pub fn spl_token_burn<'a>(
    from: &AccountInfo<'a>,
    mint: &AccountInfo<'a>,
    authority: &AccountInfo<'a>,
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
      helpers.push(`pub fn spl_token_burn_signed<'a>(
    from: &AccountInfo<'a>,
    mint: &AccountInfo<'a>,
    authority: &AccountInfo<'a>,
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
      helpers.push(`pub fn spl_token_close_account<'a>(
    account: &AccountInfo<'a>,
    destination: &AccountInfo<'a>,
    authority: &AccountInfo<'a>,
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
      helpers.push(`pub fn spl_token_close_account_signed<'a>(
    account: &AccountInfo<'a>,
    destination: &AccountInfo<'a>,
    authority: &AccountInfo<'a>,
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
      helpers.push(`pub fn close_program_account<'a>(
    account: &AccountInfo<'a>,
    destination: &AccountInfo<'a>,
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
pub fn token_account_amount<'a>(account: &AccountInfo<'a>) -> Result<u64, ProgramError> {
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

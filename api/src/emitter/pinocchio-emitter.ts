/**
 * Pinocchio Emitter — Generic target emitter for the Pinocchio framework.
 *
 * Extends BaseEmitter with Pinocchio-specific implementations.
 * All hardcoded counter/vault logic has been removed.
 * Business logic is now driven entirely by IR body statements.
 */

import type { SolanaIR, AccountDef } from "../ir/schema.js";
import type { Token2022Opts } from "./body-emitter/index.js";
import { BaseEmitter } from "./emitter-base.js";
import {
  instrDiscriminator,
  accountDiscriminator,
  snakeCase,
  toPascalCase,
  isProgramAccount,
  emitRequireGuard,
} from "./emitter-utils.js";
import {
  irNeedsHelper,
  irNeedsSignedLamportsHelper,
  irNeedsSignedSplBurnHelper,
  irNeedsSignedSplMintToHelper,
  irNeedsTokenAmountHelper,
  irNeedsUnsignedLamportsHelper,
  irNeedsUnsignedSplBurnHelper,
  irNeedsUnsignedSplMintToHelper,
  irNeedsSignedSplCloseAccountHelper,
  irNeedsUnsignedSplCloseAccountHelper,
  irNeedsInitAccountHelper,
  irNeedsToken2022Helper,
  irNeedsAtaCreationHelper,
} from "./emitter-helpers.js";

class PinocchioEmitter extends BaseEmitter {
  override readonly frameworkName = "Pinocchio";

  override emitUseStatements(_ir: SolanaIR): string {
    const imports = [`use core::convert::TryInto;`,
`use borsh::{BorshDeserialize, BorshSerialize};`,
`use pinocchio::{
    account_info::AccountInfo,
    entrypoint,
    program_error::ProgramError,
    pubkey::Pubkey,
    ProgramResult,
};`];

    if (irNeedsHelper(_ir, "transfer_lamports")) {
      imports.push(`use pinocchio_system::instructions::Transfer as SystemTransfer;`);
    }
    const needsSeedSigner = irNeedsInitAccountHelper(_ir)
      || irNeedsSignedLamportsHelper(_ir)
      || irNeedsSignedSplMintToHelper(_ir)
      || irNeedsSignedSplBurnHelper(_ir)
      || irNeedsSignedSplCloseAccountHelper(_ir)
      || irNeedsHelper(_ir, "spl_transfer");
    if (needsSeedSigner) {
      imports.push(`use pinocchio::instruction::{Seed, Signer};`);
    }
    if (irNeedsInitAccountHelper(_ir)) {
      imports.push(`use pinocchio_system::create_account_with_minimum_balance_signed;`);
    }
    if (irNeedsHelper(_ir, "spl_transfer") || irNeedsHelper(_ir, "spl_mint_to") || irNeedsHelper(_ir, "spl_burn")) {
      imports.push(`use pinocchio_token::instructions::Transfer as TokenTransfer;`);
    }
    if (irNeedsHelper(_ir, "spl_mint_to")) {
      imports.push(`use pinocchio_token::instructions::MintTo as TokenMintTo;`);
    }
    if (irNeedsHelper(_ir, "spl_burn")) {
      imports.push(`use pinocchio_token::instructions::Burn as TokenBurn;`);
    }
    if (irNeedsHelper(_ir, "spl_close_account")) {
      imports.push(`use pinocchio_token::instructions::CloseAccount as TokenCloseAccount;`);
    }
    if (irNeedsToken2022Helper(_ir)) {
      imports.push(`// Token-2022: same instruction structs, routed to token_2022 program at runtime`);
      imports.push(`use pinocchio_token::instructions::TransferChecked as Token2022TransferChecked;`);
    }
    if (irNeedsAtaCreationHelper(_ir)) {
      imports.push(`use pinocchio_associated_token_account::instructions::Create as CreateAssociatedToken;`);
    }

    // Add Clock import when any instruction uses sysvar_clock or pass_through references Clock::get
    const needsClock = _ir.instructions.some(i =>
      i.body.some(s =>
        s.kind === 'sysvar_clock' ||
        (s.kind === 'pass_through' && /\bClock::get\(\)/.test(s.code)) ||
        (s.kind === 'state_field_assign' && /\bClock::get\(\)/.test(s.value))
      )
    );
    const needsRent = _ir.instructions.some(i =>
      i.body.some(s =>
        s.kind === 'sysvar_rent' ||
        (s.kind === 'pass_through' && /\bRent::get\(\)/.test(s.code))
      )
    );
    if (needsClock) {
      imports.push(`use pinocchio::sysvars::clock::Clock;`);
    }
    if (needsRent) {
      imports.push(`use pinocchio::sysvars::rent::Rent;`);
    }
    if (needsClock || needsRent) {
      imports.push(`use pinocchio::sysvars::Sysvar;`);
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
    // pinocchio 0.9 made AccountInfo::owner() a safe fn (returns &Pubkey
    // borrowed from the account header). Wrapping the call in `unsafe { }`
    // produces a noisy "unnecessary unsafe block" warning per instruction.
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

  override emitStateRead(accountName: string, typeName: string, localVar: string, mutable: boolean): string {
    const mutKeyword = mutable ? "mut " : "";
    return `    let ${mutKeyword}${localVar} = ${typeName}::from_account_info(${accountName})?;`;
  }

  override emitStateSave(accountName: string, _typeName: string, localVar: string): string {
    return `    ${_typeName}::save(${accountName}, &${localVar})?;`;
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
    const bumpLine = `    let bump = bump_seed(program_id, &[${seedsStr}], ${expectedKey}.key())?;`;
    return prelude.length > 0 ? `${prelude.join("\n")}\n${bumpLine}` : bumpLine;
  }

  override emitSystemTransfer(from: string, to: string, amount: string, signerSeeds?: string): string {
    if (signerSeeds) {
      return `    // System transfer with PDA signer
    transfer_lamports_signed(${from}, ${to}, ${amount}, ${signerSeeds})?;`;
    }
    return `    transfer_lamports(${from}, ${to}, ${amount})?;`;
  }

  override emitSplTransfer(from: string, to: string, authority: string, amount: string, signerSeeds?: string, _opts?: Token2022Opts): string {
    if (signerSeeds) {
      return `    // SPL Token transfer (PDA signed) — ${from} → ${to}
    spl_token_transfer_signed(${from}, ${to}, ${authority}, ${amount}, ${signerSeeds})?;`;
    }
    return `    // SPL Token transfer — ${from} → ${to}
    spl_token_transfer(${from}, ${to}, ${authority}, ${amount})?;`;
  }

  override emitSplMintTo(mint: string, to: string, authority: string, amount: string, signerSeeds?: string, _opts?: Token2022Opts): string {
    const signed = signerSeeds ? "_signed" : "";
    return `    // SPL Token mint_to — ${mint} → ${to}
    spl_token_mint_to${signed}(${mint}, ${to}, ${authority}, ${amount}${signerSeeds ? `, ${signerSeeds}` : ""})?;`;
  }

  override emitSplBurn(from: string, mint: string, authority: string, amount: string, signerSeeds?: string, _opts?: Token2022Opts): string {
    const signed = signerSeeds ? "_signed" : "";
    return `    // SPL Token burn — ${from}
    spl_token_burn${signed}(${from}, ${mint}, ${authority}, ${amount}${signerSeeds ? `, ${signerSeeds}` : ""})?;`;
  }

  override emitSplCloseAccount(account: string, destination: string, authority: string, signerSeeds?: string, _opts?: Token2022Opts): string {
    const signed = signerSeeds ? "_signed" : "";
    return `    // SPL Token close account — ${account}
    spl_token_close_account${signed}(${account}, ${destination}, ${authority}${signerSeeds ? `, ${signerSeeds}` : ""})?;`;
  }

  override emitProgramAccountClose(account: string, destination: string): string {
    return `    close_program_account(${account}, ${destination})?;`;
  }

  override emitCreateProgramAccount(account: string, payer: string, spaceExpr: string, signerSeeds?: string): string {
    return `    create_program_account(${account}, ${payer}, (${spaceExpr}) as usize, program_id, ${signerSeeds ?? "&[]"})?;`;
  }

  override emitCreateAta(ata: string, payer: string, mint: string, authority: string, _signerSeeds?: string): string {
    // pinocchio_associated_token_account 0.4 takes &AccountView, but pinocchio
    // 0.9's account slice gives us &AccountInfo. Different types, no automatic
    // conversion. So we hand-roll the CPI against the SPL ATA program ID
    // (ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL) — pubkey bytes are a
    // const, instruction data is empty, accounts list matches the Anchor ATA
    // create order: payer, ata, owner, mint, system_program, token_program.
    return `    // Create Associated Token Account: ${ata}
    {
        const ATA_PROGRAM_ID: pinocchio::pubkey::Pubkey = [
            140, 151, 37, 143, 78, 36, 137, 241, 187, 61, 16, 41, 20, 142, 13, 131,
            11, 90, 19, 153, 218, 255, 16, 132, 4, 142, 123, 216, 219, 233, 248, 89,
        ];
        let __ata_metas = [
            pinocchio::instruction::AccountMeta::new(${payer}.key(), true, true),
            pinocchio::instruction::AccountMeta::new(${ata}.key(), true, false),
            pinocchio::instruction::AccountMeta::new(${authority}.key(), false, false),
            pinocchio::instruction::AccountMeta::new(${mint}.key(), false, false),
            pinocchio::instruction::AccountMeta::new(system_program.key(), false, false),
            pinocchio::instruction::AccountMeta::new(token_program.key(), false, false),
        ];
        let __ata_ix = pinocchio::instruction::Instruction {
            program_id: &ATA_PROGRAM_ID,
            accounts: &__ata_metas,
            data: &[],
        };
        pinocchio::cpi::invoke(
            &__ata_ix,
            &[${payer}, ${ata}, ${authority}, ${mint}, system_program, token_program],
        )?;
    }`;
  }

  override emitMemo(data: string, _signerSeeds?: string): string {
    // No first-party pinocchio_memo crate in the 0.9 ecosystem — hand-roll
    // a CPI against the SPL Memo program ID
    // (MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr). Memo data is the
    // instruction payload; no accounts are required.
    const bytesExpr = /^".*"$/.test(data.trim()) ? `${data}.as_bytes()` : data;
    return `    // SPL Memo CPI
    {
        const MEMO_PROGRAM_ID: pinocchio::pubkey::Pubkey = [
            5, 74, 83, 90, 153, 41, 33, 6, 77, 36, 232, 113, 96, 218, 56, 124,
            124, 53, 181, 221, 188, 146, 187, 129, 228, 31, 168, 64, 65, 5, 68, 141,
        ];
        let __memo_ix = pinocchio::instruction::Instruction {
            program_id: &MEMO_PROGRAM_ID,
            accounts: &[],
            data: ${bytesExpr},
        };
        pinocchio::cpi::invoke(&__memo_ix, &[])?;
    }`;
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
    const shouldReadState = !!typeName && !!this.currentIr?.accounts.find((acc) => acc.name === typeName);

    // Transform seed expressions from Anchor-style to Pinocchio-style
    const prelude: string[] = [];
    let tempCount = 0;
    const transformedSeeds = seeds.map((seed) => {
      // b"literal" stays unchanged
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
      const keyAsRefMatch = seed.match(/^(\w+)\.key\(\)\.as_ref\(\)$/);
      if (keyAsRefMatch?.[1]) {
        const name = keyAsRefMatch[1];
        if (name.endsWith("_account")) return `${name}.key().as_ref()`;
        if (name === account) return `${accountInfoVar}.key().as_ref()`;
        if (stateVar && name === stateVar) return `${accountInfoVar}.key().as_ref()`;
        return `${name}_account.key().as_ref()`;
      }
      // &[account.bump] → &[data_var.bump]
      if (rewritePrefix && seed.startsWith("&[")) {
        return seed.replace(new RegExp(`&\\[${rewritePrefix}\\.`), `&[${dataVar}.`);
      }
      // account.field.method() → data_var.field.method()
      if (rewritePrefix) {
        return seed.replace(new RegExp(`^${rewritePrefix}\\.`), `${dataVar}.`);
      }
      return seed;
    });

    const seedsStr = transformedSeeds.join(",\n            ");
    const resolvedTypeName = typeName || account.charAt(0).toUpperCase() + account.slice(1).replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
    const maybeRead = stateVar || !shouldReadState ? "" : `    let ${dataVar} = ${resolvedTypeName}::from_account_info(${accountInfoVar})?;\n`;
    return `    // PDA signer seeds for '${account}'
${maybeRead}${prelude.length > 0 ? `${prelude.join("\n")}\n` : ""}    let seeds = &[
            ${seedsStr},
        ];
    let signer_seeds = &[&seeds[..]];`;
  }

  override emitRequire(condition: string, error: string): string {
    return emitRequireGuard(condition, error);
  }

  override emitCreateAccountCpi(
    from: string,
    to: string,
    lamports: string,
    space: string,
    _owner: string,
  ): string {
    return `// System Program: create_account\n    pinocchio_system::instructions::CreateAccount {\n        from: ${from},\n        to: ${to},\n        lamports: ${lamports},\n        space: ${space} as u64,\n        owner: program_id,\n    }.invoke()?;`;
  }

  override emitMsg(message: string): string {
    // `message` is the raw inside of msg!(...). Three shapes to handle:
    //   1. "literal"            → log the literal as-is
    //   2. "fmt", arg1, arg2    → collapse to logging just the format string
    //                             (sol_log has no format support; at least keep
    //                             the string instead of silently dropping it)
    //   3. expr / variable      → pass through (advanced users wiring their own)
    //
    // The previous naïve `indexOf(",")` treated commas *inside* string literals
    // as format separators, truncating `"Hello, Solana!"` to `"Hello`. Now we
    // only trust the full-literal match.
    const literalMatch = message.match(/^"([^"\\]|\\.)*"/);
    if (literalMatch?.[0]) {
      const literal = literalMatch[0];
      if (literal === message.trim()) {
        // Shape 1: pure string literal, no format args.
        return `    pinocchio::log::sol_log(${literal});`;
      }
      // Shape 2: literal followed by more (format args). Collapse.
      return `    // ⚠️ Anvil: formatted msg!() collapsed to static sol_log for Pinocchio\n    pinocchio::log::sol_log(${literal});`;
    }
    // Shape 3: no leading literal. Pass through and let the compiler /
    // developer catch anything weird.
    return `    pinocchio::log::sol_log(${message});`;
  }

  override emitEmit(event: string, fields: string): string {
    if (!fields.trim()) {
      return `    pinocchio::log::sol_log("event:${event}");`;
    }
    // Preserve event field data as comments so the developer can add proper serialization
    return `    // Event: ${event}
    pinocchio::log::sol_log("event:${event}");
    // Event data: ${fields.replace(/\n/g, " ")}`;
  }

  override emitClockGet(localVar: string): string {
    return `    let ${localVar} = pinocchio::sysvars::clock::Clock::get()?;`;
  }

  override emitRentGet(localVar: string): string {
    return `    let ${localVar} = pinocchio::sysvars::rent::Rent::get()?;`;
  }

  override rustTypeForFramework(typeName: string): string {
    if (typeName === "Pubkey") return "[u8; 32]";
    // String is kept as-is. Pinocchio doesn't add std::String constraints
    // at the type level; borsh handles (de)serialization via the borsh
    // feature we already depend on.
    return typeName;
  }

  // Pinocchio: Pubkey IS [u8; 32], so deserialization in arg parsing is a raw slice
  override emitPubkeyDeserialize(start: number, end: number): string {
    return `data[${start}..${end}].try_into().map_err(|_| ProgramError::InvalidInstructionData)?`;
  }

  protected override emitPubkeyDeserializeSlice(sliceExpr: string): string {
    return `${sliceExpr}.try_into().map_err(|_| ProgramError::InvalidInstructionData)?`;
  }

  // Pinocchio: [u8;32] IS a byte slice — read directly, no .as_ref() needed.
  protected override emitPubkeyFieldRead(_size: number): string {
    return `data[offset..offset + 32].try_into().map_err(|_| ProgramError::InvalidAccountData)?`;
  }

  // Pinocchio: [u8;32] IS a byte slice — no .as_ref() needed for copy_from_slice
  protected override emitPubkeyFieldAsRef(): string {
    return "";
  }

  // Pinocchio: Pubkey is [u8; 32] — Pubkey::default() does not exist
  protected override defaultPubkeyValue(): string {
    return "[0u8; 32]";
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
}`;
  }

  override emitHelperFunctions(ir: SolanaIR): string {
    const helpers: string[] = [];

    helpers.push(`pub fn bump_seed(
    program_id: &Pubkey,
    seeds: &[&[u8]],
    expected: &Pubkey,
) -> Result<u8, ProgramError> {
    for bump in (0..=255u8).rev() {
        let mut seeds_with_bump: [&[u8]; 16] = [&[]; 16];
        let len = seeds.len().min(15);
        seeds_with_bump[..len].copy_from_slice(&seeds[..len]);
        let bump_slice = &[bump];
        seeds_with_bump[len] = bump_slice;
        if let Ok(derived) = pinocchio::pubkey::create_program_address(&seeds_with_bump[..len + 1], program_id) {
            if &derived == expected {
                return Ok(bump);
            }
        }
    }
    Err(ProgramError::InvalidSeeds)
}`);

    if (irNeedsUnsignedLamportsHelper(ir)) {
      helpers.push(`pub fn transfer_lamports(
    from: &AccountInfo,
    to: &AccountInfo,
    amount: u64,
) -> ProgramResult {
    SystemTransfer {
        from,
        to,
        lamports: amount,
    }
    .invoke()
}`);
    }

    if (irNeedsSignedLamportsHelper(ir)) {
      helpers.push(`pub fn transfer_lamports_signed(
    from: &AccountInfo,
    to: &AccountInfo,
    amount: u64,
    signer_seeds: &[&[&[u8]]],
) -> ProgramResult {
    let seed_group = signer_seeds.first().ok_or(ProgramError::InvalidSeeds)?;
    let mut seeds: [Seed<'_>; 8] = core::array::from_fn(|_| Seed::from(&[][..]));
    for (i, seed) in seed_group.iter().enumerate() {
        if i >= seeds.len() { return Err(ProgramError::InvalidSeeds); }
        seeds[i] = Seed::from(*seed);
    }
    let signer = Signer::from(&seeds[..seed_group.len()]);
    SystemTransfer {
        from,
        to,
        lamports: amount,
    }
    .invoke_signed(&[signer])
}`);
    }

    if (irNeedsInitAccountHelper(ir)) {
      helpers.push(`pub fn create_program_account(
    account: &AccountInfo,
    payer: &AccountInfo,
    space: usize,
    program_id: &Pubkey,
    signer_seeds: &[&[&[u8]]],
) -> ProgramResult {
    if signer_seeds.len() > 1 {
        return Err(ProgramError::InvalidSeeds);
    }

    let signer_storage = signer_seeds.first().map(|seed_group| {
        let mut seeds: [Seed<'_>; 8] = core::array::from_fn(|_| Seed::from(&[][..]));
        for (index, seed) in seed_group.iter().enumerate() {
            if index >= seeds.len() {
                return Err(ProgramError::InvalidSeeds);
            }
            seeds[index] = Seed::from(*seed);
        }
        Ok((seeds, seed_group.len()))
    }).transpose()?;

    let signer_slice = if let Some((ref seeds, len)) = signer_storage {
        let signer = Signer::from(&seeds[..len]);
        create_account_with_minimum_balance_signed(account, space, program_id, payer, None, &[signer])
    } else {
        create_account_with_minimum_balance_signed(account, space, program_id, payer, None, &[])
    };

    signer_slice
}`);
    }

    if (irNeedsHelper(ir, "spl_transfer")) {
      helpers.push(`pub fn spl_token_transfer(
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

pub fn spl_token_transfer_signed(
    from: &AccountInfo,
    to: &AccountInfo,
    authority: &AccountInfo,
    amount: u64,
    signer_seeds: &[&[&[u8]]],
) -> ProgramResult {
    let seed_group = signer_seeds.first().ok_or(ProgramError::InvalidSeeds)?;
    let mut seeds: [Seed<'_>; 8] = core::array::from_fn(|_| Seed::from(&[][..]));
    for (i, seed) in seed_group.iter().enumerate() {
        if i >= seeds.len() { return Err(ProgramError::InvalidSeeds); }
        seeds[i] = Seed::from(*seed);
    }
    let signer = Signer::from(&seeds[..seed_group.len()]);
    TokenTransfer {
        from,
        to,
        authority,
        amount,
    }
    .invoke_signed(&[signer])
}`);
    }

    const needsUnsignedMintTo = irNeedsUnsignedSplMintToHelper(ir);
    const needsSignedMintTo = irNeedsSignedSplMintToHelper(ir);
    if (needsUnsignedMintTo) {
      helpers.push(`pub fn spl_token_mint_to(
    mint: &AccountInfo,
    account: &AccountInfo,
    mint_authority: &AccountInfo,
    amount: u64,
) -> ProgramResult {
    TokenMintTo {
        mint,
        account,
        mint_authority,
        amount,
    }
    .invoke()
}`);
    }
    if (needsSignedMintTo) {
      helpers.push(`pub fn spl_token_mint_to_signed(
    mint: &AccountInfo,
    account: &AccountInfo,
    mint_authority: &AccountInfo,
    amount: u64,
    signer_seeds: &[&[&[u8]]],
) -> ProgramResult {
    let seed_group = signer_seeds.first().ok_or(ProgramError::InvalidSeeds)?;
    let mut seeds: [Seed<'_>; 8] = core::array::from_fn(|_| Seed::from(&[][..]));
    for (i, seed) in seed_group.iter().enumerate() {
        if i >= seeds.len() { return Err(ProgramError::InvalidSeeds); }
        seeds[i] = Seed::from(*seed);
    }
    let signer = Signer::from(&seeds[..seed_group.len()]);
    TokenMintTo {
        mint,
        account,
        mint_authority,
        amount,
    }
    .invoke_signed(&[signer])
}`);
    }

    const needsUnsignedBurn = irNeedsUnsignedSplBurnHelper(ir);
    const needsSignedBurn = irNeedsSignedSplBurnHelper(ir);
    if (needsUnsignedBurn) {
      helpers.push(`pub fn spl_token_burn(
    account: &AccountInfo,
    mint: &AccountInfo,
    authority: &AccountInfo,
    amount: u64,
) -> ProgramResult {
    TokenBurn {
        account,
        mint,
        authority,
        amount,
    }
    .invoke()
}`);
    }
    if (needsSignedBurn) {
      helpers.push(`pub fn spl_token_burn_signed(
    account: &AccountInfo,
    mint: &AccountInfo,
    authority: &AccountInfo,
    amount: u64,
    signer_seeds: &[&[&[u8]]],
) -> ProgramResult {
    let seed_group = signer_seeds.first().ok_or(ProgramError::InvalidSeeds)?;
    let mut seeds: [Seed<'_>; 8] = core::array::from_fn(|_| Seed::from(&[][..]));
    for (i, seed) in seed_group.iter().enumerate() {
        if i >= seeds.len() { return Err(ProgramError::InvalidSeeds); }
        seeds[i] = Seed::from(*seed);
    }
    let signer = Signer::from(&seeds[..seed_group.len()]);
    TokenBurn {
        account,
        mint,
        authority,
        amount,
    }
    .invoke_signed(&[signer])
}`);
    }

    const needsUnsignedCloseHelper = irNeedsUnsignedSplCloseAccountHelper(ir);
    const needsSignedCloseHelper = irNeedsSignedSplCloseAccountHelper(ir);
    if (needsUnsignedCloseHelper) {
      helpers.push(`pub fn spl_token_close_account(
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
      helpers.push(`pub fn spl_token_close_account_signed(
    account: &AccountInfo,
    destination: &AccountInfo,
    authority: &AccountInfo,
    signer_seeds: &[&[&[u8]]],
) -> ProgramResult {
    let seed_group = signer_seeds.first().ok_or(ProgramError::InvalidSeeds)?;
    let mut seeds: [Seed<'_>; 8] = core::array::from_fn(|_| Seed::from(&[][..]));
    for (i, seed) in seed_group.iter().enumerate() {
        if i >= seeds.len() { return Err(ProgramError::InvalidSeeds); }
        seeds[i] = Seed::from(*seed);
    }
    let signer = Signer::from(&seeds[..seed_group.len()]);
    TokenCloseAccount {
        account,
        destination,
        authority,
    }
    .invoke_signed(&[signer])
}`);
    }

    if (irNeedsHelper(ir, "close_program_account")) {
      helpers.push(`pub fn close_program_account(
    account: &AccountInfo,
    destination: &AccountInfo,
) -> ProgramResult {
    if account.key() == destination.key() {
        return Err(ProgramError::InvalidAccountData);
    }
    let lamports = account.lamports();
    {
        let destination_lamports = unsafe { destination.borrow_mut_lamports_unchecked() };
        *destination_lamports = destination_lamports
            .checked_add(lamports)
            .ok_or(ProgramError::ArithmeticOverflow)?;
    }
    {
        let account_lamports = unsafe { account.borrow_mut_lamports_unchecked() };
        *account_lamports = 0;
    }
    {
        // data doesn't need 'mut' on the binding — iter_mut() reborrows the
        // underlying &mut [u8] without needing the binding itself mutable.
        let data = unsafe { account.borrow_mut_data_unchecked() };
        for byte in data.iter_mut() {
            *byte = 0;
        }
    }
    Ok(())
}`);
    }

    // Only emit the token account amount reader if SPL token operations are present
    if (irNeedsTokenAmountHelper(ir)) {
      helpers.push(`/// Read the amount field from an SPL Token Account (offset 64, 8 bytes LE u64)
pub fn token_account_amount(account: &AccountInfo) -> Result<u64, ProgramError> {
    let data = unsafe { account.borrow_data_unchecked() };
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

// ─── Public API ──────────────────────────────────────────────────────────────

const emitter = new PinocchioEmitter();

/**
 * Emit a single combined Rust file targeting the Pinocchio framework.
 *
 * Convenience wrapper around `emitPinocchioFull` that returns only the
 * single-file string output, discarding multi-file layout, warnings,
 * and transform reports.
 *
 * @param ir - Validated SolanaIR object
 * @returns Combined single-file Pinocchio Rust source
 */
export function emitPinocchio(ir: SolanaIR): string {
  return emitter.emit(ir).singleFile;
}

/**
 * Emit a full Pinocchio project from the given SolanaIR.
 *
 * Returns multi-file output (lib.rs, state.rs, instructions/, errors.rs),
 * a combined single-file fallback, warnings, and a transform report
 * detailing how many body statements were framework-transformed vs
 * passed through as raw Rust.
 *
 * @param ir - Validated SolanaIR object
 * @returns `EmitterOutput` with files, singleFile, warnings, and transformReport
 */
export function emitPinocchioFull(ir: SolanaIR) {
  return emitter.emit(ir);
}

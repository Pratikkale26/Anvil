/**
 * Quasar Emitter — Generates real quasar-lang code targeting the quasar-lang API.
 *
 * Extends BaseEmitter with Quasar-specific implementations.
 *
 * Multi-file output: Delegates to quasar-project-emitter.ts for proper
 * quasar-lang project structure using macros (#[program], #[derive(Accounts)],
 * #[account], declare_id!).
 *
 * Single-file output: Uses manual entrypoint/routing/serialization with
 * pinocchio-compatible types as a fallback (quasar's macros require multi-file).
 */

import type {
  SolanaIR,
  AccountDef,
  Instruction,
  EmitterOutput,
} from "../ir/schema.js";
import type { Token2022Opts } from "./body-emitter/index.js";
import { BaseEmitter } from "./emitter-base.js";
import {
  instrDiscriminator,
  accountDiscriminator,
  snakeCase,
  emitRequireGuard,
} from "./emitter-utils.js";
import {
  irNeedsHelper,
  irNeedsSignedLamportsHelper,
  irNeedsSignedSplBurnHelper,
  irNeedsSignedSplMintToHelper,
  irNeedsUnsignedLamportsHelper,
  irNeedsUnsignedSplBurnHelper,
  irNeedsUnsignedSplMintToHelper,
  irNeedsSignedSplCloseAccountHelper,
  irNeedsUnsignedSplCloseAccountHelper,
  irNeedsTokenAmountHelper,
  irNeedsInitAccountHelper,
  irNeedsToken2022Helper,
  irNeedsAtaCreationHelper,
} from "./emitter-helpers.js";
import {
  emitQuasarProjectFiles,
  type QuasarEmitterBridge,
} from "./quasar-project-emitter.js";

// ─── Quasar Emitter ──────────────────────────────────────────────────────────

class QuasarEmitter extends BaseEmitter {
  override readonly frameworkName = "Quasar";

  // ── Override emit() to generate proper quasar-lang multi-file output ──

  override emit(ir: SolanaIR): EmitterOutput {
    this.currentIr = ir;
    this.warnings = [];
    this.transformedCount = 0;
    this.passedThroughCount = 0;
    this.details = [];

    // Multi-file: delegate to the project emitter
    const bridge = this.createBridge();
    const files = emitQuasarProjectFiles(ir, bridge);

    // Single-file: use base emitter's manual entrypoint approach
    const singleFile = this.emitSingleFile(ir);

    return {
      files,
      singleFile,
      warnings: this.warnings,
      transformReport: {
        transformedCount: this.transformedCount,
        passedThroughCount: this.passedThroughCount,
        details: this.details,
      },
    };
  }

  // ── Bridge: expose quasar-specific helpers to the project emitter ────────

  private createBridge(): QuasarEmitterBridge {
    // The bridge proxies counter mutations back to the emitter instance
    // so transform tracking stays accurate across the split.
    const self = this;
    return {
      quasarArgType: (t) => self.quasarArgType(t),
      quasarStateFieldType: (t) => self.quasarStateFieldType(t),
      filteredSourceImports: (ir) => self.filteredSourceImports(ir),
      emitCustomTypes: (ir) => self.emitCustomTypes(ir),
      sourceErrorEnumName: (ir) => self.sourceErrorEnumName(ir),
      instrUsesBumps: (instr) => self.instrUsesBumps(instr),
      normalizeQuasarSeed: (s) => self.normalizeQuasarSeed(s),
      transformQuasarPassThrough: (code, instr, ir) =>
        self.transformQuasarPassThrough(code, instr, ir),
      transformQuasarExpr: (expr, instr, ir) =>
        self.transformQuasarExpr(expr, instr, ir),
      prefixAccountRefs: (code, instr) =>
        self.prefixAccountRefs(code, instr),
      emitQuasarSignerSeeds: (name, instr, ir) =>
        self.emitQuasarSignerSeeds(name, instr, ir),
      get transformedCount() { return self.transformedCount; },
      set transformedCount(v) { self.transformedCount = v; },
      get passedThroughCount() { return self.passedThroughCount; },
      set passedThroughCount(v) { self.passedThroughCount = v; },
      get warnings() { return self.warnings; },
      set warnings(v) { self.warnings = v; },
    };
  }

  // ── Quasar-specific helpers ────────────────────────────────────────────────

  /** Check if an instruction uses ctx.bumps */
  private instrUsesBumps(instr: Instruction): boolean {
    return instr.body.some(
      (s) =>
        s.kind === "bumps_access" ||
        s.kind === "pda_signer_seeds" ||
        (s.kind === "state_field_assign" &&
          s.value.includes("ctx.bumps")) ||
        (s.kind === "pass_through" && s.code.includes("ctx.bumps")) ||
        (s.kind === "cpi_spl_transfer" && s.signerSeeds != null) ||
        (s.kind === "cpi_spl_mint_to" && s.signerSeeds != null) ||
        (s.kind === "cpi_spl_burn" && s.signerSeeds != null) ||
        (s.kind === "cpi_spl_close_account" && s.signerSeeds != null) ||
        (s.kind === "cpi_system_transfer" && s.signerSeeds != null),
    );
  }

  /** Normalize a PDA seed expression for quasar #[account(seeds = [...])] */
  private normalizeQuasarSeed(seed: string): string {
    let s = seed.trim();
    s = s.replace(/ctx\.accounts\./g, "");
    s = s.replace(/(\w+)\.key\(\)\.as_ref\(\)/g, "$1");
    s = s.replace(/(\w+)\.key\.as_ref\(\)/g, "$1");
    return s;
  }

  /** Map IR type to quasar-lang type for instruction arguments */
  private quasarArgType(typeName: string): string {
    if (typeName === "Pubkey") return "Address";
    return typeName;
  }

  /** Map IR type to quasar-lang type for state struct fields */
  private quasarStateFieldType(typeName: string): string {
    if (typeName === "Pubkey") return "Address";
    return typeName;
  }

  /** Transform a pass-through code block for quasar multi-file */
  private transformQuasarPassThrough(
    code: string,
    _instr: Instruction,
    _ir: SolanaIR,
  ): string {
    let transformed = code;

    transformed = transformed.replace(
      /ctx\.accounts\.(\w+)/g,
      (_: string, name: string) => `accounts.${snakeCase(name)}`,
    );
    transformed = transformed.replace(
      /ctx\.bumps\.(\w+)/g,
      (_: string, name: string) => `bumps.${snakeCase(name)}`,
    );
    transformed = transformed.replace(
      /accounts\.(\w+)\.key\(\)/g,
      "accounts.$1.address()",
    );

    const requireMatch = transformed.match(
      /^require!\(([\s\S]+),\s*([\w:]+(?:::\w+)*)\s*\);?$/,
    );
    if (requireMatch?.[1] && requireMatch[2]) {
      return `require!(${requireMatch[1].trim()}, ${requireMatch[2]});`;
    }

    transformed = transformed.replace(
      /msg!\(([^)]+)\)/g,
      "log($1)",
    );
    transformed = transformed.replace(/\.to_account_info\(\)/g, "");
    transformed = transformed.replace(
      /error!\s*\(\s*([^)]+)\s*\)/g,
      "ProgramError::from($1)",
    );

    return transformed;
  }

  /** Transform an expression for quasar multi-file */
  private transformQuasarExpr(
    expr: string,
    instr: Instruction,
    _ir: SolanaIR,
  ): string {
    let transformed = expr;

    transformed = transformed.replace(
      /ctx\.accounts\.(\w+)/g,
      (_: string, name: string) => `accounts.${snakeCase(name)}`,
    );
    transformed = transformed.replace(
      /ctx\.bumps\.(\w+)/g,
      (_: string, name: string) => `bumps.${snakeCase(name)}`,
    );
    transformed = transformed.replace(
      /(\w+)\.key\(\)/g,
      (_: string, name: string) => {
        const isAccount = instr.accounts.some(
          (a) => snakeCase(a.name) === snakeCase(name),
        );
        if (isAccount) return `*accounts.${snakeCase(name)}.address()`;
        return `${name}.key()`;
      },
    );
    transformed = transformed.replace(
      /(\w+)\.amount\b/g,
      (_: string, name: string) => {
        const acc = instr.accounts.find(
          (a) => snakeCase(a.name) === snakeCase(name),
        );
        if (
          acc &&
          (acc.accountType === "TokenAccount" ||
            acc.constraints.some(
              (c) =>
                c.kind.startsWith("token::") ||
                c.kind.startsWith("associated_token::"),
            ))
        ) {
          return `accounts.${snakeCase(name)}.amount()`;
        }
        return `${name}.amount`;
      },
    );

    return transformed;
  }

  /** Prefix account name references with accounts. for quasar handler */
  private prefixAccountRefs(code: string, instr: Instruction): string {
    let transformed = code;
    for (const acc of instr.accounts) {
      const name = snakeCase(acc.name);
      transformed = transformed.replace(
        new RegExp(`(?<!accounts\\.)\\b${name}\\b(?!\\s*:)`, "g"),
        `accounts.${name}`,
      );
    }
    return transformed;
  }

  /** Emit quasar-style PDA signer seeds using Seed::from */
  private emitQuasarSignerSeeds(
    accountName: string,
    instr: Instruction,
    ir: SolanaIR,
  ): string {
    const normalized = snakeCase(accountName);
    const accRef = instr.accounts.find(
      (a) => snakeCase(a.name) === normalized,
    );

    if (!accRef?.isPda || accRef.pdaSeeds.length === 0) {
      return `    // Anvil: could not determine PDA seeds for '${normalized}'`;
    }

    const stateAcc = ir.accounts.find((a) => a.name === accRef.accountType);
    const hasBumpField = stateAcc?.fields.some((f) => f.name === "bump");

    const lines: string[] = [];

    for (const seed of accRef.pdaSeeds) {
      const keyMatch = seed.match(
        /(?:ctx\.accounts\.)?(\w+)\.key(?:\(\))?\.as_ref\(\)/,
      );
      if (keyMatch?.[1]) {
        const name = snakeCase(keyMatch[1]);
        lines.push(
          `    let ${name}_key = *accounts.${name}.address();`,
        );
      }
    }

    if (hasBumpField) {
      lines.push(
        `    let bump = [accounts.${normalized}.bump];`,
      );
    } else {
      lines.push(`    let bump = [bumps.${normalized}];`);
    }

    const seedExprs: string[] = [];
    for (const seed of accRef.pdaSeeds) {
      if (seed.startsWith('b"') || seed.startsWith("b'")) {
        seedExprs.push(`Seed::from(${seed} as &[u8])`);
      } else {
        const keyMatch = seed.match(
          /(?:ctx\.accounts\.)?(\w+)\.key(?:\(\))?\.as_ref\(\)/,
        );
        if (keyMatch?.[1]) {
          seedExprs.push(
            `Seed::from(${snakeCase(keyMatch[1])}_key.as_ref())`,
          );
        } else {
          let normalized_seed = seed
            .replace(/ctx\.accounts\./g, "accounts.")
            .replace(/\.as_ref\(\)/g, "");
          seedExprs.push(`Seed::from(${normalized_seed}.as_ref())`);
        }
      }
    }
    seedExprs.push(`Seed::from(&bump as &[u8])`);

    lines.push(`    let seeds: &[Seed] = &[`);
    for (const expr of seedExprs) {
      lines.push(`        ${expr},`);
    }
    lines.push(`    ];`);

    return lines.join("\n");
  }

  // ── Single-file output methods (pinocchio-compatible fallback) ───────────

  override emitUseStatements(_ir: SolanaIR): string {
    const imports = [
      `use core::convert::TryInto;`,
      `use borsh::{BorshDeserialize, BorshSerialize};`,
      `use pinocchio::{
    account_info::AccountInfo,
    entrypoint,
    program_error::ProgramError,
    pubkey::Pubkey,
    ProgramResult,
};`,
    ];

    if (irNeedsHelper(_ir, "transfer_lamports")) {
      imports.push(
        `use pinocchio_system::instructions::Transfer as SystemTransfer;`,
      );
    }

    const needsSeedSigner =
      irNeedsInitAccountHelper(_ir) ||
      irNeedsSignedLamportsHelper(_ir) ||
      irNeedsSignedSplMintToHelper(_ir) ||
      irNeedsSignedSplBurnHelper(_ir) ||
      irNeedsSignedSplCloseAccountHelper(_ir) ||
      irNeedsHelper(_ir, "spl_transfer");
    if (needsSeedSigner) {
      imports.push(`use pinocchio::instruction::{Seed, Signer};`);
    }
    if (irNeedsInitAccountHelper(_ir)) {
      imports.push(
        `use pinocchio_system::create_account_with_minimum_balance_signed;`,
      );
    }

    if (
      irNeedsHelper(_ir, "spl_transfer") ||
      irNeedsHelper(_ir, "spl_mint_to") ||
      irNeedsHelper(_ir, "spl_burn")
    ) {
      imports.push(
        `use pinocchio_token::instructions::Transfer as TokenTransfer;`,
      );
    }
    if (irNeedsHelper(_ir, "spl_mint_to")) {
      imports.push(
        `use pinocchio_token::instructions::MintTo as TokenMintTo;`,
      );
    }
    if (irNeedsHelper(_ir, "spl_burn")) {
      imports.push(
        `use pinocchio_token::instructions::Burn as TokenBurn;`,
      );
    }
    if (irNeedsHelper(_ir, "spl_close_account")) {
      imports.push(
        `use pinocchio_token::instructions::CloseAccount as TokenCloseAccount;`,
      );
    }
    if (irNeedsToken2022Helper(_ir)) {
      imports.push(
        `// Token-2022: same instruction structs, routed to token_2022 program at runtime`,
      );
      imports.push(
        `use pinocchio_token::instructions::TransferChecked as Token2022TransferChecked;`,
      );
    }
    if (irNeedsAtaCreationHelper(_ir)) {
      imports.push(
        `use pinocchio_associated_token_account::instructions::Create as CreateAssociatedToken;`,
      );
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
          `        ${instrDiscriminator(instr.name)} => ${snakeCase(instr.name)}(program_id, accounts, data),`,
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

  override emitAccountKeyExpr(accountName: string): string {
    return `*${accountName}.key()`;
  }

  override emitAccountKeyAsRefExpr(accountName: string): string {
    return `${accountName}.key().as_ref()`;
  }

  override emitAccountLamportsExpr(accountName: string): string {
    return `${accountName}.lamports()`;
  }

  override emitStateRead(
    accountName: string,
    typeName: string,
    localVar: string,
    mutable: boolean,
  ): string {
    const mutKeyword = mutable ? "mut " : "";
    return `    let ${mutKeyword}${localVar} = ${typeName}::from_account_info(${accountName})?;`;
  }

  override emitStateSave(
    accountName: string,
    typeName: string,
    localVar: string,
  ): string {
    return `    ${typeName}::save(${accountName}, &${localVar})?;`;
  }

  override emitBumpSeed(
    _programId: string,
    seeds: string[],
    expectedKey: string,
  ): string {
    const prelude: string[] = [];
    let tempCount = 0;
    const transformedSeeds = seeds.map((seed) => {
      const bytesMatch = seed.match(/^&(.*)\.to_le_bytes\(\)$/);
      if (bytesMatch?.[1]) {
        const varName =
          tempCount === 0 ? "seed_bytes" : `seed_bytes_${tempCount + 1}`;
        tempCount++;
        prelude.push(
          `    let ${varName} = ${bytesMatch[1].trim()}.to_le_bytes();`,
        );
        return `&${varName}`;
      }
      const match = seed.match(/^(.*)\.to_le_bytes\(\)\.as_ref\(\)$/);
      if (!match?.[1]) return seed;
      const varName =
        tempCount === 0 ? "seed_bytes" : `seed_bytes_${tempCount + 1}`;
      tempCount++;
      prelude.push(
        `    let ${varName} = ${match[1].trim()}.to_le_bytes();`,
      );
      return `${varName}.as_ref()`;
    });
    const seedsStr = transformedSeeds.map((s) => `${s}`).join(", ");
    const bumpLine = `    let bump = bump_seed(program_id, &[${seedsStr}], ${expectedKey}.key())?;`;
    return prelude.length > 0
      ? `${prelude.join("\n")}\n${bumpLine}`
      : bumpLine;
  }

  override emitSystemTransfer(
    from: string,
    to: string,
    amount: string,
    signerSeeds?: string,
  ): string {
    if (signerSeeds) {
      return `    // System transfer with PDA signer
    transfer_lamports_signed(${from}, ${to}, ${amount}, ${signerSeeds})?;`;
    }
    return `    transfer_lamports(${from}, ${to}, ${amount})?;`;
  }

  override emitSplTransfer(
    from: string,
    to: string,
    authority: string,
    amount: string,
    signerSeeds?: string,
    _opts?: Token2022Opts,
  ): string {
    if (signerSeeds) {
      return `    // SPL Token transfer (PDA signed)
    spl_token_transfer_signed(${from}, ${to}, ${authority}, ${amount}, ${signerSeeds})?;`;
    }
    return `    // SPL Token transfer
    spl_token_transfer(${from}, ${to}, ${authority}, ${amount})?;`;
  }

  override emitSplMintTo(
    mint: string,
    to: string,
    authority: string,
    amount: string,
    signerSeeds?: string,
    _opts?: Token2022Opts,
  ): string {
    const signed = signerSeeds ? "_signed" : "";
    return `    // SPL Token mint_to
    spl_token_mint_to${signed}(${mint}, ${to}, ${authority}, ${amount}${signerSeeds ? `, ${signerSeeds}` : ""})?;`;
  }

  override emitSplBurn(
    from: string,
    mint: string,
    authority: string,
    amount: string,
    signerSeeds?: string,
    _opts?: Token2022Opts,
  ): string {
    const signed = signerSeeds ? "_signed" : "";
    return `    // SPL Token burn
    spl_token_burn${signed}(${from}, ${mint}, ${authority}, ${amount}${signerSeeds ? `, ${signerSeeds}` : ""})?;`;
  }

  override emitSplCloseAccount(
    account: string,
    destination: string,
    authority: string,
    signerSeeds?: string,
    _opts?: Token2022Opts,
  ): string {
    const signed = signerSeeds ? "_signed" : "";
    return `    // SPL Token close account
    spl_token_close_account${signed}(${account}, ${destination}, ${authority}${signerSeeds ? `, ${signerSeeds}` : ""})?;`;
  }

  override emitSplSetAuthority(
    account: string,
    currentAuthority: string,
    authorityType: string,
    newAuthority: string,
    signerSeeds?: string,
    _opts?: Token2022Opts,
  ): string {
    // Hand-rolled SPL Token set_authority CPI against the SPL Token program
    // ID — quasar-spl 0.0 doesn't surface a typed helper. Discriminator 6
    // (SetAuthority) + AuthorityType byte + COption<Pubkey> for new authority.
    //
    // AuthorityType encoding:
    //   MintTokens=0, FreezeAccount=1, AccountOwner=2, CloseAccount=3
    // Unrecognized variants default to AccountOwner with an inline TODO marker
    // so the user sees the assumption, not a silent breakage.
    const authorityByte = (() => {
      switch (authorityType.replace(/^.*::/, "")) {
        case "MintTokens": return "0u8";
        case "FreezeAccount": return "1u8";
        case "AccountOwner": return "2u8";
        case "CloseAccount": return "3u8";
        default:
          return `2u8 /* ⚠️ Anvil: unrecognized AuthorityType '${authorityType}', defaulted to AccountOwner */`;
      }
    })();
    const newAuthMatch = newAuthority.match(/^Some\(([\s\S]+)\)\s*$/);
    const newAuthExpr = newAuthMatch?.[1]?.trim() ?? null;
    const invokeFn = signerSeeds ? "invoke_signed" : "invoke";
    const seedArgs = signerSeeds ? `, ${signerSeeds}` : "";
    return `    // SPL Token set_authority CPI (hand-rolled — quasar-spl has no helper)
    {
        const SPL_TOKEN_PROGRAM_ID: quasar_lang::Pubkey = quasar_lang::Pubkey::new_from_array([
            6, 221, 246, 225, 215, 101, 161, 147, 217, 203, 225, 70, 206, 235, 121, 172,
            28, 180, 133, 237, 95, 91, 55, 145, 58, 140, 245, 133, 126, 255, 0, 169,
        ]);
        let mut __sa_data: [u8; 35] = [0; 35];
        let mut __sa_len: usize = 3;
        __sa_data[0] = 6u8; // SetAuthority discriminator
        __sa_data[1] = ${authorityByte};
        ${newAuthExpr
          ? `__sa_data[2] = 1u8; // COption::Some\n        __sa_data[3..35].copy_from_slice((${newAuthExpr}).as_ref());\n        __sa_len = 35;`
          : `__sa_data[2] = 0u8; // COption::None`}
        let __sa_ix = quasar_lang::Instruction {
            program_id: SPL_TOKEN_PROGRAM_ID,
            accounts: vec![
                quasar_lang::AccountMeta::new(*${account}.key, false),
                quasar_lang::AccountMeta::new_readonly(*${currentAuthority}.key, true),
            ],
            data: __sa_data[..__sa_len].to_vec(),
        };
        quasar_lang::program::${invokeFn}(&__sa_ix, &[${account}.clone(), ${currentAuthority}.clone()]${seedArgs})?;
    }`;
  }

  override emitProgramAccountClose(
    account: string,
    destination: string,
  ): string {
    return `    close_program_account(${account}, ${destination})?;`;
  }

  override emitCreateProgramAccount(
    account: string,
    payer: string,
    spaceExpr: string,
    signerSeeds?: string,
  ): string {
    return `    create_program_account(${account}, ${payer}, (${spaceExpr}) as u64, program_id, ${signerSeeds ?? "&[]"})?;`;
  }

  override emitCreateAta(
    ata: string,
    payer: string,
    mint: string,
    authority: string,
    _signerSeeds?: string,
  ): string {
    // Hand-rolled SPL Associated Token Account create CPI against the
    // ATA program ID. quasar-spl 0.0 doesn't expose a typed builder, but
    // ATA's wire format is stable: empty instruction data + 7 accounts in
    // order (payer, ata, owner, mint, system_program, token_program, rent).
    return `    // SPL Associated Token Account create CPI (hand-rolled — quasar-spl has no builder)
    {
        const ATA_PROGRAM_ID: quasar_lang::Pubkey = quasar_lang::Pubkey::new_from_array([
            140, 151, 37, 143, 78, 36, 137, 241, 187, 61, 16, 41, 20, 142, 13, 131,
            11, 90, 19, 153, 218, 255, 16, 132, 4, 142, 123, 216, 219, 233, 248, 89,
        ]);
        const SYSTEM_PROGRAM_ID: quasar_lang::Pubkey = quasar_lang::Pubkey::default();
        const SPL_TOKEN_PROGRAM_ID: quasar_lang::Pubkey = quasar_lang::Pubkey::new_from_array([
            6, 221, 246, 225, 215, 101, 161, 147, 217, 203, 225, 70, 206, 235, 121, 172,
            28, 180, 133, 237, 95, 91, 55, 145, 58, 140, 245, 133, 126, 255, 0, 169,
        ]);
        let __ata_ix = quasar_lang::Instruction {
            program_id: ATA_PROGRAM_ID,
            accounts: vec![
                quasar_lang::AccountMeta::new(*${payer}.key, true),
                quasar_lang::AccountMeta::new(*${ata}.key, false),
                quasar_lang::AccountMeta::new_readonly(*${authority}.key, false),
                quasar_lang::AccountMeta::new_readonly(*${mint}.key, false),
                quasar_lang::AccountMeta::new_readonly(SYSTEM_PROGRAM_ID, false),
                quasar_lang::AccountMeta::new_readonly(SPL_TOKEN_PROGRAM_ID, false),
            ],
            data: vec![0u8], // create_associated_token_account discriminator
        };
        quasar_lang::program::invoke(&__ata_ix, &[
            ${payer}.clone(), ${ata}.clone(), ${authority}.clone(), ${mint}.clone(),
        ])?;
    }`;
  }

  override emitCreateTokenAccount(
    account: string, _payer: string, _mint: string, _authority: string, _signerSeeds?: string,
  ): string {
    // Quasar has no end-to-end cargo-build coverage today; emit a TODO
    // marker rather than a half-baked CPI. See docs/feature-matrix.md
    // "Quasar status" — fixture tests only validate emitter cleanliness,
    // not on-chain semantics, so a stub is the honest signal.
    return `    // Anvil TODO: init token::* account ${account} — quasar-spl needs a typed
    // builder for SPL Token InitializeAccount3 before this can land. Hand-roll
    // against the SPL Token program ID once quasar_lang::Instruction surface
    // is stable.`;
  }

  override emitMemo(data: string, _signerSeeds?: string): string {
    // Hand-rolled SPL Memo CPI against the Memo program ID. The program
    // takes raw UTF-8 bytes as instruction data and zero accounts (signers
    // are passed as account metas if present, but for the unsigned form
    // the empty accounts vec is correct).
    return `    // SPL Memo CPI (hand-rolled — quasar-spl has no memo helper)
    {
        const MEMO_PROGRAM_ID: quasar_lang::Pubkey = quasar_lang::Pubkey::new_from_array([
            5, 74, 83, 90, 153, 41, 33, 6, 77, 36, 232, 113, 96, 218, 56, 124,
            124, 53, 181, 221, 188, 146, 187, 129, 228, 31, 168, 64, 65, 5, 68, 141,
        ]);
        let __memo_data: Vec<u8> = (${data}).into();
        let __memo_ix = quasar_lang::Instruction {
            program_id: MEMO_PROGRAM_ID,
            accounts: vec![],
            data: __memo_data,
        };
        quasar_lang::program::invoke(&__memo_ix, &[])?;
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
    const shouldReadState =
      !!typeName &&
      !!this.currentIr?.accounts.find((acc) => acc.name === typeName);
    const resolvedTypeName =
      typeName ||
      account.charAt(0).toUpperCase() +
        account
          .slice(1)
          .replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());

    const prelude: string[] = [];
    let tempCount = 0;
    const transformedSeeds = seeds.map((seed) => {
      if (seed.startsWith('b"') || seed.startsWith("b'")) return seed;
      const bytesMatch = seed.match(/^&(.+)\.to_le_bytes\(\)$/);
      if (bytesMatch?.[1]) {
        const varName =
          tempCount === 0 ? "seed_bytes" : `seed_bytes_${tempCount + 1}`;
        tempCount++;
        prelude.push(
          `    let ${varName} = ${bytesMatch[1].trim()}.to_le_bytes();`,
        );
        return `&${varName}`;
      }
      const asRefMatch = seed.match(/^(.*)\.to_le_bytes\(\)\.as_ref\(\)$/);
      if (asRefMatch?.[1]) {
        const varName =
          tempCount === 0 ? "seed_bytes" : `seed_bytes_${tempCount + 1}`;
        tempCount++;
        prelude.push(
          `    let ${varName} = ${asRefMatch[1].trim()}.to_le_bytes();`,
        );
        return `${varName}.as_ref()`;
      }
      const keyAsRefMatch = seed.match(/^(\w+)\.key\(\)\.as_ref\(\)$/);
      if (keyAsRefMatch?.[1]) {
        const name = keyAsRefMatch[1];
        if (name.endsWith("_account"))
          return `${name}.key().as_ref()`;
        if (name === account) return `${accountInfoVar}.key().as_ref()`;
        if (stateVar && name === stateVar)
          return `${accountInfoVar}.key().as_ref()`;
        return `${name}_account.key().as_ref()`;
      }
      const keyFieldAsRefMatch = seed.match(/^(\w+)\.key\.as_ref\(\)$/);
      if (keyFieldAsRefMatch?.[1]) {
        const name = keyFieldAsRefMatch[1];
        if (name.endsWith("_account"))
          return `${name}.key().as_ref()`;
        if (name === account) return `${accountInfoVar}.key().as_ref()`;
        if (stateVar && name === stateVar)
          return `${accountInfoVar}.key().as_ref()`;
        return `${name}_account.key().as_ref()`;
      }
      if (rewritePrefix && seed.startsWith("&[")) {
        return seed.replace(
          new RegExp(`&\\[${rewritePrefix}\\.`),
          `&[${dataVar}.`,
        );
      }
      if (rewritePrefix) {
        return seed.replace(
          new RegExp(`^${rewritePrefix}\\.`),
          `${dataVar}.`,
        );
      }
      return seed;
    });

    const seedsStr = transformedSeeds.join(",\n            ");
    const maybeRead =
      stateVar || !shouldReadState
        ? ""
        : `    let ${dataVar} = ${resolvedTypeName}::from_account_info(${accountInfoVar})?;\n`;
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
    // See pinocchio-emitter.ts:emitMsg for the three shapes we handle. Same
    // rule: only trust a full-literal prefix match; never use indexOf(",")
    // because commas inside string literals would truncate the log.
    const literalMatch = message.match(/^"([^"\\]|\\.)*"/);
    if (literalMatch?.[0]) {
      const literal = literalMatch[0];
      if (literal === message.trim()) {
        return `    pinocchio::msg!(${literal});`;
      }
      return `    // Anvil: formatted msg!() collapsed to static log\n    pinocchio::msg!(${literal});`;
    }
    return `    pinocchio::msg!(${message});`;
  }

  override emitEmit(event: string, fields: string): string {
    if (!fields.trim()) {
      return `    pinocchio::msg!("event:${event}");`;
    }
    return `    // Event: ${event}
    pinocchio::msg!("event:${event}");
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
    if (typeName === "String") return "[u8; 64]";
    return typeName;
  }

  protected override emitPubkeyDeserialize(
    start: number,
    end: number,
  ): string {
    return `data[${start}..${end}].try_into().map_err(|_| ProgramError::InvalidInstructionData)?`;
  }

  protected override emitPubkeyDeserializeSlice(sliceExpr: string): string {
    return `${sliceExpr}.try_into().map_err(|_| ProgramError::InvalidInstructionData)?`;
  }

  protected override emitPubkeyFieldRead(_size: number): string {
    return `data[offset..offset + 32].try_into().map_err(|_| ProgramError::InvalidAccountData)?`;
  }

  override emitAccountStruct(acc: AccountDef): string {
    const fields = acc.fields
      .map(
        (f) =>
          `    pub ${snakeCase(f.name)}: ${this.rustTypeForFramework(f.type)},`,
      )
      .join("\n");
    const bodyLen = acc.fields.reduce(
      (s, f) => s + this.resolveTypeSize(f.type),
      0,
    );
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

    pub fn write(data: &mut [u8], value: &Self) -> Result<(), ProgramError> {
        if data.len() < Self::TOTAL_LEN {
            return Err(ProgramError::InvalidAccountData);
        }
        data[..8].copy_from_slice(&Self::DISCRIMINATOR);
        let mut offset = 8usize;
${writeLines}
        Ok(())
    }

    pub fn from_account_info(account: &AccountInfo) -> Result<Self, ProgramError> {
        let data = account.borrow_data_unchecked();
        Self::read(data)
    }

    pub fn save(account: &AccountInfo, value: &Self) -> Result<(), ProgramError> {
        let mut data = account.borrow_mut_data_unchecked();
        Self::write(&mut data, value)
    }
}`;
  }

  override emitErrorEnum(ir: SolanaIR): string {
    const seen = new Set<string>();
    const dedupedErrors = ir.errors.filter((e) => {
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
    let (derived, bump) = Pubkey::find_program_address(seeds, program_id);
    if &derived != expected {
        return Err(ProgramError::InvalidSeeds);
    }
    Ok(bump)
}`);

    if (irNeedsInitAccountHelper(ir)) {
      helpers.push(`pub fn create_program_account<'a>(
    account: &'a AccountInfo,
    payer: &'a AccountInfo,
    space: u64,
    program_id: &Pubkey,
    signer_seeds: &[&[&[u8]]],
) -> ProgramResult {
    let signer = signer_seeds
        .iter()
        .map(|seeds| seeds.iter().map(|s| Seed::from(*s)).collect::<Vec<_>>())
        .collect::<Vec<_>>();
    let signers: Vec<Signer> = signer.iter().map(|s| Signer::from(s.as_slice())).collect();
    create_account_with_minimum_balance_signed(payer, account, space, program_id, &signers)
}`);
    }

    if (irNeedsUnsignedLamportsHelper(ir)) {
      helpers.push(`pub fn transfer_lamports(
    from: &AccountInfo,
    to: &AccountInfo,
    amount: u64,
) -> ProgramResult {
    if from.key() == to.key() {
        return Err(ProgramError::InvalidAccountData);
    }
    unsafe {
        *from.borrow_mut_lamports_unchecked() = from
            .lamports()
            .checked_sub(amount)
            .ok_or(ProgramError::InsufficientFunds)?;
        *to.borrow_mut_lamports_unchecked() = to
            .lamports()
            .checked_add(amount)
            .ok_or(ProgramError::ArithmeticOverflow)?;
    }
    Ok(())
}`);
    }

    if (irNeedsSignedLamportsHelper(ir)) {
      helpers.push(`pub fn transfer_lamports_signed(
    from: &AccountInfo,
    to: &AccountInfo,
    amount: u64,
    _signer_seeds: &[&[&[u8]]],
) -> ProgramResult {
    if from.key() == to.key() {
        return Err(ProgramError::InvalidAccountData);
    }
    unsafe {
        *from.borrow_mut_lamports_unchecked() = from
            .lamports()
            .checked_sub(amount)
            .ok_or(ProgramError::InsufficientFunds)?;
        *to.borrow_mut_lamports_unchecked() = to
            .lamports()
            .checked_add(amount)
            .ok_or(ProgramError::ArithmeticOverflow)?;
    }
    Ok(())
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
      helpers.push(`pub fn spl_token_mint_to(
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
      helpers.push(`pub fn spl_token_mint_to_signed(
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
      helpers.push(`pub fn spl_token_burn(
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
      helpers.push(`pub fn spl_token_burn_signed(
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
    TokenCloseAccount {
        account,
        destination,
        authority,
    }
    .invoke_signed(signer_seeds)
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
    unsafe {
        *destination.borrow_mut_lamports_unchecked() = destination
            .lamports()
            .checked_add(lamports)
            .ok_or(ProgramError::ArithmeticOverflow)?;
        *account.borrow_mut_lamports_unchecked() = 0;
    }
    account.borrow_mut_data_unchecked().fill(0);
    Ok(())
}`);
    }

    if (irNeedsTokenAmountHelper(ir)) {
      helpers.push(`/// Read the amount field from an SPL Token Account (offset 64, 8 bytes LE u64)
pub fn token_account_amount(account: &AccountInfo) -> Result<u64, ProgramError> {
    let data = account.borrow_data_unchecked();
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

const emitter = new QuasarEmitter();

export function emitQuasar(ir: SolanaIR): string {
  return emitter.emit(ir).singleFile;
}

export function emitQuasarFull(ir: SolanaIR) {
  return emitter.emit(ir);
}

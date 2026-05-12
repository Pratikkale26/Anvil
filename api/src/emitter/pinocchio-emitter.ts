/**
 * Pinocchio Emitter — Generic target emitter for the Pinocchio framework.
 *
 * Extends BaseEmitter with Pinocchio-specific implementations.
 * All hardcoded counter/vault logic has been removed.
 * Business logic is now driven entirely by IR body statements.
 */

import type { SolanaIR, AccountDef, Instruction } from "../ir/schema.js";
import type { Token2022Opts } from "./body-emitter/index.js";
import { BaseEmitter, stubAnchorOnlyImplItem, rewriteTryIntoUnwrap, rewriteAnchorResultAlias, rewriteGetInstancePackedLen } from "./emitter-base.js";
import { promoteImplFnVisibility } from "./emitter-base-utils.js";
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
  irNeedsTokenAccountInitHelper,
  irNeedsMplCreateMetadataV3Helper,
} from "./emitter-helpers.js";

/**
 * Token-2022 checked variants need the mint's `.decimals`. Anchor source
 * accesses it via `ctx.accounts.<mint>.decimals` (Anchor parses the mint
 * into a typed view). In Pinocchio we have a bare `&AccountInfo` and
 * `pinocchio_token::state::Mint::from_account_info` enforces an owner
 * check against the SPL Token program ID — Token-2022 mints fail that
 * check. Read decimals raw from offset 44 in the SPL Mint layout
 * (mint_authority_flag=4 + mint_authority=32 + supply=8 = 44).
 */
function resolveT22DecimalsPinocchio(
  mint: string,
  decimals: string | undefined,
): { decimalsExpr: string; prelude: string } {
  // Fallback must be syntactically valid Rust — `/* TODO */` alone collapses to
  // nothing after lexing and leaves a stray comma in the data array.
  const fallback = decimals ?? "0u8 /* TODO: decimals — could not infer from source; verify against the mint */";
  if (!decimals) return { decimalsExpr: fallback, prelude: "" };
  const accessRe = new RegExp(`^${mint}\\.decimals$`);
  if (!accessRe.test(decimals.trim())) return { decimalsExpr: fallback, prelude: "" };
  const localVar = `${mint}_decimals`;
  // Pinocchio's borrow_data_unchecked is unsafe; SPL Mint layout puts
  // `decimals` at byte offset 44.
  const prelude = `    let ${localVar} = {
        let __mint_data = unsafe { ${mint}.borrow_data_unchecked() };
        if __mint_data.len() < 45 {
            return Err(ProgramError::InvalidAccountData);
        }
        __mint_data[44]
    };
`;
  return { decimalsExpr: localVar, prelude };
}

/**
 * Token-2022 program ID literal as a `pinocchio::pubkey::Pubkey` ([u8; 32]).
 * Decoded from base58 "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb".
 */
const TOKEN_2022_PROGRAM_ID_CONST = `        const TOKEN_2022_PROGRAM_ID: pinocchio::pubkey::Pubkey = [6, 221, 246, 225, 238, 117, 143, 222, 24, 66, 93, 188, 228, 108, 205, 218, 182, 26, 252, 77, 131, 185, 13, 39, 254, 189, 249, 40, 216, 161, 139, 252];`;

/**
 * Build the Token-2022 invoke line. The IR-level `signerSeeds` string is a
 * variable name in scope holding `[&[&[u8]]; N]` (set up by the seeds
 * prelude). `pinocchio::cpi::invoke_signed` wants `&[Signer]`, so when seeds
 * are present we synthesize a `Signer` from the first seed group and pass
 * `&[__t22_signer]`. When no seeds, fall through to plain invoke.
 *
 * The accounts slice arity matters for const-generic inference on
 * `pinocchio::cpi::invoke{,_signed}` — we pass `&[acc1, acc2, …]` directly
 * so the compiler infers `ACCOUNTS = N`.
 */
function emitT22Invoke(accountsList: string, signerSeeds: string | undefined): string {
  if (!signerSeeds) {
    return `        pinocchio::cpi::invoke(&__t22_ix, &[${accountsList}])?;`;
  }
  // Bind signerSeeds to a named local first — when the call site passes a
  // literal like `&[&seeds[..]]`, calling `.first()` on the temporary
  // expression directly creates a temp that's dropped before the borrow
  // returned by `.first()` finishes (E0716 temporary dropped while borrowed).
  // The named binding extends the temp's lifetime to the enclosing scope.
  return `        let __t22_signer_seeds = ${signerSeeds};
        let __t22_seed_group = __t22_signer_seeds.first().ok_or(ProgramError::InvalidSeeds)?;
        let mut __t22_seeds: [pinocchio::instruction::Seed<'_>; 8] =
            core::array::from_fn(|_| pinocchio::instruction::Seed::from(&[][..]));
        for (__i, __seed) in __t22_seed_group.iter().enumerate() {
            if __i >= __t22_seeds.len() { return Err(ProgramError::InvalidSeeds); }
            __t22_seeds[__i] = pinocchio::instruction::Seed::from(*__seed);
        }
        let __t22_signer = pinocchio::instruction::Signer::from(&__t22_seeds[..__t22_seed_group.len()]);
        pinocchio::cpi::invoke_signed(&__t22_ix, &[${accountsList}], &[__t22_signer])?;`;
}

// Maps a parsed `state:` expression for DefaultAccountState init/update to
// its repr(u8) byte value when the source uses one of the canonical
// `&AccountState::X` / `AccountState::X` literals. Returns null on any
// non-literal expression so the emit can fall back to TODO commentout
// rather than guess at a byte for an unknown variable.
function mapAccountStateLiteralToByte(expr: string): number | null {
  const stripped = expr.trim().replace(/^&\s*/, "").trim();
  if (stripped === "AccountState::Uninitialized") return 0;
  if (stripped === "AccountState::Initialized") return 1;
  if (stripped === "AccountState::Frozen") return 2;
  return null;
}

// Maps a parsed `field:` expression for token_metadata_update_field to its
// Borsh-encoded byte sequence. Returns:
//   - { kind: "fixed", bytes: [N] } for Name/Symbol/Uri (single variant byte)
//   - { kind: "key", literal: '"foo"' } for Field::Key("foo") (variant byte 3
//     + Borsh string)
//   - null for any non-literal expression (TODO commentout fallback)
type FieldLiteralEncoding =
  | { kind: "fixed"; byte: number }
  | { kind: "key"; literal: string };
function mapFieldLiteralToEncoding(expr: string): FieldLiteralEncoding | null {
  const stripped = expr.trim().replace(/^&\s*/, "").trim();
  if (stripped === "Field::Name") return { kind: "fixed", byte: 0 };
  if (stripped === "Field::Symbol") return { kind: "fixed", byte: 1 };
  if (stripped === "Field::Uri") return { kind: "fixed", byte: 2 };
  // Field::Key(<expr>) — capture the inner expression. Used as Rust source
  // verbatim so it must already be a String-typed expression.
  const keyMatch = stripped.match(/^Field::Key\(([\s\S]+)\)$/);
  if (keyMatch && keyMatch[1]) return { kind: "key", literal: keyMatch[1].trim() };
  return null;
}

// Maps a parsed `new_authority:` expression for token_metadata_update_authority
// to its 32-byte payload form. The OptionalNonZeroPubkey wire form is always
// 32 bytes; zero-filled means None, otherwise the pubkey bytes. Returns:
//   - { kind: "none" } for OptionalNonZeroPubkey::try_from(None)?
//   - { kind: "some", pubkeyExpr: "<expr>" } for try_from(Some(<expr>))? where
//     <expr> evaluates to a Pubkey (Native solana_program::pubkey::Pubkey)
//   - null for any non-literal expression (TODO commentout fallback)
type NewAuthorityEncoding =
  | { kind: "none" }
  | { kind: "some"; pubkeyExpr: string };
function mapNewAuthorityLiteralToEncoding(expr: string): NewAuthorityEncoding | null {
  const stripped = expr.trim();
  // OptionalNonZeroPubkey::try_from(None)? with optional ? operator.
  if (/^OptionalNonZeroPubkey::try_from\(\s*None\s*\)\??$/.test(stripped)) {
    return { kind: "none" };
  }
  const someMatch = stripped.match(
    /^OptionalNonZeroPubkey::try_from\(\s*Some\(([\s\S]+)\)\s*\)\??$/,
  );
  if (someMatch && someMatch[1]) return { kind: "some", pubkeyExpr: someMatch[1].trim() };
  return null;
}

// See native-emitter.ts for rationale; mirrored list of standard impl names.
const STANDARD_IMPL_NAMES = [
  "DISCRIMINATOR", "INIT_SPACE", "LEN", "TOTAL_LEN", "SPACE", "SIZE",
  "read", "write", "save", "from_account_info",
];
const STANDARD_IMPL_NAME_RE = new RegExp(
  `\\bpub\\s+(?:const|fn)\\s+(?:${STANDARD_IMPL_NAMES.join("|")})\\b`,
);

export class PinocchioEmitter extends BaseEmitter {
  override readonly frameworkName = "Pinocchio";

  /**
   * Same purpose as the native override — inject Mint decimals preludes for
   * bare `<account>.decimals` references that survive from Anchor source.
   * Pinocchio's `AccountInfo` has no `.decimals` field either; reading byte 44
   * of the SPL Mint layout via `borrow_data_unchecked` matches what
   * resolveT22DecimalsPinocchio already does for the `_checked` decimals slot.
   */
  protected override postProcessInstructionBody(
    bodyCode: string,
    instr: Instruction,
    ir: SolanaIR,
  ): string {
    bodyCode = super.postProcessInstructionBody(bodyCode, instr, ir);
    const accountNames = instr.accounts.map((a) => snakeCase(a.name));
    const mintsHit: string[] = [];
    for (const name of accountNames) {
      const re = new RegExp(`(?<![A-Za-z0-9_])${name}\\.decimals\\b`);
      if (re.test(bodyCode)) mintsHit.push(name);
    }

    let body = this.postProcessPinocchioRewrites(bodyCode);

    if (mintsHit.length === 0) return body;

    const preludes = mintsHit
      .map(
        (name) => `    let ${name}_decimals = {
        let __mint_data = unsafe { ${name}.borrow_data_unchecked() };
        if __mint_data.len() < 45 {
            return Err(ProgramError::InvalidAccountData);
        }
        __mint_data[44]
    };`,
      )
      .join("\n");

    for (const name of mintsHit) {
      body = body.replace(
        new RegExp(`(?<![A-Za-z0-9_])${name}\\.decimals\\b`, "g"),
        `${name}_decimals`,
      );
    }
    return `${preludes}\n${body}`;
  }

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
      // Token-2022 CPIs are hand-rolled inline against the spl_token_2022
      // program ID — pinocchio_token hardcodes the SPL Token ID so its
      // instruction structs can't be retargeted. No extra imports needed
      // beyond pinocchio::instruction + pinocchio::cpi (already pulled in
      // for ATA/memo paths and resolved by full path here).
    }
    if (irNeedsAtaCreationHelper(_ir)) {
      imports.push(`use pinocchio_associated_token_account::instructions::Create as CreateAssociatedToken;`);
    }
    // The hand-rolled InitializeAccount3 references CreateAccount +
    // Instruction via full paths, so no extra imports here. Sysvar (for
    // Rent::get()) lands via the unified needsClock/needsRent block below
    // — `irNeedsTokenAccountInitHelper` ORs into needsRent, which pulls
    // both `Rent` and `Sysvar` into scope without duplicating either.

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
        // `\bRent::get\(\)` for explicit forms; the `.minimum_balance|...`
        // patterns surface the post-rewrite Rent::get()?.method shape via
        // postProcessInstructionBody (rewriteRentSysvarMethods).
        (s.kind === 'pass_through' && /\bRent::get\(\)|\.(?:minimum_balance|exempt_minimum|burn_percent)\s*\(/.test(s.code))
      ) ||
      // Realloc prelude (emitReallocPrelude in emitter-base) calls
      // Rent::get() to compute the rent delta. Without this account-side
      // check the import is missed and cargo build fails with E0599
      // 'no function get found for Rent in this scope.'
      i.accounts.some(a => a.constraints?.some(c => c.kind === 'realloc'))
    ) || irNeedsTokenAccountInitHelper(_ir);
    if (needsClock) {
      imports.push(`use pinocchio::sysvars::clock::Clock;`);
    }
    if (needsRent) {
      imports.push(`use pinocchio::sysvars::rent::Rent;`);
    }
    if (needsClock || needsRent) {
      imports.push(`use pinocchio::sysvars::Sysvar;`);
    }

    // Auto-import set_return_data / get_return_data when any instruction
    // references either. Source code typically uses
    // `anchor_lang::solana_program::program::set_return_data` (filtered
    // out by the use-import scrubber on Pinocchio); the postProcess
    // rewrite collapses qualified call sites to `pinocchio::program::*`,
    // but BARE call sites (where the source had `use … set_return_data;`
    // and called the bare name) need this import to compile. Cheap +
    // idempotent: detect by scanning instruction bodies for the names.
    const usesSetReturnData = _ir.instructions.some((i) =>
      i.body.some((s) =>
        (s.kind === "pass_through" && /\bset_return_data\s*\(/.test(s.code))
        || (s.kind === "state_field_assign" && /\bset_return_data\s*\(/.test(s.value))
      ),
    );
    const usesGetReturnData = _ir.instructions.some((i) =>
      i.body.some((s) =>
        (s.kind === "pass_through" && /\bget_return_data\s*\(/.test(s.code))
        || (s.kind === "state_field_assign" && /\bget_return_data\s*\(/.test(s.value))
      ),
    );
    if (usesSetReturnData && usesGetReturnData) {
      imports.push(`use pinocchio::program::{get_return_data, set_return_data};`);
    } else if (usesSetReturnData) {
      imports.push(`use pinocchio::program::set_return_data;`);
    } else if (usesGetReturnData) {
      imports.push(`use pinocchio::program::get_return_data;`);
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

  /**
   * pinocchio doesn't expose `Instruction`, `AccountMeta`, or other
   * solana_program::instruction types that user-defined trait impls often
   * target (coral-multisig: `impl From<&Transaction> for Instruction`).
   * The companion call-site commentout pass (postProcessPinocchioRewrites)
   * already excises every consumer of those impls, so emitting the impls
   * themselves only adds compile errors. Skip entirely on pinocchio.
   */
  override emitUserTraitImpls(_ir: SolanaIR): string {
    return "";
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

  override emitSplTransfer(from: string, to: string, authority: string, amount: string, signerSeeds?: string, opts?: Token2022Opts): string {
    if (opts?.tokenProgram === "token_2022") {
      // pinocchio_token::Transfer{,Checked} hardcodes the SPL Token program
      // ID, so we hand-roll the CPI against the Token-2022 program.
      // Branch on whether the source used `_checked` (decimals provided) vs
      // the unchecked variant — the routing must mirror the user's choice
      // since unchecked transfer omits `mint` from the accounts list.
      if (opts?.decimals === undefined) {
        // Token-2022 transfer (unchecked) — discriminator 3,
        // accounts [from, to, authority], data [3, amount_u64_le] (9 bytes).
        const invokeCall = emitT22Invoke(`${from}, ${to}, ${authority}`, signerSeeds);
        return `    // Token-2022 transfer (unchecked) — ${from} → ${to}
    {
${TOKEN_2022_PROGRAM_ID_CONST}
        let __t22_amount = (${amount}).to_le_bytes();
        let __t22_data: [u8; 9] = [
            3,
            __t22_amount[0], __t22_amount[1], __t22_amount[2], __t22_amount[3],
            __t22_amount[4], __t22_amount[5], __t22_amount[6], __t22_amount[7],
        ];
        let __t22_metas = [
            pinocchio::instruction::AccountMeta::writable(${from}.key()),
            pinocchio::instruction::AccountMeta::writable(${to}.key()),
            pinocchio::instruction::AccountMeta::readonly_signer(${authority}.key()),
        ];
        let __t22_ix = pinocchio::instruction::Instruction {
            program_id: &TOKEN_2022_PROGRAM_ID,
            accounts: &__t22_metas,
            data: &__t22_data,
        };
${invokeCall}
    }`;
      }
      // Token-2022 transfer_checked — discriminator 12,
      // accounts [from, mint, to, authority], data [12, amount_u64_le, decimals_u8].
      // When the helper-method CPI flow couldn't resolve the mint argument
      // (probe surfaced this in coral-escrow / anchor-escrow's
      // `into_transfer_to_taker_context`-style helpers), emit a fully
      // commented-out stub instead of a partial block with `.key()` on a
      // raw `/* TODO */` placeholder — that placeholder shape produces
      // `error: expected expression, found '.'` and wedges parsing for the
      // entire surrounding function. Compiling-but-runtime-no-op is the
      // same threshold we already use for unsupported Metaplex CPIs.
      if (!opts?.mint) {
        return `    // TODO(manual): Token-2022 transfer_checked — ${from} → ${to}
    // Could not resolve mint argument from helper-method CPI context.
    // Reconstruct manually: pass the mint AccountInfo + decimals literal.
    // Original call shape: transfer_checked(ctx, amount, decimals)`;
      }
      const mint = opts.mint;
      const { decimalsExpr, prelude } = resolveT22DecimalsPinocchio(mint, opts?.decimals);
      const invokeCall = emitT22Invoke(`${from}, ${mint}, ${to}, ${authority}`, signerSeeds);
      // Runtime program-ID dispatch (TokenInterface). When tokenProgramArg
      // is set, the program ID comes from the AccountInfo at runtime
      // instead of a compile-time const. SPL Token + SPL Token-2022
      // share the transfer_checked discriminator (12) + account layout
      // ([from, mint, to, authority]) + data shape, so the SAME body
      // shape works for either runtime — only the program_id source
      // changes. Drops the TOKEN_2022_PROGRAM_ID const declaration when
      // we don't need it.
      const useRuntimeDispatch = !!opts?.tokenProgramArg;
      const programIdConstBlock = useRuntimeDispatch ? "" : `${TOKEN_2022_PROGRAM_ID_CONST}\n`;
      const programIdRef = useRuntimeDispatch
        ? `${opts!.tokenProgramArg}.key()`
        : `&TOKEN_2022_PROGRAM_ID`;
      return `    // Token-2022 transfer_checked — ${from} → ${to}
${prelude}    {
${programIdConstBlock}        let __t22_amount = (${amount}).to_le_bytes();
        let __t22_data: [u8; 10] = [
            12,
            __t22_amount[0], __t22_amount[1], __t22_amount[2], __t22_amount[3],
            __t22_amount[4], __t22_amount[5], __t22_amount[6], __t22_amount[7],
            ${decimalsExpr},
        ];
        let __t22_metas = [
            pinocchio::instruction::AccountMeta::writable(${from}.key()),
            pinocchio::instruction::AccountMeta::readonly(${mint}.key()),
            pinocchio::instruction::AccountMeta::writable(${to}.key()),
            pinocchio::instruction::AccountMeta::readonly_signer(${authority}.key()),
        ];
        let __t22_ix = pinocchio::instruction::Instruction {
            program_id: ${programIdRef},
            accounts: &__t22_metas,
            data: &__t22_data,
        };
${invokeCall}
    }`;
    }
    if (signerSeeds) {
      return `    // SPL Token transfer (PDA signed) — ${from} → ${to}
    spl_token_transfer_signed(${from}, ${to}, ${authority}, ${amount}, ${signerSeeds})?;`;
    }
    return `    // SPL Token transfer — ${from} → ${to}
    spl_token_transfer(${from}, ${to}, ${authority}, ${amount})?;`;
  }

  override emitSplMintTo(mint: string, to: string, authority: string, amount: string, signerSeeds?: string, opts?: Token2022Opts): string {
    if (opts?.tokenProgram === "token_2022") {
      if (opts?.decimals === undefined) {
        // Token-2022 mint_to (unchecked) — discriminator 7,
        // accounts [mint, to, authority], data [7, amount_u64_le] (9 bytes).
        const invokeCall = emitT22Invoke(`${mint}, ${to}, ${authority}`, signerSeeds);
        return `    // Token-2022 mint_to (unchecked) — ${mint} → ${to}
    {
${TOKEN_2022_PROGRAM_ID_CONST}
        let __t22_amount = (${amount}).to_le_bytes();
        let __t22_data: [u8; 9] = [
            7,
            __t22_amount[0], __t22_amount[1], __t22_amount[2], __t22_amount[3],
            __t22_amount[4], __t22_amount[5], __t22_amount[6], __t22_amount[7],
        ];
        let __t22_metas = [
            pinocchio::instruction::AccountMeta::writable(${mint}.key()),
            pinocchio::instruction::AccountMeta::writable(${to}.key()),
            pinocchio::instruction::AccountMeta::readonly_signer(${authority}.key()),
        ];
        let __t22_ix = pinocchio::instruction::Instruction {
            program_id: &TOKEN_2022_PROGRAM_ID,
            accounts: &__t22_metas,
            data: &__t22_data,
        };
${invokeCall}
    }`;
      }
      // Token-2022 mint_to_checked — discriminator 14,
      // accounts [mint, to, authority], data [14, amount_u64_le, decimals_u8].
      const { decimalsExpr, prelude } = resolveT22DecimalsPinocchio(mint, opts?.decimals);
      const invokeCall = emitT22Invoke(`${mint}, ${to}, ${authority}`, signerSeeds);
      return `    // Token-2022 mint_to_checked — ${mint} → ${to}
${prelude}    {
${TOKEN_2022_PROGRAM_ID_CONST}
        let __t22_amount = (${amount}).to_le_bytes();
        let __t22_data: [u8; 10] = [
            14,
            __t22_amount[0], __t22_amount[1], __t22_amount[2], __t22_amount[3],
            __t22_amount[4], __t22_amount[5], __t22_amount[6], __t22_amount[7],
            ${decimalsExpr},
        ];
        let __t22_metas = [
            pinocchio::instruction::AccountMeta::writable(${mint}.key()),
            pinocchio::instruction::AccountMeta::writable(${to}.key()),
            pinocchio::instruction::AccountMeta::readonly_signer(${authority}.key()),
        ];
        let __t22_ix = pinocchio::instruction::Instruction {
            program_id: &TOKEN_2022_PROGRAM_ID,
            accounts: &__t22_metas,
            data: &__t22_data,
        };
${invokeCall}
    }`;
    }
    const signed = signerSeeds ? "_signed" : "";
    return `    // SPL Token mint_to — ${mint} → ${to}
    spl_token_mint_to${signed}(${mint}, ${to}, ${authority}, ${amount}${signerSeeds ? `, ${signerSeeds}` : ""})?;`;
  }

  override emitSplBurn(from: string, mint: string, authority: string, amount: string, signerSeeds?: string, opts?: Token2022Opts): string {
    if (opts?.tokenProgram === "token_2022") {
      if (opts?.decimals === undefined) {
        // Token-2022 burn (unchecked) — discriminator 8,
        // accounts [from, mint, authority], data [8, amount_u64_le] (9 bytes).
        const invokeCall = emitT22Invoke(`${from}, ${mint}, ${authority}`, signerSeeds);
        return `    // Token-2022 burn (unchecked) — ${from}
    {
${TOKEN_2022_PROGRAM_ID_CONST}
        let __t22_amount = (${amount}).to_le_bytes();
        let __t22_data: [u8; 9] = [
            8,
            __t22_amount[0], __t22_amount[1], __t22_amount[2], __t22_amount[3],
            __t22_amount[4], __t22_amount[5], __t22_amount[6], __t22_amount[7],
        ];
        let __t22_metas = [
            pinocchio::instruction::AccountMeta::writable(${from}.key()),
            pinocchio::instruction::AccountMeta::writable(${mint}.key()),
            pinocchio::instruction::AccountMeta::readonly_signer(${authority}.key()),
        ];
        let __t22_ix = pinocchio::instruction::Instruction {
            program_id: &TOKEN_2022_PROGRAM_ID,
            accounts: &__t22_metas,
            data: &__t22_data,
        };
${invokeCall}
    }`;
      }
      // Token-2022 burn_checked — discriminator 15,
      // accounts [from, mint, authority], data [15, amount_u64_le, decimals_u8].
      const { decimalsExpr, prelude } = resolveT22DecimalsPinocchio(mint, opts?.decimals);
      const invokeCall = emitT22Invoke(`${from}, ${mint}, ${authority}`, signerSeeds);
      return `    // Token-2022 burn_checked — ${from}
${prelude}    {
${TOKEN_2022_PROGRAM_ID_CONST}
        let __t22_amount = (${amount}).to_le_bytes();
        let __t22_data: [u8; 10] = [
            15,
            __t22_amount[0], __t22_amount[1], __t22_amount[2], __t22_amount[3],
            __t22_amount[4], __t22_amount[5], __t22_amount[6], __t22_amount[7],
            ${decimalsExpr},
        ];
        let __t22_metas = [
            pinocchio::instruction::AccountMeta::writable(${from}.key()),
            pinocchio::instruction::AccountMeta::writable(${mint}.key()),
            pinocchio::instruction::AccountMeta::readonly_signer(${authority}.key()),
        ];
        let __t22_ix = pinocchio::instruction::Instruction {
            program_id: &TOKEN_2022_PROGRAM_ID,
            accounts: &__t22_metas,
            data: &__t22_data,
        };
${invokeCall}
    }`;
    }
    const signed = signerSeeds ? "_signed" : "";
    return `    // SPL Token burn — ${from}
    spl_token_burn${signed}(${from}, ${mint}, ${authority}, ${amount}${signerSeeds ? `, ${signerSeeds}` : ""})?;`;
  }

  override emitSplCloseAccount(account: string, destination: string, authority: string, signerSeeds?: string, opts?: Token2022Opts): string {
    if (opts?.tokenProgram === "token_2022") {
      // Token-2022 close_account — discriminator 9, no `_checked` variant
      // exists. Accounts [account, destination, authority], data [9].
      const invokeCall = emitT22Invoke(`${account}, ${destination}, ${authority}`, signerSeeds);
      return `    // Token-2022 close account — ${account}
    {
${TOKEN_2022_PROGRAM_ID_CONST}
        let __t22_metas = [
            pinocchio::instruction::AccountMeta::writable(${account}.key()),
            pinocchio::instruction::AccountMeta::writable(${destination}.key()),
            pinocchio::instruction::AccountMeta::readonly_signer(${authority}.key()),
        ];
        let __t22_ix = pinocchio::instruction::Instruction {
            program_id: &TOKEN_2022_PROGRAM_ID,
            accounts: &__t22_metas,
            data: &[9],
        };
${invokeCall}
    }`;
    }
    const signed = signerSeeds ? "_signed" : "";
    return `    // SPL Token close account — ${account}
    spl_token_close_account${signed}(${account}, ${destination}, ${authority}${signerSeeds ? `, ${signerSeeds}` : ""})?;`;
  }

  override emitSplSetAuthority(
    account: string,
    currentAuthority: string,
    authorityType: string,
    newAuthority: string,
    signerSeeds?: string,
    opts?: Token2022Opts,
  ): string {
    // Map Anchor's `AuthorityType::X` variant to the SPL byte. Unknown
    // variants get a TODO comment + a default of AccountOwner (the most
    // common). pinocchio_token doesn't expose set_authority, so we
    // hand-roll the raw CPI against the program ID.
    const variant = authorityType.trim().match(/AuthorityType::(\w+)/)?.[1];
    const variantByte: Record<string, number> = {
      MintTokens: 0,
      FreezeAccount: 1,
      AccountOwner: 2,
      CloseAccount: 3,
    };
    const authTypeByte =
      variant && variantByte[variant] !== undefined
        ? `${variantByte[variant]}u8`
        : `2u8/* ⚠️ Anvil TODO: unrecognized AuthorityType '${authorityType}', defaulted to AccountOwner */`;
    const programIdConst =
      opts?.tokenProgram === "token_2022"
        ? TOKEN_2022_PROGRAM_ID_CONST
        : `        const SPL_TOKEN_PROGRAM_ID: pinocchio::pubkey::Pubkey = [6, 221, 246, 225, 215, 101, 161, 147, 217, 203, 225, 70, 206, 235, 121, 172, 28, 180, 133, 237, 95, 91, 55, 145, 58, 140, 245, 133, 126, 255, 0, 169];`;
    const programIdRef = opts?.tokenProgram === "token_2022" ? "TOKEN_2022_PROGRAM_ID" : "SPL_TOKEN_PROGRAM_ID";
    // Convert Anchor's `&[&[&[u8]]]` signer-seeds shape into pinocchio's
    // `&[Signer]` (where Signer wraps `&[Seed]`). Use the same const-size
    // [Seed; 8] stack-alloc pattern as the create_account_signed rewrite
    // in postProcessPinocchioRewrites — fixed cap, no Vec, no_std-safe.
    const invokeCall = signerSeeds
      ? `        let __sa_seed_refs = ${signerSeeds}[0];
        let mut __sa_pda_seeds: [pinocchio::instruction::Seed<'_>; 8] =
            core::array::from_fn(|_| pinocchio::instruction::Seed::from(&[][..]));
        for (__sa_i, __sa_s) in __sa_seed_refs.iter().enumerate() {
            if __sa_i >= __sa_pda_seeds.len() { return Err(ProgramError::InvalidSeeds); }
            __sa_pda_seeds[__sa_i] = pinocchio::instruction::Seed::from(*__sa_s);
        }
        let __sa_signer = pinocchio::instruction::Signer::from(&__sa_pda_seeds[..__sa_seed_refs.len()]);
        pinocchio::cpi::invoke_signed(&__sa_ix, &[${account}, ${currentAuthority}], &[__sa_signer])?;`
      : `        pinocchio::cpi::invoke(&__sa_ix, &[${account}, ${currentAuthority}])?;`;
    return `    // ${opts?.tokenProgram === "token_2022" ? "Token-2022" : "SPL Token"} set authority — ${account}
    {
${programIdConst}
        let __sa_auth_byte: u8 = ${authTypeByte};
        let mut __sa_data = [0u8; 35];
        let mut __sa_len = 3usize;
        __sa_data[0] = 6;
        __sa_data[1] = __sa_auth_byte;
        match &${newAuthority} {
            Some(__pk) => {
                __sa_data[2] = 1;
                __sa_data[3..35].copy_from_slice(__pk.as_ref());
                __sa_len = 35;
            }
            None => {
                __sa_data[2] = 0;
            }
        }
        let __sa_metas = [
            pinocchio::instruction::AccountMeta::writable(${account}.key()),
            pinocchio::instruction::AccountMeta::readonly_signer(${currentAuthority}.key()),
        ];
        let __sa_ix = pinocchio::instruction::Instruction {
            program_id: &${programIdRef},
            accounts: &__sa_metas,
            data: &__sa_data[..__sa_len],
        };
${invokeCall}
    }`;
  }

  override emitT22TransferFeeInitialize(
    mint: string,
    _tokenProgram: string,
    transferFeeConfigAuthority: string,
    withdrawWithheldAuthority: string,
    basisPoints: string,
    maximumFee: string,
    signerSeeds?: string,
  ): string {
    // Token-2022 TransferFee InitializeTransferFeeConfig: outer
    // discriminator 26 (TransferFeeExtension) + inner 0
    // (InitializeTransferFeeConfig) + payload:
    //   COption<&Pubkey> transfer_fee_config_authority (1 + 0/32 bytes)
    //   COption<&Pubkey> withdraw_withheld_authority   (1 + 0/32 bytes)
    //   u16 LE basis_points                            (2 bytes)
    //   u64 LE maximum_fee                             (8 bytes)
    // Max payload = 78 bytes (2 disc + 33 + 33 + 2 + 8).
    const invokeCall = signerSeeds
      ? `        let __tf_seed_refs = ${signerSeeds}[0];
        let mut __tf_pda_seeds: [pinocchio::instruction::Seed<'_>; 8] =
            core::array::from_fn(|_| pinocchio::instruction::Seed::from(&[][..]));
        for (__tf_i, __tf_s) in __tf_seed_refs.iter().enumerate() {
            if __tf_i >= __tf_pda_seeds.len() { return Err(ProgramError::InvalidSeeds); }
            __tf_pda_seeds[__tf_i] = pinocchio::instruction::Seed::from(*__tf_s);
        }
        let __tf_signer = pinocchio::instruction::Signer::from(&__tf_pda_seeds[..__tf_seed_refs.len()]);
        pinocchio::cpi::invoke_signed(&__tf_ix, &[${mint}], &[__tf_signer])?;`
      : `        pinocchio::cpi::invoke(&__tf_ix, &[${mint}])?;`;
    return `    // Token-2022 TransferFee extension init — ${mint}
    {
${TOKEN_2022_PROGRAM_ID_CONST}
        let mut __tf_data = [0u8; 78];
        __tf_data[0] = 26;
        __tf_data[1] = 0;
        let mut __tf_len = 2usize;
        match &${transferFeeConfigAuthority} {
            Some(__pk) => {
                __tf_data[__tf_len] = 1;
                __tf_data[__tf_len + 1..__tf_len + 33].copy_from_slice(__pk.as_ref());
                __tf_len += 33;
            }
            None => {
                __tf_data[__tf_len] = 0;
                __tf_len += 1;
            }
        }
        match &${withdrawWithheldAuthority} {
            Some(__pk) => {
                __tf_data[__tf_len] = 1;
                __tf_data[__tf_len + 1..__tf_len + 33].copy_from_slice(__pk.as_ref());
                __tf_len += 33;
            }
            None => {
                __tf_data[__tf_len] = 0;
                __tf_len += 1;
            }
        }
        let __tf_bp: u16 = ${basisPoints};
        __tf_data[__tf_len..__tf_len + 2].copy_from_slice(&__tf_bp.to_le_bytes());
        __tf_len += 2;
        let __tf_max: u64 = ${maximumFee};
        __tf_data[__tf_len..__tf_len + 8].copy_from_slice(&__tf_max.to_le_bytes());
        __tf_len += 8;
        let __tf_metas = [
            pinocchio::instruction::AccountMeta::writable(${mint}.key()),
        ];
        let __tf_ix = pinocchio::instruction::Instruction {
            program_id: &TOKEN_2022_PROGRAM_ID,
            accounts: &__tf_metas,
            data: &__tf_data[..__tf_len],
        };
${invokeCall}
    }`;
  }

  override emitT22TransferFeeSetFee(
    mint: string,
    _tokenProgram: string,
    authority: string,
    basisPoints: string,
    maximumFee: string,
    signerSeeds?: string,
  ): string {
    // SetTransferFee: outer 26 + inner 5 + u16 bp + u64 max = 12 bytes.
    const invokeCall = signerSeeds
      ? `        let __ts_seed_refs = ${signerSeeds}[0];
        let mut __ts_pda_seeds: [pinocchio::instruction::Seed<'_>; 8] =
            core::array::from_fn(|_| pinocchio::instruction::Seed::from(&[][..]));
        for (__ts_i, __ts_s) in __ts_seed_refs.iter().enumerate() {
            if __ts_i >= __ts_pda_seeds.len() { return Err(ProgramError::InvalidSeeds); }
            __ts_pda_seeds[__ts_i] = pinocchio::instruction::Seed::from(*__ts_s);
        }
        let __ts_signer = pinocchio::instruction::Signer::from(&__ts_pda_seeds[..__ts_seed_refs.len()]);
        pinocchio::cpi::invoke_signed(&__ts_ix, &[${mint}, ${authority}], &[__ts_signer])?;`
      : `        pinocchio::cpi::invoke(&__ts_ix, &[${mint}, ${authority}])?;`;
    return `    // Token-2022 TransferFee — set fee schedule on ${mint}
    {
${TOKEN_2022_PROGRAM_ID_CONST}
        let mut __ts_data = [0u8; 12];
        __ts_data[0] = 26;
        __ts_data[1] = 5;
        let __ts_bp: u16 = ${basisPoints};
        __ts_data[2..4].copy_from_slice(&__ts_bp.to_le_bytes());
        let __ts_max: u64 = ${maximumFee};
        __ts_data[4..12].copy_from_slice(&__ts_max.to_le_bytes());
        let __ts_metas = [
            pinocchio::instruction::AccountMeta::writable(${mint}.key()),
            pinocchio::instruction::AccountMeta::readonly_signer(${authority}.key()),
        ];
        let __ts_ix = pinocchio::instruction::Instruction {
            program_id: &TOKEN_2022_PROGRAM_ID,
            accounts: &__ts_metas,
            data: &__ts_data,
        };
${invokeCall}
    }`;
  }

  override emitT22TransferCheckedWithFee(
    source: string,
    mint: string,
    destination: string,
    authority: string,
    _tokenProgram: string,
    amount: string,
    decimals: string,
    fee: string,
    signerSeeds?: string,
  ): string {
    // TransferFeeExtension(26) → TransferCheckedWithFee(1).
    // Payload: u64 amount LE + u8 decimals + u64 fee LE = 17 bytes.
    // Total data: 2 disc + 17 = 19 bytes.
    const invokeCall = signerSeeds
      ? `        let __tcwf_seed_refs = ${signerSeeds}[0];
        let mut __tcwf_pda_seeds: [pinocchio::instruction::Seed<'_>; 8] =
            core::array::from_fn(|_| pinocchio::instruction::Seed::from(&[][..]));
        for (__tcwf_i, __tcwf_s) in __tcwf_seed_refs.iter().enumerate() {
            if __tcwf_i >= __tcwf_pda_seeds.len() { return Err(ProgramError::InvalidSeeds); }
            __tcwf_pda_seeds[__tcwf_i] = pinocchio::instruction::Seed::from(*__tcwf_s);
        }
        let __tcwf_signer = pinocchio::instruction::Signer::from(&__tcwf_pda_seeds[..__tcwf_seed_refs.len()]);
        pinocchio::cpi::invoke_signed(&__tcwf_ix, &[${source}, ${mint}, ${destination}, ${authority}], &[__tcwf_signer])?;`
      : `        pinocchio::cpi::invoke(&__tcwf_ix, &[${source}, ${mint}, ${destination}, ${authority}])?;`;
    return `    // Token-2022 TransferFee — transfer_checked_with_fee
    {
${TOKEN_2022_PROGRAM_ID_CONST}
        let mut __tcwf_data = [0u8; 19];
        __tcwf_data[0] = 26;
        __tcwf_data[1] = 1;
        let __tcwf_amount: u64 = ${amount};
        __tcwf_data[2..10].copy_from_slice(&__tcwf_amount.to_le_bytes());
        let __tcwf_decimals: u8 = ${decimals};
        __tcwf_data[10] = __tcwf_decimals;
        let __tcwf_fee: u64 = ${fee};
        __tcwf_data[11..19].copy_from_slice(&__tcwf_fee.to_le_bytes());
        let __tcwf_metas = [
            pinocchio::instruction::AccountMeta::writable(${source}.key()),
            pinocchio::instruction::AccountMeta::readonly(${mint}.key()),
            pinocchio::instruction::AccountMeta::writable(${destination}.key()),
            pinocchio::instruction::AccountMeta::readonly_signer(${authority}.key()),
        ];
        let __tcwf_ix = pinocchio::instruction::Instruction {
            program_id: &TOKEN_2022_PROGRAM_ID,
            accounts: &__tcwf_metas,
            data: &__tcwf_data,
        };
${invokeCall}
    }`;
  }

  override emitT22WithdrawWithheldFromMint(
    mint: string,
    destination: string,
    authority: string,
    _tokenProgram: string,
    signerSeeds?: string,
  ): string {
    // TransferFeeExtension(26) → WithdrawWithheldTokensFromMint(2).
    // No payload — 2 bytes total.
    const invokeCall = signerSeeds
      ? `        let __wwfm_seed_refs = ${signerSeeds}[0];
        let mut __wwfm_pda_seeds: [pinocchio::instruction::Seed<'_>; 8] =
            core::array::from_fn(|_| pinocchio::instruction::Seed::from(&[][..]));
        for (__wwfm_i, __wwfm_s) in __wwfm_seed_refs.iter().enumerate() {
            if __wwfm_i >= __wwfm_pda_seeds.len() { return Err(ProgramError::InvalidSeeds); }
            __wwfm_pda_seeds[__wwfm_i] = pinocchio::instruction::Seed::from(*__wwfm_s);
        }
        let __wwfm_signer = pinocchio::instruction::Signer::from(&__wwfm_pda_seeds[..__wwfm_seed_refs.len()]);
        pinocchio::cpi::invoke_signed(&__wwfm_ix, &[${mint}, ${destination}, ${authority}], &[__wwfm_signer])?;`
      : `        pinocchio::cpi::invoke(&__wwfm_ix, &[${mint}, ${destination}, ${authority}])?;`;
    return `    // Token-2022 TransferFee — withdraw_withheld_tokens_from_mint
    {
${TOKEN_2022_PROGRAM_ID_CONST}
        let __wwfm_data = [26u8, 2u8];
        let __wwfm_metas = [
            pinocchio::instruction::AccountMeta::writable(${mint}.key()),
            pinocchio::instruction::AccountMeta::writable(${destination}.key()),
            pinocchio::instruction::AccountMeta::readonly_signer(${authority}.key()),
        ];
        let __wwfm_ix = pinocchio::instruction::Instruction {
            program_id: &TOKEN_2022_PROGRAM_ID,
            accounts: &__wwfm_metas,
            data: &__wwfm_data,
        };
${invokeCall}
    }`;
  }

  override emitT22TokenMetadataInitialize(
    metadata: string,
    mint: string,
    mintAuthority: string,
    updateAuthority: string,
    _tokenProgram: string,
    name: string,
    symbol: string,
    uri: string,
    _signerSeeds?: string,
  ): string {
    // TokenMetadata uses the spl-token-metadata-interface protocol
    // layered on Token-2022. The Initialize discriminator is the first
    // 8 bytes of sha256("spl_token_metadata_interface:initialize_account"),
    // precomputed: d2e11ea258b84d8d → [210, 225, 30, 162, 88, 184, 77, 141].
    // Payload is Borsh-encoded (u32 LE length + UTF-8 bytes) for each of
    // name, symbol, uri. We serialize into a fixed-size 1024-byte stack
    // buffer — Solana's instruction-data ceiling is 1232 bytes, so this
    // covers any realistic metadata payload while staying no_std.
    return `    // Token-2022 TokenMetadata extension init — ${metadata}
    {
${TOKEN_2022_PROGRAM_ID_CONST}
        // sha256("spl_token_metadata_interface:initialize_account")[..8]
        const __TMI_DISC: [u8; 8] = [210, 225, 30, 162, 88, 184, 77, 141];
        let mut __tmi_data = [0u8; 1024];
        let mut __tmi_len: usize = 0;
        __tmi_data[..8].copy_from_slice(&__TMI_DISC);
        __tmi_len = 8;
        // Borsh String: u32 LE length prefix + UTF-8 bytes, repeated for
        // name, symbol, uri. Bounds-check each write against the 1024-byte
        // stack buffer (Solana ix-data cap is 1232).
        let __tmi_name_bytes = ${name}.as_bytes();
        if __tmi_len + 4 + __tmi_name_bytes.len() > __tmi_data.len() {
            return Err(ProgramError::InvalidInstructionData);
        }
        __tmi_data[__tmi_len..__tmi_len + 4]
            .copy_from_slice(&(__tmi_name_bytes.len() as u32).to_le_bytes());
        __tmi_len += 4;
        __tmi_data[__tmi_len..__tmi_len + __tmi_name_bytes.len()]
            .copy_from_slice(__tmi_name_bytes);
        __tmi_len += __tmi_name_bytes.len();
        let __tmi_symbol_bytes = ${symbol}.as_bytes();
        if __tmi_len + 4 + __tmi_symbol_bytes.len() > __tmi_data.len() {
            return Err(ProgramError::InvalidInstructionData);
        }
        __tmi_data[__tmi_len..__tmi_len + 4]
            .copy_from_slice(&(__tmi_symbol_bytes.len() as u32).to_le_bytes());
        __tmi_len += 4;
        __tmi_data[__tmi_len..__tmi_len + __tmi_symbol_bytes.len()]
            .copy_from_slice(__tmi_symbol_bytes);
        __tmi_len += __tmi_symbol_bytes.len();
        let __tmi_uri_bytes = ${uri}.as_bytes();
        if __tmi_len + 4 + __tmi_uri_bytes.len() > __tmi_data.len() {
            return Err(ProgramError::InvalidInstructionData);
        }
        __tmi_data[__tmi_len..__tmi_len + 4]
            .copy_from_slice(&(__tmi_uri_bytes.len() as u32).to_le_bytes());
        __tmi_len += 4;
        __tmi_data[__tmi_len..__tmi_len + __tmi_uri_bytes.len()]
            .copy_from_slice(__tmi_uri_bytes);
        __tmi_len += __tmi_uri_bytes.len();
        let __tmi_metas = [
            pinocchio::instruction::AccountMeta::writable(${metadata}.key()),
            pinocchio::instruction::AccountMeta::readonly_signer(${updateAuthority}.key()),
            pinocchio::instruction::AccountMeta::readonly(${mint}.key()),
            pinocchio::instruction::AccountMeta::readonly_signer(${mintAuthority}.key()),
        ];
        let __tmi_ix = pinocchio::instruction::Instruction {
            program_id: &TOKEN_2022_PROGRAM_ID,
            accounts: &__tmi_metas,
            data: &__tmi_data[..__tmi_len],
        };
        pinocchio::cpi::invoke(&__tmi_ix, &[${metadata}, ${updateAuthority}, ${mint}, ${mintAuthority}])?;
    }`;
  }

  override emitT22TokenMetadataUpdateField(
    metadata: string,
    updateAuthority: string,
    _tokenProgram: string,
    field: string,
    value: string,
    _signerSeeds?: string,
  ): string {
    // sha256("spl_token_metadata_interface:updating_field")[..8]
    //   = [221, 233, 49, 45, 181, 202, 220, 200]
    // Wire payload: 8-byte disc + Borsh Field enum + Borsh String value.
    // Field encoding (Borsh):
    //   Name  → 0x00
    //   Symbol → 0x01
    //   Uri   → 0x02
    //   Key(s)→ 0x03 + u32 LE strlen + UTF-8 bytes
    const enc = mapFieldLiteralToEncoding(field);
    if (enc === null) {
      return `    // ⚠️ Anvil TODO: token_metadata_update_field(metadata=${metadata}, field=${field}, value=${value})
    //   Pinocchio path supports literal Field::{Name,Symbol,Uri,Key("...")};
    //   the source uses a non-literal expression. Hand-roll the disc+payload
    //   if needed.`;
    }
    // Field-encoding block written into the buffer right after the 8-byte disc.
    // For Field::Key("..."), bind the inner expression to a named local
    // first so a String temporary (e.g. `String::from("foo")`) outlives
    // the .as_bytes() borrow (E0716 otherwise).
    const fieldBlock = enc.kind === "fixed"
      ? `        __tmuf_data[__tmuf_len] = ${enc.byte};
        __tmuf_len += 1;`
      : `        __tmuf_data[__tmuf_len] = 3;
        __tmuf_len += 1;
        let __tmuf_key_owned = ${enc.literal};
        let __tmuf_key_bytes = __tmuf_key_owned.as_bytes();
        if __tmuf_len + 4 + __tmuf_key_bytes.len() > __tmuf_data.len() {
            return Err(ProgramError::InvalidInstructionData);
        }
        __tmuf_data[__tmuf_len..__tmuf_len + 4]
            .copy_from_slice(&(__tmuf_key_bytes.len() as u32).to_le_bytes());
        __tmuf_len += 4;
        __tmuf_data[__tmuf_len..__tmuf_len + __tmuf_key_bytes.len()]
            .copy_from_slice(__tmuf_key_bytes);
        __tmuf_len += __tmuf_key_bytes.len();`;
    return `    // Token-2022 TokenMetadata update_field — ${metadata}
    {
${TOKEN_2022_PROGRAM_ID_CONST}
        // sha256("spl_token_metadata_interface:updating_field")[..8]
        const __TMUF_DISC: [u8; 8] = [221, 233, 49, 45, 181, 202, 220, 200];
        let mut __tmuf_data = [0u8; 1024];
        let mut __tmuf_len: usize = 0;
        __tmuf_data[..8].copy_from_slice(&__TMUF_DISC);
        __tmuf_len = 8;
${fieldBlock}
        // Borsh String value: u32 LE length prefix + UTF-8 bytes.
        let __tmuf_value_bytes = ${value}.as_bytes();
        if __tmuf_len + 4 + __tmuf_value_bytes.len() > __tmuf_data.len() {
            return Err(ProgramError::InvalidInstructionData);
        }
        __tmuf_data[__tmuf_len..__tmuf_len + 4]
            .copy_from_slice(&(__tmuf_value_bytes.len() as u32).to_le_bytes());
        __tmuf_len += 4;
        __tmuf_data[__tmuf_len..__tmuf_len + __tmuf_value_bytes.len()]
            .copy_from_slice(__tmuf_value_bytes);
        __tmuf_len += __tmuf_value_bytes.len();
        let __tmuf_metas = [
            pinocchio::instruction::AccountMeta::writable(${metadata}.key()),
            pinocchio::instruction::AccountMeta::readonly_signer(${updateAuthority}.key()),
        ];
        let __tmuf_ix = pinocchio::instruction::Instruction {
            program_id: &TOKEN_2022_PROGRAM_ID,
            accounts: &__tmuf_metas,
            data: &__tmuf_data[..__tmuf_len],
        };
        pinocchio::cpi::invoke(&__tmuf_ix, &[${metadata}, ${updateAuthority}])?;
    }`;
  }

  override emitT22TokenMetadataUpdateAuthority(
    metadata: string,
    currentAuthority: string,
    _tokenProgram: string,
    newAuthority: string,
    _signerSeeds?: string,
  ): string {
    // sha256("spl_token_metadata_interface:update_the_authority")[..8]
    //   = [215, 228, 166, 228, 84, 100, 86, 123]
    // Wire payload: 8-byte disc + 32-byte OptionalNonZeroPubkey (zeros = None).
    const enc = mapNewAuthorityLiteralToEncoding(newAuthority);
    if (enc === null) {
      return `    // ⚠️ Anvil TODO: token_metadata_update_authority(metadata=${metadata}, new_authority=${newAuthority})
    //   Pinocchio path supports literal OptionalNonZeroPubkey::try_from(None|Some(<pk>))?;
    //   the source uses a non-literal expression. Hand-roll the disc+32-byte payload
    //   if needed.`;
    }
    const payloadBlock = enc.kind === "none"
      ? `        // None — bytes 8..40 already zero-initialised`
      : `        // Some(pk) — copy 32 pubkey bytes
        let __tmua_pk_bytes: &[u8; 32] = (${enc.pubkeyExpr}).as_ref();
        __tmua_data[8..40].copy_from_slice(__tmua_pk_bytes);`;
    return `    // Token-2022 TokenMetadata update_authority — ${metadata}
    {
${TOKEN_2022_PROGRAM_ID_CONST}
        // sha256("spl_token_metadata_interface:update_the_authority")[..8]
        const __TMUA_DISC: [u8; 8] = [215, 228, 166, 228, 84, 100, 86, 123];
        let mut __tmua_data = [0u8; 40];
        __tmua_data[..8].copy_from_slice(&__TMUA_DISC);
${payloadBlock}
        let __tmua_metas = [
            pinocchio::instruction::AccountMeta::writable(${metadata}.key()),
            pinocchio::instruction::AccountMeta::readonly_signer(${currentAuthority}.key()),
        ];
        let __tmua_ix = pinocchio::instruction::Instruction {
            program_id: &TOKEN_2022_PROGRAM_ID,
            accounts: &__tmua_metas,
            data: &__tmua_data,
        };
        pinocchio::cpi::invoke(&__tmua_ix, &[${metadata}, ${currentAuthority}])?;
    }`;
  }

  override emitT22DefaultAccountStateInitialize(
    mint: string,
    _tokenProgram: string,
    state: string,
    signerSeeds?: string,
  ): string {
    // DefaultAccountStateExtension(28) → Initialize(0). Payload: 1 byte
    // state value. Total: 3 bytes.
    const stateByte = mapAccountStateLiteralToByte(state);
    if (stateByte === null) {
      return `    // ⚠️ Anvil TODO: default_account_state_initialize(${mint}, state=${state})
    //   Pinocchio path supports literal &AccountState::{Uninitialized,Initialized,Frozen};
    //   the source uses a non-literal expression. Hand-roll the u8 byte if needed.`;
    }
    const invokeCall = signerSeeds
      ? `        let __dasi_seed_refs = ${signerSeeds}[0];
        let mut __dasi_pda_seeds: [pinocchio::instruction::Seed<'_>; 8] =
            core::array::from_fn(|_| pinocchio::instruction::Seed::from(&[][..]));
        for (__dasi_i, __dasi_s) in __dasi_seed_refs.iter().enumerate() {
            if __dasi_i >= __dasi_pda_seeds.len() { return Err(ProgramError::InvalidSeeds); }
            __dasi_pda_seeds[__dasi_i] = pinocchio::instruction::Seed::from(*__dasi_s);
        }
        let __dasi_signer = pinocchio::instruction::Signer::from(&__dasi_pda_seeds[..__dasi_seed_refs.len()]);
        pinocchio::cpi::invoke_signed(&__dasi_ix, &[${mint}], &[__dasi_signer])?;`
      : `        pinocchio::cpi::invoke(&__dasi_ix, &[${mint}])?;`;
    return `    // Token-2022 DefaultAccountState extension init — ${mint}
    {
${TOKEN_2022_PROGRAM_ID_CONST}
        let __dasi_data: [u8; 3] = [28, 0, ${stateByte}];
        let __dasi_metas = [
            pinocchio::instruction::AccountMeta::writable(${mint}.key()),
        ];
        let __dasi_ix = pinocchio::instruction::Instruction {
            program_id: &TOKEN_2022_PROGRAM_ID,
            accounts: &__dasi_metas,
            data: &__dasi_data,
        };
${invokeCall}
    }`;
  }

  override emitT22DefaultAccountStateUpdate(
    mint: string,
    _tokenProgram: string,
    freezeAuthority: string,
    state: string,
    signerSeeds?: string,
  ): string {
    // DefaultAccountStateExtension(28) → Update(1). Same payload shape
    // as Initialize plus the freeze_authority readonly_signer meta.
    const stateByte = mapAccountStateLiteralToByte(state);
    if (stateByte === null) {
      return `    // ⚠️ Anvil TODO: default_account_state_update(${mint}, authority=${freezeAuthority}, state=${state})
    //   Pinocchio path supports literal &AccountState::{Uninitialized,Initialized,Frozen};
    //   the source uses a non-literal expression. Hand-roll the u8 byte if needed.`;
    }
    const invokeCall = signerSeeds
      ? `        let __dasu_seed_refs = ${signerSeeds}[0];
        let mut __dasu_pda_seeds: [pinocchio::instruction::Seed<'_>; 8] =
            core::array::from_fn(|_| pinocchio::instruction::Seed::from(&[][..]));
        for (__dasu_i, __dasu_s) in __dasu_seed_refs.iter().enumerate() {
            if __dasu_i >= __dasu_pda_seeds.len() { return Err(ProgramError::InvalidSeeds); }
            __dasu_pda_seeds[__dasu_i] = pinocchio::instruction::Seed::from(*__dasu_s);
        }
        let __dasu_signer = pinocchio::instruction::Signer::from(&__dasu_pda_seeds[..__dasu_seed_refs.len()]);
        pinocchio::cpi::invoke_signed(&__dasu_ix, &[${mint}, ${freezeAuthority}], &[__dasu_signer])?;`
      : `        pinocchio::cpi::invoke(&__dasu_ix, &[${mint}, ${freezeAuthority}])?;`;
    return `    // Token-2022 DefaultAccountState — update default state on ${mint}
    {
${TOKEN_2022_PROGRAM_ID_CONST}
        let __dasu_data: [u8; 3] = [28, 1, ${stateByte}];
        let __dasu_metas = [
            pinocchio::instruction::AccountMeta::writable(${mint}.key()),
            pinocchio::instruction::AccountMeta::readonly_signer(${freezeAuthority}.key()),
        ];
        let __dasu_ix = pinocchio::instruction::Instruction {
            program_id: &TOKEN_2022_PROGRAM_ID,
            accounts: &__dasu_metas,
            data: &__dasu_data,
        };
${invokeCall}
    }`;
  }

  override emitT22InterestBearingMintInitialize(
    mint: string,
    _tokenProgram: string,
    rateAuthority: string,
    rate: string,
    signerSeeds?: string,
  ): string {
    // InterestBearingMintExtension(33) → Initialize(0). The wire
    // format uses OptionalNonZeroPubkey for rate_authority — a 32-byte
    // pubkey field where all-zeros means None (NOT COption's 1-byte
    // tag form). Plus i16 LE rate (2 bytes). Total: 2 disc + 32 + 2 = 36.
    const invokeCall = signerSeeds
      ? `        let __ibm_seed_refs = ${signerSeeds}[0];
        let mut __ibm_pda_seeds: [pinocchio::instruction::Seed<'_>; 8] =
            core::array::from_fn(|_| pinocchio::instruction::Seed::from(&[][..]));
        for (__ibm_i, __ibm_s) in __ibm_seed_refs.iter().enumerate() {
            if __ibm_i >= __ibm_pda_seeds.len() { return Err(ProgramError::InvalidSeeds); }
            __ibm_pda_seeds[__ibm_i] = pinocchio::instruction::Seed::from(*__ibm_s);
        }
        let __ibm_signer = pinocchio::instruction::Signer::from(&__ibm_pda_seeds[..__ibm_seed_refs.len()]);
        pinocchio::cpi::invoke_signed(&__ibm_ix, &[${mint}], &[__ibm_signer])?;`
      : `        pinocchio::cpi::invoke(&__ibm_ix, &[${mint}])?;`;
    return `    // Token-2022 InterestBearingMint extension init — ${mint}
    {
${TOKEN_2022_PROGRAM_ID_CONST}
        let mut __ibm_data = [0u8; 36];
        __ibm_data[0] = 33;
        __ibm_data[1] = 0;
        // OptionalNonZeroPubkey: zeroed = None, copy pubkey bytes when Some.
        match &${rateAuthority} {
            Some(__pk) => {
                __ibm_data[2..34].copy_from_slice(__pk.as_ref());
            }
            None => {
                // bytes 2..34 already zero-initialized
            }
        }
        let __ibm_rate: i16 = ${rate};
        __ibm_data[34..36].copy_from_slice(&__ibm_rate.to_le_bytes());
        let __ibm_metas = [
            pinocchio::instruction::AccountMeta::writable(${mint}.key()),
        ];
        let __ibm_ix = pinocchio::instruction::Instruction {
            program_id: &TOKEN_2022_PROGRAM_ID,
            accounts: &__ibm_metas,
            data: &__ibm_data,
        };
${invokeCall}
    }`;
  }

  override emitT22InterestBearingMintUpdateRate(
    mint: string,
    _tokenProgram: string,
    rateAuthority: string,
    rate: string,
    signerSeeds?: string,
  ): string {
    // InterestBearingMintExtension(33) → UpdateRate(1).
    // Payload: i16 LE rate (2 bytes). Total: 4 bytes.
    const invokeCall = signerSeeds
      ? `        let __iur_seed_refs = ${signerSeeds}[0];
        let mut __iur_pda_seeds: [pinocchio::instruction::Seed<'_>; 8] =
            core::array::from_fn(|_| pinocchio::instruction::Seed::from(&[][..]));
        for (__iur_i, __iur_s) in __iur_seed_refs.iter().enumerate() {
            if __iur_i >= __iur_pda_seeds.len() { return Err(ProgramError::InvalidSeeds); }
            __iur_pda_seeds[__iur_i] = pinocchio::instruction::Seed::from(*__iur_s);
        }
        let __iur_signer = pinocchio::instruction::Signer::from(&__iur_pda_seeds[..__iur_seed_refs.len()]);
        pinocchio::cpi::invoke_signed(&__iur_ix, &[${mint}, ${rateAuthority}], &[__iur_signer])?;`
      : `        pinocchio::cpi::invoke(&__iur_ix, &[${mint}, ${rateAuthority}])?;`;
    return `    // Token-2022 InterestBearingMint — update rate on ${mint}
    {
${TOKEN_2022_PROGRAM_ID_CONST}
        let mut __iur_data = [0u8; 4];
        __iur_data[0] = 33;
        __iur_data[1] = 1;
        let __iur_rate: i16 = ${rate};
        __iur_data[2..4].copy_from_slice(&__iur_rate.to_le_bytes());
        let __iur_metas = [
            pinocchio::instruction::AccountMeta::writable(${mint}.key()),
            pinocchio::instruction::AccountMeta::readonly_signer(${rateAuthority}.key()),
        ];
        let __iur_ix = pinocchio::instruction::Instruction {
            program_id: &TOKEN_2022_PROGRAM_ID,
            accounts: &__iur_metas,
            data: &__iur_data,
        };
${invokeCall}
    }`;
  }

  override emitT22HarvestWithheldToMint(
    mint: string,
    _tokenProgram: string,
    sourcesExpr: string,
    signerSeeds?: string,
  ): string {
    // TransferFeeExtension(26) → HarvestWithheldTokensToMint(4).
    // No payload (just 2-byte discriminator). Account metas are
    // [mint writable] + [each source writable].
    //
    // pinocchio::cpi::invoke is generic over `const ACCOUNTS: usize`,
    // so the account_infos array length must be known at compile time.
    // harvest takes a runtime-length sources list — we dispatch
    // through a match-on-N branch table for N=1..16. 16 = upper bound
    // observed in transfer-fee programs in practice; fail-soft on
    // overflow (a real harvest of 16+ accounts can split across
    // multiple instructions).
    const branches: string[] = [];
    for (let n = 1; n <= 16; n++) {
      const slots = Array.from({ length: n }, (_, i) => `__hwtm_srcs[${i}]`).join(", ");
      const invokeFn = signerSeeds ? "invoke_signed" : "invoke";
      const signerArg = signerSeeds ? `, &[__hwtm_signer]` : "";
      branches.push(
        `            ${n} => pinocchio::cpi::${invokeFn}(&__hwtm_ix, &[${mint}, ${slots}]${signerArg})?,`,
      );
    }
    const signerSetup = signerSeeds
      ? `        let __hwtm_seed_refs = ${signerSeeds}[0];
        let mut __hwtm_pda_seeds: [pinocchio::instruction::Seed<'_>; 8] =
            core::array::from_fn(|_| pinocchio::instruction::Seed::from(&[][..]));
        for (__hwtm_i, __hwtm_s) in __hwtm_seed_refs.iter().enumerate() {
            if __hwtm_i >= __hwtm_pda_seeds.len() { return Err(ProgramError::InvalidSeeds); }
            __hwtm_pda_seeds[__hwtm_i] = pinocchio::instruction::Seed::from(*__hwtm_s);
        }
        let __hwtm_signer = pinocchio::instruction::Signer::from(&__hwtm_pda_seeds[..__hwtm_seed_refs.len()]);
`
      : "";
    return `    // Token-2022 TransferFee — harvest_withheld_tokens_to_mint
    {
${TOKEN_2022_PROGRAM_ID_CONST}
        const __HWTM_MAX: usize = 16;
        // sources may be Vec<&AccountInfo>, &[&AccountInfo], or
        // similar. Coerce to a slice via &<expr>[..] which works for
        // all common shapes (Vec, slice, array).
        let __hwtm_srcs: &[&AccountInfo] = &(${sourcesExpr})[..];
        if __hwtm_srcs.len() == 0 || __hwtm_srcs.len() > __HWTM_MAX {
            return Err(ProgramError::InvalidInstructionData);
        }
        // Build mint+sources meta list (slice — Instruction.accounts
        // accepts a slice, only invoke's account_infos array needs
        // const-N).
        let __hwtm_data = [26u8, 4u8];
        let mut __hwtm_metas: [pinocchio::instruction::AccountMeta<'_>; __HWTM_MAX + 1] =
            core::array::from_fn(|_| pinocchio::instruction::AccountMeta::writable(${mint}.key()));
        for (__hwtm_i, __hwtm_src) in __hwtm_srcs.iter().enumerate() {
            __hwtm_metas[__hwtm_i + 1] = pinocchio::instruction::AccountMeta::writable(__hwtm_src.key());
        }
        let __hwtm_meta_len = 1 + __hwtm_srcs.len();
        let __hwtm_ix = pinocchio::instruction::Instruction {
            program_id: &TOKEN_2022_PROGRAM_ID,
            accounts: &__hwtm_metas[..__hwtm_meta_len],
            data: &__hwtm_data,
        };
${signerSetup}        match __hwtm_srcs.len() {
${branches.join("\n")}
            _ => return Err(ProgramError::InvalidInstructionData),
        }
    }`;
  }

  override emitT22ImmutableOwnerInitialize(
    tokenAccount: string,
    _tokenProgram: string,
    signerSeeds?: string,
  ): string {
    // Token-2022 InitializeImmutableOwner: discriminator 22, no
    // payload, accounts = [token_account writable]. Same shape as
    // NonTransferable but applied to a token account instead of mint.
    const invokeCall = signerSeeds
      ? `        let __io_seed_refs = ${signerSeeds}[0];
        let mut __io_pda_seeds: [pinocchio::instruction::Seed<'_>; 8] =
            core::array::from_fn(|_| pinocchio::instruction::Seed::from(&[][..]));
        for (__io_i, __io_s) in __io_seed_refs.iter().enumerate() {
            if __io_i >= __io_pda_seeds.len() { return Err(ProgramError::InvalidSeeds); }
            __io_pda_seeds[__io_i] = pinocchio::instruction::Seed::from(*__io_s);
        }
        let __io_signer = pinocchio::instruction::Signer::from(&__io_pda_seeds[..__io_seed_refs.len()]);
        pinocchio::cpi::invoke_signed(&__io_ix, &[${tokenAccount}], &[__io_signer])?;`
      : `        pinocchio::cpi::invoke(&__io_ix, &[${tokenAccount}])?;`;
    return `    // Token-2022 ImmutableOwner extension init — ${tokenAccount}
    {
${TOKEN_2022_PROGRAM_ID_CONST}
        let __io_data = [22u8];
        let __io_metas = [
            pinocchio::instruction::AccountMeta::writable(${tokenAccount}.key()),
        ];
        let __io_ix = pinocchio::instruction::Instruction {
            program_id: &TOKEN_2022_PROGRAM_ID,
            accounts: &__io_metas,
            data: &__io_data,
        };
${invokeCall}
    }`;
  }

  override emitT22NonTransferableMintInitialize(
    mint: string,
    _tokenProgram: string,
    signerSeeds?: string,
  ): string {
    // Token-2022 InitializeNonTransferableMint: discriminator 32, no
    // payload (single-byte instruction data), accounts = [writable mint].
    // pinocchio_token has no helper for T22 extension instructions, so
    // hand-roll the raw CPI against the const TOKEN_2022_PROGRAM_ID.
    const invokeCall = signerSeeds
      ? `        let __nt_seed_refs = ${signerSeeds}[0];
        let mut __nt_pda_seeds: [pinocchio::instruction::Seed<'_>; 8] =
            core::array::from_fn(|_| pinocchio::instruction::Seed::from(&[][..]));
        for (__nt_i, __nt_s) in __nt_seed_refs.iter().enumerate() {
            if __nt_i >= __nt_pda_seeds.len() { return Err(ProgramError::InvalidSeeds); }
            __nt_pda_seeds[__nt_i] = pinocchio::instruction::Seed::from(*__nt_s);
        }
        let __nt_signer = pinocchio::instruction::Signer::from(&__nt_pda_seeds[..__nt_seed_refs.len()]);
        pinocchio::cpi::invoke_signed(&__nt_ix, &[${mint}], &[__nt_signer])?;`
      : `        pinocchio::cpi::invoke(&__nt_ix, &[${mint}])?;`;
    return `    // Token-2022 NonTransferable extension init — ${mint}
    {
${TOKEN_2022_PROGRAM_ID_CONST}
        let __nt_data = [32u8];
        let __nt_metas = [
            pinocchio::instruction::AccountMeta::writable(${mint}.key()),
        ];
        let __nt_ix = pinocchio::instruction::Instruction {
            program_id: &TOKEN_2022_PROGRAM_ID,
            accounts: &__nt_metas,
            data: &__nt_data,
        };
${invokeCall}
    }`;
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
        const ATA_PROGRAM_ID: pinocchio::pubkey::Pubkey = [140, 151, 37, 143, 78, 36, 137, 241, 187, 61, 16, 41, 20, 142, 13, 131, 11, 90, 19, 153, 218, 255, 16, 132, 4, 142, 123, 216, 219, 233, 248, 89];
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

  override emitCreateTokenAccount(
    account: string, payer: string, mint: string, authority: string, signerSeeds?: string,
  ): string {
    // Anchor's `init token::*` lowers to system::create_account (165 bytes,
    // owner=token_program) + Token::initialize_account3 (binds mint +
    // authority). When signerSeeds is provided (PDA-derived account, e.g.
    // vesting/staking vaults), the create_account is invoke_signed with
    // the PDA seeds. Otherwise the account-as-signer signs the wrapping
    // tx. The init CPI never takes a signer.
    //
    // Hand-rolled against the SPL Token program ID
    // (TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA) — pinocchio 0.9 +
    // pinocchio_token 0.4 use different `&AccountView` vs `&AccountInfo`
    // types so the wrapped instructions don't compose.
    const createInvoke = signerSeeds
      ? `// PDA-signed create — build a Signer<Seed> from the threaded seeds.
        let __ta_seed_group = ${signerSeeds}.first().ok_or(pinocchio::program_error::ProgramError::InvalidSeeds)?;
        let mut __ta_seeds: [pinocchio::instruction::Seed<'_>; 8] = core::array::from_fn(|_| pinocchio::instruction::Seed::from(&[][..]));
        for (i, s) in __ta_seed_group.iter().enumerate() {
            if i >= __ta_seeds.len() { return Err(pinocchio::program_error::ProgramError::InvalidSeeds); }
            __ta_seeds[i] = pinocchio::instruction::Seed::from(*s);
        }
        let __ta_signer = pinocchio::instruction::Signer::from(&__ta_seeds[..__ta_seed_group.len()]);
        pinocchio_system::instructions::CreateAccount {
            from: ${payer},
            to: ${account},
            lamports: __ta_rent,
            space: 165u64,
            owner: &TOKEN_PROGRAM_ID,
        }.invoke_signed(&[__ta_signer])?;`
      : `pinocchio_system::instructions::CreateAccount {
            from: ${payer},
            to: ${account},
            lamports: __ta_rent,
            space: 165u64,
            owner: &TOKEN_PROGRAM_ID,
        }.invoke()?;`;
    return `    // Init token account: ${account}
    {
        const TOKEN_PROGRAM_ID: pinocchio::pubkey::Pubkey = [6, 221, 246, 225, 215, 101, 161, 147, 217, 203, 225, 70, 206, 235, 121, 172, 28, 180, 133, 237, 95, 91, 55, 145, 58, 140, 245, 133, 126, 255, 0, 169];
        // 1. Allocate + assign to token program (rent-exempt for 165 bytes).
        let __ta_rent = pinocchio::sysvars::rent::Rent::get()?.minimum_balance(165);
        ${createInvoke}
        // 2. InitializeAccount3 — discriminator 18, data: 32-byte authority.
        let mut __ta_init_data = [0u8; 33];
        __ta_init_data[0] = 18;
        __ta_init_data[1..33].copy_from_slice(${authority}.key().as_ref());
        let __ta_init_metas = [
            pinocchio::instruction::AccountMeta::new(${account}.key(), true, false),
            pinocchio::instruction::AccountMeta::new(${mint}.key(), false, false),
        ];
        let __ta_init_ix = pinocchio::instruction::Instruction {
            program_id: &TOKEN_PROGRAM_ID,
            accounts: &__ta_init_metas,
            data: &__ta_init_data,
        };
        pinocchio::cpi::invoke(&__ta_init_ix, &[${account}, ${mint}])?;
    }`;
  }

  override emitCreateMint(
    account: string, payer: string, decimals: string, mintAuthority: string, freezeAuthority: string | null, signerSeeds?: string,
  ): string {
    // SPL Token InitializeMint2 (discriminator 20):
    //   1 byte disc + 1 byte decimals + 32 bytes mint_authority +
    //   1 byte COption tag + (32 bytes freeze_authority if Some)
    // Total length: 35 bytes (None) or 67 bytes (Some).
    const createInvoke = signerSeeds
      ? `let __mint_seed_group = ${signerSeeds}.first().ok_or(pinocchio::program_error::ProgramError::InvalidSeeds)?;
        let mut __mint_seeds: [pinocchio::instruction::Seed<'_>; 8] = core::array::from_fn(|_| pinocchio::instruction::Seed::from(&[][..]));
        for (i, s) in __mint_seed_group.iter().enumerate() {
            if i >= __mint_seeds.len() { return Err(pinocchio::program_error::ProgramError::InvalidSeeds); }
            __mint_seeds[i] = pinocchio::instruction::Seed::from(*s);
        }
        let __mint_signer = pinocchio::instruction::Signer::from(&__mint_seeds[..__mint_seed_group.len()]);
        pinocchio_system::instructions::CreateAccount {
            from: ${payer},
            to: ${account},
            lamports: __mint_rent,
            space: 82u64,
            owner: &TOKEN_PROGRAM_ID,
        }.invoke_signed(&[__mint_signer])?;`
      : `pinocchio_system::instructions::CreateAccount {
            from: ${payer},
            to: ${account},
            lamports: __mint_rent,
            space: 82u64,
            owner: &TOKEN_PROGRAM_ID,
        }.invoke()?;`;
    const freezeBlock = freezeAuthority
      ? `__mint_init_data[34] = 1;
        __mint_init_data[35..67].copy_from_slice(${freezeAuthority}.key().as_ref());
        let __mint_init_data_len: usize = 67;`
      : `__mint_init_data[34] = 0;
        let __mint_init_data_len: usize = 35;`;
    return `    // Init mint: ${account}
    {
        const TOKEN_PROGRAM_ID: pinocchio::pubkey::Pubkey = [6, 221, 246, 225, 215, 101, 161, 147, 217, 203, 225, 70, 206, 235, 121, 172, 28, 180, 133, 237, 95, 91, 55, 145, 58, 140, 245, 133, 126, 255, 0, 169];
        // 1. Allocate + assign to token program (rent-exempt for 82 bytes).
        let __mint_rent = pinocchio::sysvars::rent::Rent::get()?.minimum_balance(82);
        ${createInvoke}
        // 2. InitializeMint2 — discriminator 20, decimals + authority + COption<freeze>.
        let mut __mint_init_data = [0u8; 67];
        __mint_init_data[0] = 20;
        __mint_init_data[1] = (${decimals}) as u8;
        __mint_init_data[2..34].copy_from_slice(${mintAuthority}.key().as_ref());
        ${freezeBlock}
        let __mint_init_metas = [
            pinocchio::instruction::AccountMeta::new(${account}.key(), true, false),
        ];
        let __mint_init_ix = pinocchio::instruction::Instruction {
            program_id: &TOKEN_PROGRAM_ID,
            accounts: &__mint_init_metas,
            data: &__mint_init_data[..__mint_init_data_len],
        };
        pinocchio::cpi::invoke(&__mint_init_ix, &[${account}])?;
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
        const MEMO_PROGRAM_ID: pinocchio::pubkey::Pubkey = [5, 74, 83, 90, 153, 41, 33, 6, 77, 36, 232, 113, 96, 218, 56, 124, 124, 53, 181, 221, 188, 146, 187, 129, 228, 31, 168, 64, 65, 5, 68, 141];
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
        // Anchor non-state accounts (Signer, Account<Mint>, AccountInfo, …)
        // are bound by their bare name in the generated handler — `let maker
        // = &accounts[N];` — never `<name>_account`. Only state-typed
        // accounts (entries that match a generated state account in
        // currentIr.accounts) get the `_account` raw-info pseudo-var while
        // the typed struct lives under the bare name. Falling through to
        // `<name>_account` for non-state accounts produces an
        // unresolved-identifier error during cargo check.
        const isStateAccount = this.currentIr?.accounts.some(
          (acc) => snakeCase(acc.name) === snakeCase(name),
        );
        if (!isStateAccount) {
          return `${name}.key().as_ref()`;
        }
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

    const seedsStr = transformedSeeds.join(",\n        ");
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
    // Anchor's `emit!(Event { … })` emits an 8-byte event discriminator +
    // borsh-encoded payload via sol_log_data. Anvil now mirrors the same
    // shape: build the event struct (defined in events.rs with
    // BorshSerialize derive), serialize via borsh::to_vec, then call
    // sol_log_data with [&discriminator, &payload]. Off-chain indexers
    // see byte-identical Program data: lines vs Anchor's expansion.
    if (!fields.trim()) {
      return `    pinocchio::log::sol_log_data(&[&${event}::DISCRIMINATOR]);`;
    }
    // Concatenate discriminator + borsh payload into ONE slice. Anchor's
    // macro emits sol_log_data(&[&combined]) where combined is the
    // disc-prefixed payload — the runtime base64-encodes the slice
    // verbatim, surfacing as a SINGLE base64 string in the
    // 'Program data: <b64>' log line. Emitting &[&disc, &payload]
    // renders as TWO space-separated base64 strings, which differs at
    // the log-line level even though byte content matches. Concatenate
    // to byte-equal Anchor's format.
    return `    {
        let __evt = ${event} { ${fields} };
        let __evt_bytes = ::borsh::to_vec(&__evt).map_err(|_| ProgramError::InvalidAccountData)?;
        let mut __evt_payload = ${event}::DISCRIMINATOR.to_vec();
        __evt_payload.extend_from_slice(&__evt_bytes);
        pinocchio::log::sol_log_data(&[&__evt_payload]);
    }`;
  }

  override emitClockGet(localVar: string, field?: string): string {
    // Pinocchio's Clock struct exposes unix_timestamp / slot / epoch /
    // leader_schedule_epoch as i64 / u64 fields (same shape as Anchor).
    // When the source chained `.unix_timestamp` etc., preserve it so
    // downstream arithmetic sees the primitive value, not the struct.
    return `    let ${localVar} = ${this.emitClockGetExpr(field)};`;
  }

  override emitRentGet(localVar: string, field?: string): string {
    return `    let ${localVar} = ${this.emitRentGetExpr(field)};`;
  }

  override emitClockGetExpr(field?: string): string {
    const tail = field ? `.${field}` : "";
    return `pinocchio::sysvars::clock::Clock::get()?${tail}`;
  }

  override emitClockGetExprNoTry(field?: string): string {
    const tail = field ? `.${field}` : "";
    return `pinocchio::sysvars::clock::Clock::get()${tail}`;
  }

  override emitRentGetExpr(field?: string): string {
    const tail = field ? `.${field}` : "";
    return `pinocchio::sysvars::rent::Rent::get()?${tail}`;
  }

  override emitRentGetExprNoTry(field?: string): string {
    const tail = field ? `.${field}` : "";
    return `pinocchio::sysvars::rent::Rent::get()${tail}`;
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

    if (acc.isZeroCopy) {
      const bodyLen = acc.fields.reduce(
        (s, f) => s + this.resolveTypeSize(f.type, f.maxLen),
        0,
      );
      // Same scaffolding as the Native zero-copy struct (see comment on
      // emitZeroCopyAccountStruct in native-emitter.ts). Pinocchio's
      // Pubkey is `[u8; 32]` (a type alias) so the manual unsafe Pod /
      // Zeroable impl is straightforward.
      //
      // #25 — accessor methods. For every field with `#[accessor(T)]`,
      // emit `get_X(&self) -> T` and `set_X(&mut self, &T)`. In Pinocchio
      // where Pubkey is [u8; 32], the bridge is a direct copy. For other
      // accessor types this path may need bespoke conversion; today only
      // Pubkey is observed in the wild (anchor/tests/zero-copy).
      const accessorMethods = acc.fields
        .filter((f) => f.accessorType)
        .map((f) => {
          const name = snakeCase(f.name);
          const t = f.accessorType!;
          if (t === "Pubkey") {
            // Pinocchio's Pubkey is `[u8; 32]` (Copy). Accept by value so
            // call sites like `foo.set_X(authority.key)` (which Pinocchio
            // transforms to `*authority.key()` returning a Pubkey value)
            // work without the caller needing an extra `&`.
            return [
              `    pub fn get_${name}(&self) -> ${t} { self.${name} }`,
              `    pub fn set_${name}(&mut self, value: ${t}) { self.${name} = value; }`,
            ].join("\n");
          }
          // Unknown accessor type — emit a TODO so the user sees the gap.
          return `    // ⚠️ Anvil TODO: accessor(${t}) on field ${name} — only Pubkey is supported today; hand-port the get/set methods.`;
        })
        .join("\n");
      const accessorBlock = accessorMethods ? `\n${accessorMethods}` : "";
      return `#[repr(C)]
#[derive(Copy, Clone)]
pub struct ${acc.name} {
${fields}
}

unsafe impl bytemuck::Zeroable for ${acc.name} {}
unsafe impl bytemuck::Pod for ${acc.name} {}

impl ${acc.name} {
    pub const DISCRIMINATOR: [u8; 8] = ${accountDiscriminator(acc.name)};
    pub const LEN: usize = ${bodyLen};
    pub const INIT_SPACE: usize = ${bodyLen};
    pub const TOTAL_LEN: usize = 8 + Self::LEN;
    pub const SPACE: usize = Self::TOTAL_LEN;
    pub const SIZE: usize = Self::TOTAL_LEN;${accessorBlock}
}${this.emitInherentImplItems(acc)}`;
    }

    const bodyLen = acc.fields.reduce((s, f) => s + this.resolveTypeSize(f.type, f.maxLen), 0);
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
}${this.emitInherentImplItems(acc)}`;
  }

  /**
   * Pinocchio post-process: target-specific rewrites that the shared body
   * walker can't do because it doesn't know the target framework.
   *
   * 1. `**X.try_borrow_mut_lamports()?` — native's AccountInfo returns
   *    `RefMut<&mut u64>` (two layers of indirection); pinocchio returns
   *    `RefMut<u64>` (one). Double-deref is correct on native but causes
   *    E0614 "type u64 cannot be dereferenced" on pinocchio. Drop one `*`.
   * 2. `borsh::to_vec(&X)?` — pinocchio's `ProgramError` has no
   *    `From<borsh::io::Error>` impl, so the bare `?` fails with E0277.
   *    Add `.map_err(...)` so the conversion is explicit.
   * 3. The walker emits `invoke(&system_instruction::create_account(&from.key,
   *    &to.key, lamports, space, program_id), &[from.clone(), to.clone()])?;`
   *    which uses solana_program types not in scope on pinocchio. Translate
   *    to `pinocchio_system::instructions::CreateAccount { ... }.invoke()?;`.
   *    Same for invoke_signed → CreateAccount{...}.invoke_signed_with_bump(...)
   *    is awkward; simpler: emit `Signer::from(seeds)` wrapper. The walker's
   *    output is the canonical form; we rewrite it here.
   */
  private postProcessPinocchioRewrites(body: string): string {
    let out = body;
    // Pinocchio's Pubkey is a `[u8; 32]` type alias, not a struct, so it
    // has no associated methods. Source-level `Pubkey::find_program_address(
    // seeds, program_id)` and `Pubkey::create_program_address(...)` need
    // to route to the standalone fns at `pinocchio::pubkey::*`. Match
    // both bare `Pubkey::` and `solana_program::pubkey::Pubkey::`
    // qualified shapes. coral-escrow / pinocchio pattern.
    out = out.replace(
      /(?:solana_program\s*::\s*pubkey\s*::\s*)?Pubkey\s*::\s*(find_program_address|create_program_address)\b/g,
      "pinocchio::pubkey::$1",
    );
    // set_return_data: pinocchio exposes pinocchio::program::set_return_data
    // with a compatible signature. Rewrite both bare `set_return_data(`
    // (when the source had `use anchor_lang::solana_program::program::
    // set_return_data;`) and `solana_program::program::set_return_data(`
    // qualified call sites. get_return_data follows the same pattern.
    // The use-import filter already drops the upstream import on
    // pinocchio; this rewrite gives the call-site the local pinocchio
    // path so the body compiles.
    out = out.replace(
      /(?:anchor_lang\s*::\s*)?solana_program\s*::\s*program\s*::\s*(set_return_data|get_return_data)\b/g,
      "pinocchio::program::$1",
    );
    // Comment out `solana_program::program::invoke{,_signed}` direct calls
    // and the typed `let X: Instruction` setup that feeds them. pinocchio
    // exposes neither solana_program::Instruction nor solana_program's CPI
    // entry point; rewriting the shape is structurally infeasible (different
    // account/seed types). The surrounding `ix.accounts = …` mutation reads
    // a now-removed binding, so we excise the whole block as TODO. Same
    // strategy as the unsalvageable-helper commentout — keeps the file
    // compile-clean while flagging the manual-port site.
    out = commentOutSolanaProgramInvoke(out);
    // Comment out call sites of Token-2022 extension types that pinocchio
    // can't satisfy. Pinocchio's Cargo.toml does not include `spl_token_2022`
    // (and the crate isn't no_std-compatible), so any source that walks the
    // TLV-encoded extension data via `StateWithExtensions::<MintState>::unpack`
    // / `.get_extension::<TransferFeeConfig>()` / `transfer_fee_set(...)` /
    // `transfer_checked_with_fee(...)` etc. cannot link. Excise those statements
    // (with the same TODO banner as the unsalvageable-helper commentout) so
    // the file stays compile-clean and flags the manual port site. Native
    // emit auto-imports the spl_token_2022 ext types — this is pinocchio-only.
    out = commentOutT22ExtensionCallSites(out);
    out = out.replace(
      /\*\*(\w+)\.try_borrow_mut_lamports\(\)\?/g,
      "*$1.try_borrow_mut_lamports()?",
    );
    out = out.replace(
      /borsh::to_vec\(([^)]+)\)\?/g,
      "borsh::to_vec($1).map_err(|_| ProgramError::InvalidInstructionData)?",
    );
    // System instruction create_account → pinocchio_system::instructions::CreateAccount
    // The walker emits a multiline `invoke(&system_instruction::create_account(
    //     &*from.key(), &*to.key(), lamports, space, <owner>), ...)?;`
    // where <owner> is either `program_id` (when the source owner is
    // literally `program_id`) or `&IDENT.key` (when the source passed an
    // account-info reference like `&ctx.accounts.system_program.key()`).
    // The regex captures owner as `program_id|&\w+.key` so the rewrite
    // preserves the user's intent in the resulting CreateAccount struct
    // — see resolveCreateAccountOwner in walker.ts and the pda-rent-payer
    // byte-equal fixture for the bug this fixes.
    const KEY_RE = "&(?:\\*)?(\\w+)\\.key(?:\\(\\))?";
    // Owner shape: literal `program_id` OR `&[*]IDENT.key[()]`. The latter
    // covers post-normalization output where `&IDENT.key` was rewritten
    // to `&*IDENT.key()` by the walker's per-target key collapse.
    const OWNER_RE = "(program_id|&\\*?\\w+\\.key(?:\\(\\))?)";
    const CREATE_ACCT_BODY = `&system_instruction::create_account\\(\\s*${KEY_RE},\\s*${KEY_RE},\\s*([\\s\\S]+?),\\s*([\\s\\S]+?),\\s*${OWNER_RE},?\\s*\\)`;
    // Unsigned form
    out = out.replace(
      new RegExp(`invoke\\(\\s*${CREATE_ACCT_BODY},\\s*&\\[[^\\]]*\\],?\\s*\\)\\?;`, "g"),
      (_full, from, to, lamports, space, owner) =>
        `pinocchio_system::instructions::CreateAccount { from: ${from}, to: ${to}, lamports: ${lamports.trim()}, space: (${space.trim()}) as u64, owner: ${owner.trim()} }.invoke()?;`,
    );
    // Signed form: invoke_signed(...) with trailing `seeds_var,` after the accounts array.
    // Anchor's `signer_seeds: &[&[&[u8]]]` form needs conversion to pinocchio's
    // `&[Signer]` (where Signer wraps `&[Seed]`). pinocchio is no_std so we
    // can't allocate a Vec; use the same const-size [Seed; 8] stack pattern
    // as the helper functions (transfer_lamports_signed, create_program_account)
    // — fixed-cap fill with default `Seed::from(&[][..])` placeholders, then
    // build Signer from `&seeds[..actual_len]`. Caps at 8 seeds; programs
    // using more return InvalidSeeds at runtime (no Anchor program in the
    // wild uses >8 seeds; SPL ATA's 4-seed seeds list is the densest case).
    out = out.replace(
      new RegExp(`invoke_signed\\(\\s*${CREATE_ACCT_BODY},\\s*&\\[[^\\]]*\\],\\s*(\\w+),?\\s*\\)\\?;`, "g"),
      (_full, from, to, lamports, space, owner, seedsVar) =>
        `// PDA-signed create_account via pinocchio_system\n    {\n        let __seed_refs = ${seedsVar}[0];\n        let mut __pda_seeds: [pinocchio::instruction::Seed<'_>; 8] = core::array::from_fn(|_| pinocchio::instruction::Seed::from(&[][..]));\n        for (__i, __s) in __seed_refs.iter().enumerate() {\n            if __i >= __pda_seeds.len() { return Err(ProgramError::InvalidSeeds); }\n            __pda_seeds[__i] = pinocchio::instruction::Seed::from(*__s);\n        }\n        let __signer = pinocchio::instruction::Signer::from(&__pda_seeds[..__seed_refs.len()]);\n        pinocchio_system::instructions::CreateAccount { from: ${from}, to: ${to}, lamports: ${lamports.trim()}, space: (${space.trim()}) as u64, owner: ${owner.trim()} }.invoke_signed(&[__signer])?;\n    }`,
    );
    return out;
  }

  /** See native-emitter.ts:emitInherentImplItems for rationale. */
  private emitInherentImplItems(acc: AccountDef): string {
    if (!acc.implItems || acc.implItems.length === 0) return "";
    const filtered = acc.implItems
      .filter((raw) => !STANDARD_IMPL_NAME_RE.test(raw))
      .map((raw) =>
        promoteImplFnVisibility(
          rewriteGetInstancePackedLen(rewriteAnchorResultAlias(rewriteTryIntoUnwrap(stubAnchorOnlyImplItem(raw)))),
        ),
      );
    if (filtered.length === 0) return "";
    return `\n\nimpl ${acc.name} {\n${filtered.map((s) => `    ${s}`).join("\n\n")}\n}`;
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

    // Re-export variants at the module level so instruction files can
    // reference them by bare name (Anchor's convention: `Err(Unauthorized
    // .into())` works because `#[error_code]` macro auto-imports). Without
    // the `pub use`, every instruction would need an explicit
    // `use crate::errors::${enumName}::*;` and our emitter can't easily
    // know which variants each handler references at file-emit time.
    return `#[derive(Clone, Copy, Debug, PartialEq)]
#[repr(u32)]
pub enum ${enumName} {
${variants}
}

pub use ${enumName}::*;

impl From<${enumName}> for ProgramError {
    fn from(error: ${enumName}) -> Self {
        ProgramError::Custom(error as u32)
    }
}`;
  }

  override emitHelperFunctions(ir: SolanaIR): string {
    const helpers: string[] = [];

    // M7 8c — emit the int/Pubkey → ASCII helpers when any instruction
    // body uses a formatted msg!() (e.g. `msg!("X: {}", arg)`). The
    // helpers are pulled verbatim from m7-helpers.ts so the Rust source
    // string is the single source of truth across emitter, helper
    // module, and TS algorithm-mirror tests.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { irUsesFormattedMsg } = require("./m7-format-msg.js") as typeof import("./m7-format-msg.js");
    if (irUsesFormattedMsg(ir)) {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { RUST_U64_TO_ASCII, RUST_PUBKEY_TO_BASE58 } = require("./m7-helpers.js") as typeof import("./m7-helpers.js");
      helpers.push(RUST_U64_TO_ASCII);
      helpers.push(RUST_PUBKEY_TO_BASE58);
    }

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

    // #45 — Metaplex Token Metadata: create_metadata_accounts_v3 hand-rolled
    // helper. Pinocchio has no mpl-token-metadata crate (mpl uses
    // solana_program::Pubkey, not pinocchio's [u8;32]). Layout verified
    // against mpl-token-metadata 5.1.1 source: discriminator = 33, args =
    // borsh(DataV2 { name, symbol, uri, seller_fee_basis_points, creators?,
    // collection?, uses? }, is_mutable, collection_details?). Helper assumes
    // creators/collection/uses/collection_details all None — the four
    // fixtures that drive this (nft-minter, pda-mint-authority, create-token,
    // spl-token-minter) all pass None for these. Extend signature if a real
    // user fixture surfaces with non-None values.
    if (irNeedsMplCreateMetadataV3Helper(ir)) {
      helpers.push(`/// Metaplex Token Metadata: create_metadata_accounts_v3 (discriminator 33).
/// Hand-rolled invoke — mpl-token-metadata is not no_std + alloc compatible
/// for Pinocchio. Args limited to common Anchor-side shape: creators /
/// collection / uses / collection_details are all None.
pub fn mpl_create_metadata_accounts_v3(
    metadata: &AccountInfo,
    mint: &AccountInfo,
    mint_authority: &AccountInfo,
    payer: &AccountInfo,
    update_authority: &AccountInfo,
    system_program: &AccountInfo,
    rent: &AccountInfo,
    token_metadata_program: &AccountInfo,
    name: &str,
    symbol: &str,
    uri: &str,
    seller_fee_basis_points: u16,
    is_mutable: bool,
    update_authority_is_signer: bool,
    signer_seeds: Option<&[&[&[u8]]]>,
) -> ProgramResult {
    let mut data: Vec<u8> =
        Vec::with_capacity(64 + name.len() + symbol.len() + uri.len());
    // CreateMetadataAccountV3 discriminator
    data.push(33);
    // DataV2.name: borsh String = u32 LE len + bytes
    data.extend_from_slice(&(name.len() as u32).to_le_bytes());
    data.extend_from_slice(name.as_bytes());
    // DataV2.symbol
    data.extend_from_slice(&(symbol.len() as u32).to_le_bytes());
    data.extend_from_slice(symbol.as_bytes());
    // DataV2.uri
    data.extend_from_slice(&(uri.len() as u32).to_le_bytes());
    data.extend_from_slice(uri.as_bytes());
    // DataV2.seller_fee_basis_points: u16 LE
    data.extend_from_slice(&seller_fee_basis_points.to_le_bytes());
    // DataV2.creators: Option<Vec<Creator>> = None
    data.push(0);
    // DataV2.collection: Option<Collection> = None
    data.push(0);
    // DataV2.uses: Option<Uses> = None
    data.push(0);
    // is_mutable: bool
    data.push(if is_mutable { 1 } else { 0 });
    // collection_details: Option<CollectionDetails> = None
    data.push(0);
    let metas = [
        pinocchio::instruction::AccountMeta::new(metadata.key(), true, false),
        pinocchio::instruction::AccountMeta::new(mint.key(), false, false),
        pinocchio::instruction::AccountMeta::new(mint_authority.key(), false, true),
        pinocchio::instruction::AccountMeta::new(payer.key(), true, true),
        pinocchio::instruction::AccountMeta::new(update_authority.key(), false, update_authority_is_signer),
        pinocchio::instruction::AccountMeta::new(system_program.key(), false, false),
        pinocchio::instruction::AccountMeta::new(rent.key(), false, false),
    ];
    let ix = pinocchio::instruction::Instruction {
        program_id: token_metadata_program.key(),
        accounts: &metas,
        data: &data,
    };
    let infos = [metadata, mint, mint_authority, payer, update_authority, system_program, rent];
    match signer_seeds {
        Some(seeds) => {
            let seed_group = seeds.first().ok_or(ProgramError::InvalidSeeds)?;
            let mut sd: [Seed<'_>; 8] = core::array::from_fn(|_| Seed::from(&[][..]));
            for (i, s) in seed_group.iter().enumerate() {
                if i >= sd.len() { return Err(ProgramError::InvalidSeeds); }
                sd[i] = Seed::from(*s);
            }
            let signer = Signer::from(&sd[..seed_group.len()]);
            pinocchio::cpi::invoke_signed(&ix, &infos, &[signer])
        }
        None => pinocchio::cpi::invoke(&ix, &infos),
    }
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

/**
 * Walk an emitted instruction body and comment out:
 *
 *   (a) `solana_program::program::invoke{,_signed}(...)?;` direct calls
 *   (b) `let [mut] X[: Instruction] = …;` declarations whose RHS or type
 *       references types pinocchio doesn't expose (`Instruction`, `AccountMeta`)
 *   (c) Subsequent `X.field = …` mutations on now-commented identifiers
 *
 * Comments are added with the same `// ⚠️ Anvil TODO: …` banner as the
 * unsalvageable-helper commentout pass. Statement boundaries: previous `;`
 * (or block-open `{`) to terminating `;` at depth 0.
 *
 * Why these together: commenting the invoke alone leaves a dangling `let
 * mut ix: Instruction = …;` that still refers to a missing type. The setup
 * lines exist solely to feed the now-dead invoke, so the entire chain is
 * excised together. The alternative — synthesizing a pinocchio-shaped
 * Instruction from a solana_program one — needs runtime type conversion
 * that pinocchio's no_std / unalloc constraints make non-trivial.
 */
/**
 * Comment out Token-2022 extension call sites that pinocchio can't satisfy.
 *
 * Pinocchio's Cargo.toml does not include `spl_token_2022` as a dep, and the
 * crate isn't no_std-compatible anyway. So any source that exercises the
 * Token-2022 extension surface — `StateWithExtensions::<MintState>::unpack`,
 * `.get_extension::<TransferFeeConfig>()`, `transfer_fee_set(...)`,
 * `transfer_checked_with_fee(...)`, etc. — cannot link on pinocchio.
 *
 * We comment out those statements (and their downstream readers via a
 * transitive closure on commented `let X = …;` LHS identifiers) with the
 * same `// ⚠️ Anvil TODO: …` banner as the solana_program-invoke commentout
 * pass. Native emit handles these via auto-imports (commit 5c9a097); this
 * function runs on pinocchio only.
 *
 * Why a different statement-bound walker than `expandStatementBounds`:
 * the matched ident often appears INSIDE a `assert_eq!(…)` macro arg, so the
 * existing depth-tracking back-walker would hit the `(` of `assert_eq!` at
 * depth 0 and bail mid-statement. We pre-compute all top-level statement
 * spans in one pass and look up the enclosing span for each match.
 */
export const __testOnlyCommentOutT22ExtensionCallSites = (body: string) =>
  commentOutT22ExtensionCallSites(body);

function commentOutT22ExtensionCallSites(body: string): string {
  // Direct-blacklist patterns. Each must be a complete word so we don't accidentally
  // strip names that contain these as substrings. `StateWithExtensions` covers both
  // bare and `BaseStateWithExtensions::*` (substring overlap is OK — same fix shape).
  // `\bMint::unpack\b` is NOT here — pinocchio_token's Mint::unpack body-scan prelude
  // (commit #52) emits valid pinocchio code; we only kill the T22-specific extension
  // unpack form which always co-occurs with `StateWithExtensions`.
  const TYPE_BLACKLIST = [
    "TransferFeeConfig",
    "TransferFeeAmount",
    "MintCloseAuthority",
    "PermanentDelegate",
    "StateWithExtensions",
    "BaseStateWithExtensions",
    "ExtensionType",
    "PodMint",
    "MintState",
    "OptionalNonZeroPubkey",
    "TransferHookExtension",
    "ExtraAccountMetaList",
    "ExecuteInstruction",
    "InitializeExtraAccountMetaList",
    "InterfaceAccount",
  ];
  const FN_BLACKLIST = [
    "transfer_fee_set",
    "transfer_checked_with_fee",
    "transfer_fee_initialize",
    "withdraw_withheld_tokens_from_mint",
    "harvest_withheld_tokens_to_mint",
  ];
  // Direct E0609 source on pinocchio: Anchor source uses `<acct>.data.borrow()`
  // which assumes the typed Anchor wrapper that exposes a `data: RefCell<Vec<u8>>`
  // field. Pinocchio's `&AccountInfo` has no `.data` field — only methods like
  // `try_borrow_data()`. Always broken on pinocchio. The pattern is part of the
  // T22 ext-unpack chain (`let mint_data = mint.data.borrow();` upstream of
  // `StateWithExtensions::unpack(&mint_data)`) — commenting it cleans the chain.
  // Conservative: only `\.data\.borrow(_mut)?\(\)` form. Don't match qualified
  // module paths.
  const DATA_BORROW_RE = /\b\w+\.data\.borrow(?:_mut)?\(\)/g;

  // Pre-compute top-level statement spans (depth-aware, single forward pass).
  // A statement ends at `;` or `}` at depth 0; a fresh statement begins after
  // any whitespace/newlines. We track string-literal state to avoid false
  // delimiter counts inside string contents.
  const stmtSpans = computeTopLevelStatementSpans(body);

  // Pre-compute comment-stripped span text to avoid false-positive regex hits
  // inside `// …` lines (e.g. an existing CPI commentout block referencing
  // `sources` shouldn't drag the surrounding span into the cascade).
  const spanCodeText: string[] = stmtSpans.map((s) =>
    stripCommentsAndStrings(body.slice(s.stmtStart, s.stmtEnd)),
  );

  // Identify which statement spans match a blacklist pattern. Run regexes
  // against the stripped per-span text rather than the whole body.
  const markedSpanIdx = new Set<number>();
  for (const ident of TYPE_BLACKLIST) {
    const re = new RegExp(`\\b${ident}\\b`);
    for (let i = 0; i < stmtSpans.length; i++) {
      if (markedSpanIdx.has(i)) continue;
      const code = spanCodeText[i] ?? "";
      if (re.test(code)) markedSpanIdx.add(i);
    }
  }
  for (const fn of FN_BLACKLIST) {
    const re = new RegExp(`\\b${fn}\\s*\\(`);
    for (let i = 0; i < stmtSpans.length; i++) {
      if (markedSpanIdx.has(i)) continue;
      const code = spanCodeText[i] ?? "";
      if (re.test(code)) markedSpanIdx.add(i);
    }
  }
  for (let i = 0; i < stmtSpans.length; i++) {
    if (markedSpanIdx.has(i)) continue;
    const code = spanCodeText[i] ?? "";
    if (DATA_BORROW_RE.test(code)) markedSpanIdx.add(i);
    DATA_BORROW_RE.lastIndex = 0;
  }

  // Transitive closure: collect `let X = …;` LHS idents from marked spans, then
  // mark any later span that references those idents (in non-comment code).
  // Repeat until fixed-point.
  const lhsRe = /^\s*let\s+(?:mut\s+)?(\w+)(?:\s*:[^=]+)?\s*=/;
  let changed = true;
  while (changed) {
    changed = false;
    const trackedIdents = new Set<string>();
    for (const idx of markedSpanIdx) {
      const text = spanCodeText[idx] ?? "";
      const m = text.match(lhsRe);
      if (m?.[1]) trackedIdents.add(m[1]);
    }
    if (trackedIdents.size === 0) break;
    for (let i = 0; i < stmtSpans.length; i++) {
      if (markedSpanIdx.has(i)) continue;
      const code = spanCodeText[i] ?? "";
      for (const ident of trackedIdents) {
        const re = new RegExp(`\\b${ident}\\b`);
        if (re.test(code)) {
          markedSpanIdx.add(i);
          changed = true;
          break;
        }
      }
    }
  }

  if (markedSpanIdx.size === 0) return body;

  // Block-cohesion pass: when a marked span sits inside an emitted T22
  // inline block (e.g. cpi_t22_harvest emits `{ const ...; let __hwtm_srcs;
  // for ... { } match ... { ... } }` as one logical unit), we must mark
  // ALL sibling spans from the enclosing `{` through the matching `}`.
  // Without this, fragmentary marks of e.g. `let __hwtm_srcs = ...` (which
  // hits TYPE_BLACKLIST via InterfaceAccount in user-passed sourcesExpr)
  // produce a comment-out that leaves dangling delimiters: the outer `{`
  // and inner sub-block opens stay live, their closes get commented, and
  // tree-sitter parse fails with "unclosed delimiter".
  //
  // Strategy: for each marked span, walk backward through prior spans
  // counting brace balance; the first unmatched `{` marks the enclosing
  // block's open. Walk forward to find its matching `}`. Mark every span
  // in that block range. Repeat until no new marks added.
  // Strip comments + strings ONCE for the whole body so brace counting in
  // the cohesion pass below ignores delimiters inside string literals or
  // comment text. Per-span stripping (in spanCodeText) loses absolute
  // offsets needed for body-wide depth scans.
  const codeBody = stripCommentsAndStrings(body);
  let changed2 = true;
  while (changed2) {
    changed2 = false;
    for (const idx of [...markedSpanIdx]) {
      const span = stmtSpans[idx];
      if (!span) continue;
      // Find the position of the most-recent unmatched `{` BEFORE this
      // span starts. Walk codeBody right-to-left from span.stmtStart,
      // counting `}` (treat as opens-pending) and `{` (matches a pending
      // close, OR if no pending, we've found our enclosing block open).
      let depthBack = 0;
      let openPos = -1;
      for (let p = span.stmtStart - 1; p >= 0; p--) {
        const ch = codeBody[p];
        if (ch === "}") depthBack++;
        else if (ch === "{") {
          if (depthBack === 0) { openPos = p; break; }
          depthBack--;
        }
      }
      if (openPos === -1) continue;
      // Walk forward from openPos+1 through codeBody, depth starts at 1
      // (we just opened a block at openPos). When depth returns to 0 at a
      // `}`, that `}`'s position is the matching close.
      let depthFwd = 1;
      let closePos = -1;
      for (let p = openPos + 1; p < codeBody.length; p++) {
        const ch = codeBody[p];
        if (ch === "{") depthFwd++;
        else if (ch === "}") {
          depthFwd--;
          if (depthFwd === 0) { closePos = p; break; }
        }
      }
      if (closePos === -1) continue;
      // Refuse to expand to the function-body block. The function body's
      // `{` is the outermost block in the file; if openPos is inside the
      // function signature line (or at the function open), we'd over-mark
      // the entire body. Detect by checking whether codeBody[openPos-N..openPos]
      // matches a fn signature pattern. Conservative: if the enclosing
      // open is preceded by a `)` (any function/method/closure signature),
      // require that the open be at depth >= 2 from file start to be a
      // real inner block. fn body open is at depth 1; inner blocks at 2+.
      let depthAtOpen = 0;
      for (let p = 0; p < openPos; p++) {
        const ch = codeBody[p];
        if (ch === "{") depthAtOpen++;
        else if (ch === "}") depthAtOpen--;
      }
      if (depthAtOpen < 1) continue; // openPos is the function-body `{` itself
      // Translate openPos / closePos into span indices.
      let openIdx = -1;
      let closeIdx = -1;
      for (let j = 0; j < stmtSpans.length; j++) {
        const s = stmtSpans[j];
        if (!s) continue;
        if (openIdx === -1 && s.stmtStart <= openPos && openPos < s.stmtEnd) openIdx = j;
        if (s.stmtStart <= closePos && closePos < s.stmtEnd) { closeIdx = j; break; }
      }
      if (openIdx === -1 || closeIdx === -1) continue;
      for (let j = openIdx; j <= closeIdx; j++) {
        if (!markedSpanIdx.has(j)) {
          markedSpanIdx.add(j);
          changed2 = true;
        }
      }
    }
  }

  const ranges: StmtRange[] = [];
  for (const i of [...markedSpanIdx].sort((a, b) => a - b)) {
    const span = stmtSpans[i];
    if (span) ranges.push(span);
  }
  return commentOutT22Ranges(body, ranges);
}

/**
 * Compute statement spans across `body`. A "statement" here is any code unit
 * bounded by `;` (when paren/bracket depth is 0) OR by the closing `}` of a
 * block, OR by the opening `{` of a block. We track only paren/bracket depth
 * (not brace depth) so that `;` inside nested blocks (`if`/`for`/`fn` bodies)
 * is still a statement terminator at that block's level.
 *
 * Comment and string contents are skipped to avoid false `;` / delimiter hits.
 *
 * Spans are returned in source order. Adjacent whitespace-only regions are
 * skipped at the start of each new span. The list contains a span for every
 * `;`-terminated or `}`-terminated unit, including those inside nested
 * blocks — which is what we want for statement-level commentout matching.
 */
function computeTopLevelStatementSpans(body: string): StmtRange[] {
  const out: StmtRange[] = [];
  let i = 0;
  const n = body.length;
  while (i < n) {
    // Skip leading whitespace.
    while (i < n && /\s/.test(body[i] ?? "")) i++;
    if (i >= n) break;
    const start = i;
    let parenDepth = 0;
    let inString = false;
    let inLineComment = false;
    let inBlockComment = false;
    let end = n;
    let advanced = false;
    for (; i < n; i++) {
      const ch = body[i];
      const next = body[i + 1];
      if (inLineComment) {
        if (ch === "\n") inLineComment = false;
        continue;
      }
      if (inBlockComment) {
        if (ch === "*" && next === "/") { inBlockComment = false; i++; }
        continue;
      }
      if (inString) {
        if (ch === "\\") { i++; continue; }
        if (ch === '"') inString = false;
        continue;
      }
      if (ch === "/" && next === "/") { inLineComment = true; i++; continue; }
      if (ch === "/" && next === "*") { inBlockComment = true; i++; continue; }
      if (ch === '"') { inString = true; continue; }
      if (ch === "(" || ch === "[") parenDepth++;
      else if (ch === ")" || ch === "]") {
        if (parenDepth > 0) parenDepth--;
      } else if (ch === "{" && parenDepth === 0) {
        // Block-open closes the current span at the `{` so the block body
        // is decomposed as separate sub-spans.
        end = i + 1;
        i++;
        advanced = true;
        break;
      } else if (ch === "}" && parenDepth === 0) {
        // Block-close: if span is non-empty, end before the `}`; emit `}`
        // as its own span so it's still tracked.
        if (i > start) {
          end = i;
          // Don't advance — let the next iteration consume the `}` as its own span.
          advanced = false;
          break;
        }
        end = i + 1;
        i++;
        advanced = true;
        break;
      } else if (ch === ";" && parenDepth === 0) {
        end = i + 1;
        i++;
        advanced = true;
        break;
      }
    }
    if (!advanced && end === n) {
      // Hit EOF without terminator.
    }
    if (end > start) out.push({ stmtStart: start, stmtEnd: end });
    if (end >= n) break;
  }
  return out;
}

/**
 * Strip line comments, block comments, and string-literal contents from
 * `text`. Used to avoid false-positive blacklist hits inside comments (e.g.
 * an existing CPI-commentout block referencing a tracked ident name). String
 * contents are zeroed out (replaced with same-length spaces) so any regex
 * inside doesn't fire, but offsets are preserved if needed downstream.
 */
function stripCommentsAndStrings(text: string): string {
  const out: string[] = [];
  let i = 0;
  const n = text.length;
  while (i < n) {
    const ch = text[i] ?? "";
    const next = text[i + 1] ?? "";
    if (ch === "/" && next === "/") {
      // Line comment to next newline.
      while (i < n && text[i] !== "\n") {
        out.push(text[i] === "\n" ? "\n" : " ");
        i++;
      }
      continue;
    }
    if (ch === "/" && next === "*") {
      // Block comment terminator: '*' followed by '/'.
      out.push("  ");
      i += 2;
      while (i < n) {
        if (text[i] === "*" && text[i + 1] === "/") {
          out.push("  ");
          i += 2;
          break;
        }
        out.push(text[i] === "\n" ? "\n" : " ");
        i++;
      }
      continue;
    }
    if (ch === '"') {
      out.push('"');
      i++;
      while (i < n && text[i] !== '"') {
        if (text[i] === "\\" && i + 1 < n) {
          out.push("  ");
          i += 2;
          continue;
        }
        out.push(text[i] === "\n" ? "\n" : " ");
        i++;
      }
      if (i < n) { out.push('"'); i++; }
      continue;
    }
    out.push(ch);
    i++;
  }
  return out.join("");
}

function commentOutT22Ranges(body: string, ranges: StmtRange[]): string {
  // Merge overlapping/adjacent ranges (defensive — top-level spans are non-overlapping).
  const merged: StmtRange[] = [];
  for (const r of ranges.sort((a, b) => a.stmtStart - b.stmtStart)) {
    const last = merged[merged.length - 1];
    if (last && r.stmtStart <= last.stmtEnd) {
      last.stmtEnd = Math.max(last.stmtEnd, r.stmtEnd);
    } else {
      merged.push({ ...r });
    }
  }
  // Brace-balance extension. computeTopLevelStatementSpans decomposes block
  // contents into sub-spans; an `if`-let-else inside a `let` binding produces
  // an OPENING-brace span (`let X = if cond {`) that's matched but the body
  // sub-spans (`None`, `} else {`, `Some(...)`) are not, so commenting only
  // the matched range leaves a brace imbalance the rustc compile then catches.
  //
  // Fix: if a merged range has unbalanced `{` at the end, extend the range
  // forward in `body` until the imbalance closes AND we hit the next `;` at
  // depth 0. The whole multi-line let-with-if-else then becomes a single
  // commented unit.
  // Track the furthest stmtEnd seen as we extend ranges forward. Subsequent
  // ranges whose stmtStart falls inside that watermark are already subsumed
  // by a prior extension — running their depth<0 backward walk would chase
  // a `}` whose matching `{` is in the prior range, then keep walking back
  // looking for a preceding `;` (none exists) all the way to file start,
  // pulling unrelated outer code (fn signature, prior statements) into the
  // commentout. Skipping subsumed ranges is safe: their text will be covered
  // by the prior extended range during remerge.
  let coveredEnd = 0;
  for (const r of merged) {
    if (r.stmtStart < coveredEnd) {
      // Subsumed by a prior extended range. Pin start to coveredEnd so the
      // remerge pass collapses cleanly (remerge handles overlap when next
      // range's stmtStart <= last.stmtEnd). Skip extension — depth<0
      // backward walk would chase a `}` whose `{` lives in the prior range.
      r.stmtStart = coveredEnd;
      continue;
    }
    let depth = 0;
    let inString = false;
    let inLine = false;
    let inBlock = false;
    for (let j = r.stmtStart; j < r.stmtEnd; j++) {
      const ch = body[j];
      const next = body[j + 1];
      if (inLine) { if (ch === "\n") inLine = false; continue; }
      if (inBlock) { if (ch === "*" && next === "/") { inBlock = false; j++; } continue; }
      if (inString) { if (ch === "\\") { j++; continue; } if (ch === '"') inString = false; continue; }
      if (ch === "/" && next === "/") { inLine = true; j++; continue; }
      if (ch === "/" && next === "*") { inBlock = true; j++; continue; }
      if (ch === '"') { inString = true; continue; }
      if (ch === "{") depth++;
      else if (ch === "}") depth--;
    }
    if (depth < 0) {
      // Mirror case: range has MORE `}` than `{`. Happens when a struct
      // literal (Foo { field: x, … }) gets sub-decomposed into per-field
      // spans, and the regex matches a field-init line whose enclosing
      // `}` is in the matched range but the opening `{` is in an earlier
      // unmarked span. Walk BACKWARD to include the enclosing `{` (and
      // its statement prefix back to the previous `;` at depth 0).
      let needed = -depth;
      let k = r.stmtStart - 1;
      while (k >= 0 && needed > 0) {
        const ch = body[k];
        if (ch === "}") needed++;
        else if (ch === "{") needed--;
        k--;
      }
      if (needed > 0) continue;
      let depthBack = 0;
      while (k >= 0) {
        const ch = body[k];
        if (ch === "}") depthBack++;
        else if (ch === "{") depthBack--;
        else if (ch === ";" && depthBack === 0) { k++; break; }
        k--;
      }
      if (k < 0) k = 0;
      while (k < r.stmtStart && /\s/.test(body[k] ?? "")) k++;
      r.stmtStart = k;
      if (r.stmtEnd > coveredEnd) coveredEnd = r.stmtEnd;
      continue;
    }
    if (depth === 0) {
      if (r.stmtEnd > coveredEnd) coveredEnd = r.stmtEnd;
      continue;
    }
    // Note: depth==0 mid-statement (struct-literal field-init lines)
    // remains a known-residual gap on Marinade's event-emit blocks. A
    // generic "snap to enclosing block" fix over-extends into the next
    // statement. Leaving alone is safer than over-commenting; the brace
    // imbalance is loud (validator catches it) so the gap is visible.
    // Walk forward to close the imbalance + reach next `;` at depth 0.
    let j = r.stmtEnd;
    while (j < body.length && depth > 0) {
      const ch = body[j];
      const next = body[j + 1];
      if (inLine) { if (ch === "\n") inLine = false; j++; continue; }
      if (inBlock) { if (ch === "*" && next === "/") { inBlock = false; j += 2; continue; } j++; continue; }
      if (inString) { if (ch === "\\") { j += 2; continue; } if (ch === '"') inString = false; j++; continue; }
      if (ch === "/" && next === "/") { inLine = true; j += 2; continue; }
      if (ch === "/" && next === "*") { inBlock = true; j += 2; continue; }
      if (ch === '"') { inString = true; j++; continue; }
      if (ch === "{") depth++;
      else if (ch === "}") depth--;
      j++;
    }
    // After the depth-walker closes the imbalance, the close `}` may be
    // followed by an `else` clause whose body the marker didn't cover. If
    // we leave the `else { … }` orphaned, two failure modes hit: (a) the
    // commented `}` and the uncommented ` else {` share one output line,
    // pulling `else {` into a `//` line comment and orphaning its `};`;
    // (b) `else` with no preceding `if` is an outright syntax error. Walk
    // through any `else [if (...)] { … }` chain.
    while (true) {
      let la = j;
      while (la < body.length && /\s/.test(body[la] ?? "")) la++;
      if (la + 4 > body.length) break;
      if (body.slice(la, la + 4) !== "else") break;
      const after = body[la + 4];
      if (after !== undefined && /\w/.test(after)) break; // word boundary — `elsewhere`, `else_branch` etc.
      // Skip past `else` and any `if (…)` / `if let X = … ` clause to the next `{`.
      j = la + 4;
      while (j < body.length && body[j] !== "{") {
        const ch = body[j];
        const next = body[j + 1];
        if (inLine) { if (ch === "\n") inLine = false; j++; continue; }
        if (inBlock) { if (ch === "*" && next === "/") { inBlock = false; j += 2; continue; } j++; continue; }
        if (inString) { if (ch === "\\") { j += 2; continue; } if (ch === '"') inString = false; j++; continue; }
        if (ch === "/" && next === "/") { inLine = true; j += 2; continue; }
        if (ch === "/" && next === "*") { inBlock = true; j += 2; continue; }
        if (ch === '"') { inString = true; j++; continue; }
        j++;
      }
      if (j >= body.length) break;
      // Depth-walk through the else block to its matching close.
      let d = 0;
      for (; j < body.length; j++) {
        const ch = body[j];
        const next = body[j + 1];
        if (inLine) { if (ch === "\n") inLine = false; continue; }
        if (inBlock) { if (ch === "*" && next === "/") { inBlock = false; j++; } continue; }
        if (inString) { if (ch === "\\") { j++; continue; } if (ch === '"') inString = false; continue; }
        if (ch === "/" && next === "/") { inLine = true; j++; continue; }
        if (ch === "/" && next === "*") { inBlock = true; j++; continue; }
        if (ch === '"') { inString = true; continue; }
        if (ch === "{") d++;
        else if (ch === "}") { d--; if (d === 0) { j++; break; } }
      }
    }
    // Trailing `;` walk — for `let X = if cond { ... } else { ... };` shape
    // we want to consume the terminating `;`. Bounded: only check the
    // immediate next non-whitespace char. If it's `;`, take it. If it's
    // anything else (next statement, another `}`, EOF), STOP at the
    // close `}` boundary. The prior implementation walked to next `;` at
    // trailingDepth 0 unbounded — but trailingDepth could go NEGATIVE on
    // outer-block closes, never returning to 0, so the walk would chew
    // past the matching close and consume tail expressions like Ok(())
    // that have no `;` between them.
    let lookahead = j;
    while (lookahead < body.length && /\s/.test(body[lookahead] ?? "")) lookahead++;
    if (lookahead < body.length && body[lookahead] === ";") {
      j = lookahead + 1;
    }
    r.stmtEnd = j;
    if (r.stmtEnd > coveredEnd) coveredEnd = r.stmtEnd;
  }
  // Re-merge overlapping ranges introduced by extension.
  const remerged: StmtRange[] = [];
  for (const r of merged.sort((a, b) => a.stmtStart - b.stmtStart)) {
    const last = remerged[remerged.length - 1];
    if (last && r.stmtStart <= last.stmtEnd) {
      last.stmtEnd = Math.max(last.stmtEnd, r.stmtEnd);
    } else {
      remerged.push({ ...r });
    }
  }
  let outStr = "";
  let cursor = 0;
  for (const r of remerged) {
    outStr += body.slice(cursor, r.stmtStart);
    const stmt = body.slice(r.stmtStart, r.stmtEnd);
    const commented = stmt
      .split("\n")
      .map((line) => (line.length > 0 ? `// ${line}` : "//"))
      .join("\n");
    outStr += `// ⚠️ Anvil TODO: Token-2022 extension call site has no pinocchio equivalent — manual port required\n${commented}`;
    cursor = r.stmtEnd;
  }
  outStr += body.slice(cursor);
  return outStr;
}

function commentOutSolanaProgramInvoke(body: string): string {
  const SOLANA_INVOKE_RE = /solana_program\s*::\s*program\s*::\s*invoke(?:_signed)?\s*\(/g;
  const matches: { stmtStart: number; stmtEnd: number }[] = [];
  let m: RegExpExecArray | null;
  SOLANA_INVOKE_RE.lastIndex = 0;
  while ((m = SOLANA_INVOKE_RE.exec(body)) !== null) {
    matches.push(expandStatementBounds(body, m.index));
  }
  if (matches.length === 0) return body;

  const trackedIdents = collectIdentsFromCommentedRanges(body, matches);
  const declRanges = findIdentDeclAndMutationRanges(body, trackedIdents);

  const allRanges = [...matches, ...declRanges].sort((a, b) => a.stmtStart - b.stmtStart);
  return commentOutRanges(body, allRanges);
}

interface StmtRange { stmtStart: number; stmtEnd: number }

function expandStatementBounds(text: string, anchor: number): StmtRange {
  // Walk back to previous `;` or `{` at depth 0.
  let depth = 0;
  let stmtStart = 0;
  for (let i = anchor - 1; i >= 0; i--) {
    const ch = text[i];
    if (ch === ")" || ch === "}" || ch === "]") depth++;
    else if (ch === "(" || ch === "[") {
      if (depth === 0) { stmtStart = i + 1; break; }
      depth--;
    } else if (ch === "{") {
      if (depth === 0) { stmtStart = i + 1; break; }
      depth--;
    } else if (ch === ";" && depth === 0) {
      stmtStart = i + 1;
      break;
    }
  }
  // Walk forward to terminating `;` at depth 0.
  let fwdDepth = 0;
  let stmtEnd = text.length;
  for (let i = anchor; i < text.length; i++) {
    const ch = text[i];
    if (ch === "(" || ch === "{" || ch === "[") fwdDepth++;
    else if (ch === ")" || ch === "}" || ch === "]") fwdDepth--;
    else if (ch === ";" && fwdDepth === 0) { stmtEnd = i + 1; break; }
  }
  return { stmtStart, stmtEnd };
}

function collectIdentsFromCommentedRanges(body: string, ranges: StmtRange[]): Set<string> {
  // Collect identifiers used as `&IDENT` first-arg of the invoke (the typed
  // Instruction binding). Conservative: only pick `&\w+` immediately after
  // `(` since that's the invoke's first arg shape we care about.
  const idents = new Set<string>();
  for (const r of ranges) {
    const slice = body.slice(r.stmtStart, r.stmtEnd);
    const argMatch = slice.match(/invoke(?:_signed)?\s*\(\s*&\s*(\w+)/);
    if (argMatch?.[1]) idents.add(argMatch[1]);
  }
  return idents;
}

function findIdentDeclAndMutationRanges(body: string, idents: Set<string>): StmtRange[] {
  if (idents.size === 0) return [];
  const out: StmtRange[] = [];
  for (const ident of idents) {
    // Match the binding declaration when its annotated type is `Instruction`
    // OR the RHS is a `<expr>.into()` shape (typed via inference). Stripping
    // every `let <ident> = …;` would be too aggressive — only the typed
    // binding feeding the invoke is dead code.
    const typedDeclRe = new RegExp(
      `let\\s+(?:mut\\s+)?${ident}\\s*:\\s*Instruction\\b[^;]*;`,
      "g",
    );
    const intoDeclRe = new RegExp(
      `let\\s+(?:mut\\s+)?${ident}\\s*(?::[^=;]*)?=\\s*[^;]*?\\.into\\s*\\(\\s*\\)\\s*;`,
      "g",
    );
    for (const re of [typedDeclRe, intoDeclRe]) {
      let m: RegExpExecArray | null;
      while ((m = re.exec(body)) !== null) {
        out.push({ stmtStart: m.index, stmtEnd: m.index + m[0].length });
      }
    }
    // Match field-mutation statements `<ident>.X = …;` that operate on the
    // commented binding. These reference fields on the now-missing type.
    const mutRe = new RegExp(`${ident}\\s*\\.\\s*\\w+\\s*=\\s*[^;]*;`, "g");
    let m: RegExpExecArray | null;
    while ((m = mutRe.exec(body)) !== null) {
      out.push({ stmtStart: m.index, stmtEnd: m.index + m[0].length });
    }
  }
  return out;
}

function commentOutRanges(body: string, ranges: StmtRange[]): string {
  if (ranges.length === 0) return body;
  // Merge overlapping ranges.
  const merged: StmtRange[] = [];
  for (const r of ranges.sort((a, b) => a.stmtStart - b.stmtStart)) {
    const last = merged[merged.length - 1];
    if (last && r.stmtStart <= last.stmtEnd) {
      last.stmtEnd = Math.max(last.stmtEnd, r.stmtEnd);
    } else {
      merged.push({ ...r });
    }
  }
  let out = "";
  let cursor = 0;
  for (const r of merged) {
    out += body.slice(cursor, r.stmtStart);
    const stmt = body.slice(r.stmtStart, r.stmtEnd);
    const commented = stmt
      .split("\n")
      .map((line) => (line.length > 0 ? `// ${line}` : "//"))
      .join("\n");
    out += `// ⚠️ Anvil TODO: solana_program direct call has no pinocchio equivalent — manual port required\n${commented}`;
    cursor = r.stmtEnd;
  }
  out += body.slice(cursor);
  return out;
}

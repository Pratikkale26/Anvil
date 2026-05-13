/**
 * Native Emitter — Generic target emitter for native solana_program Rust.
 *
 * Extends BaseEmitter with native solana_program implementations.
 * No framework abstractions — uses raw solana_program and borsh for serialization.
 * Complete business logic generation via the BaseEmitter body walker.
 */

import type { SolanaIR, AccountDef, Instruction } from "../ir/schema.js";
import type { Token2022Opts } from "./body-emitter/index.js";
import { BaseEmitter, stubAnchorOnlyImplItem, rewriteTryIntoUnwrap, rewriteAnchorResultAlias, rewriteGetInstancePackedLen } from "./emitter-base.js";
import { promoteImplFnVisibility } from "./emitter-base-utils.js";
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
  irNeedsTokenAccountInitHelper,
  irNeedsMplCreateMetadataV3Helper,
  irNeedsMplCreateMasterEditionV3Helper,
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
  // Fallback must be syntactically valid Rust — `/* TODO */` alone collapses to
  // nothing after lexing and leaves a stray comma in the args list.
  const fallback = decimals ?? "0u8 /* TODO: decimals — could not infer from source; verify against the mint */";
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

// Names already emitted in the standard struct impl — user-authored items
// matching any of these are dropped from emitInherentImplItems to avoid
// duplicate-associated-item errors. Matches `pub const NAME` and `pub fn NAME`
// at any indentation. Both emitters use this list.
const STANDARD_IMPL_NAMES = [
  "DISCRIMINATOR", "INIT_SPACE", "LEN", "TOTAL_LEN", "SPACE", "SIZE",
  "read", "write", "save", "from_account_info",
];
const STANDARD_IMPL_NAME_RE = new RegExp(
  `\\bpub\\s+(?:const|fn)\\s+(?:${STANDARD_IMPL_NAMES.join("|")})\\b`,
);

export class NativeEmitter extends BaseEmitter {
  override readonly frameworkName = "Native";

  /**
   * Inject `Mint::unpack` preludes for any bare `<account>.decimals` reference
   * that survives from the Anchor source. Anchor's `Account<'info, Mint>`
   * exposes `.decimals` directly; native's `&AccountInfo` does not, so the
   * default pass-through emit produces E0609 on every program that reads
   * decimals to scale token amounts (transfer-tokens, spl-token-minter, etc.).
   *
   * Strategy: regex-scan the assembled body for `<accountName>.decimals` where
   * accountName is one of the instruction's accounts. For each unique mint hit,
   * prepend a one-shot prelude reading byte 44 of the SPL Mint layout (works
   * for both SPL Token and Token-2022 — base layout is identical). Substitute
   * `<mint>.decimals` → `<mint>_decimals` in the body.
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
      // \b name . decimals \b, with negative lookbehind for identifier chars.
      const re = new RegExp(`(?<![A-Za-z0-9_])${name}\\.decimals\\b`);
      if (re.test(bodyCode)) mintsHit.push(name);
    }
    if (mintsHit.length === 0) return bodyCode;

    const preludes = mintsHit
      .map(
        (name) => `    let ${name}_decimals = {
        let __mint_data = ${name}.data.borrow();
        if __mint_data.len() < 45 {
            return Err(ProgramError::InvalidAccountData);
        }
        __mint_data[44]
    };`,
      )
      .join("\n");

    let body = bodyCode;
    for (const name of mintsHit) {
      body = body.replace(
        new RegExp(`(?<![A-Za-z0-9_])${name}\\.decimals\\b`, "g"),
        `${name}_decimals`,
      );
    }
    return `${preludes}\n${body}`;
  }

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
    // EM2 typed T22 extension CPIs — every kind here emits an
    // invoke{,_signed} call in its Native handler, so they all need
    // the program::invoke / invoke_signed imports added to lib.rs.
    const t22ExtCpis = _ir.instructions.flatMap((i) =>
      (i.body ?? []).filter((s) =>
        s.kind === "cpi_t22_non_transferable_mint_initialize" ||
        s.kind === "cpi_t22_transfer_fee_initialize" ||
        s.kind === "cpi_t22_transfer_fee_set_fee" ||
        s.kind === "cpi_t22_immutable_owner_initialize" ||
        s.kind === "cpi_t22_transfer_checked_with_fee" ||
        s.kind === "cpi_t22_withdraw_withheld_tokens_from_mint" ||
        s.kind === "cpi_t22_harvest_withheld_tokens_to_mint" ||
        s.kind === "cpi_t22_default_account_state_initialize" ||
        s.kind === "cpi_t22_default_account_state_update" ||
        s.kind === "cpi_t22_interest_bearing_mint_initialize" ||
        s.kind === "cpi_t22_interest_bearing_mint_update_rate" ||
        s.kind === "cpi_t22_token_metadata_initialize" ||
        s.kind === "cpi_t22_token_metadata_update_field" ||
        s.kind === "cpi_t22_token_metadata_update_authority"
      )
    );
    const t22NeedsInvoke =
      t22Cpis.some((s) => !(s as { signerSeeds?: string }).signerSeeds) ||
      t22ExtCpis.some((s) => !(s as { signerSeeds?: string }).signerSeeds);
    const t22NeedsInvokeSigned =
      t22Cpis.some((s) => !!(s as { signerSeeds?: string }).signerSeeds) ||
      t22ExtCpis.some((s) => !!(s as { signerSeeds?: string }).signerSeeds);

    // Pass-through bodies are user Anchor source carried into the emit
    // verbatim. Walker.ts regexes rewrite shapes like
    // `transfer(CpiContext::new(prog, Transfer{...}), amount)` into
    // `invoke(&system_instruction::transfer(...))`. The IR-level helper
    // predicates below only catch typed CPIs (cpi_system_transfer, etc.),
    // not these pass_through-carried forms — so we have to scan for the
    // SOURCE pattern (CpiContext::new) AND already-rewritten output
    // (`invoke(`, `system_instruction::`) to be safe across both paths.
    const passThroughHas = (re: RegExp) =>
      _ir.instructions.some((instr) =>
        (instr.body ?? []).some((s) => s.kind === "pass_through" && re.test(s.code)),
      );
    // System program CPI shapes that walker.ts rewrites to invoke()+system_instruction
    const SYSPROG_CPI_RE = /\b(?:transfer|create_account|allocate|assign|create_account_with_seed)\s*\(\s*CpiContext::new\s*\(/;
    // Two signed forms: legacy `CpiContext::new_with_signer(prog, struct, seeds)`
    // and the fluent `CpiContext::new(prog, struct).with_signer(seeds)` used in
    // pda-rent-payer. Both rewrite to invoke_signed by walker.ts.
    const SYSPROG_CPI_SIGNED_RE = /\b(?:transfer|create_account|allocate|assign|create_account_with_seed)\s*\(\s*CpiContext::new_with_signer\s*\(/;
    const SYSPROG_CPI_FLUENT_SIGNED_RE = /\b(?:transfer|create_account|allocate|assign|create_account_with_seed)\s*\(\s*CpiContext::new\s*\([\s\S]*?\)\s*\.\s*with_signer\s*\(/;
    const passThroughNeedsInvoke =
      passThroughHas(/(?<![\w:])invoke\(/) || passThroughHas(SYSPROG_CPI_RE);
    const passThroughNeedsInvokeSigned =
      passThroughHas(/(?<![\w:])invoke_signed\(/) ||
      passThroughHas(SYSPROG_CPI_SIGNED_RE) ||
      passThroughHas(SYSPROG_CPI_FLUENT_SIGNED_RE);
    const passThroughNeedsSystemInstruction =
      passThroughHas(/\bsystem_instruction::/) ||
      passThroughHas(SYSPROG_CPI_RE) ||
      passThroughHas(SYSPROG_CPI_SIGNED_RE) ||
      passThroughHas(SYSPROG_CPI_FLUENT_SIGNED_RE);

    // #45 — MPL helpers use both invoke + invoke_signed via the Option<seeds>
    // match. Pin both to true when any MPL helper is emitted; the unused
    // branch dead-codes cleanly.
    const needsMpl = irNeedsMplCreateMetadataV3Helper(_ir)
      || irNeedsMplCreateMasterEditionV3Helper(_ir);
    const needsInvoke = irNeedsUnsignedLamportsHelper(_ir)
      || irNeedsHelper(_ir, "spl_transfer")
      || irNeedsUnsignedSplMintToHelper(_ir)
      || irNeedsUnsignedSplBurnHelper(_ir)
      || irNeedsUnsignedSplCloseAccountHelper(_ir)
      || irNeedsAtaCreationHelper(_ir)
      || irNeedsMemoHelper(_ir)
      || irNeedsTokenAccountInitHelper(_ir)
      || t22NeedsInvoke
      || passThroughNeedsInvoke
      || needsMpl;
    const needsInvokeSigned = irNeedsSignedLamportsHelper(_ir)
      || irNeedsSignedSplMintToHelper(_ir)
      || irNeedsSignedSplBurnHelper(_ir)
      || irNeedsSignedSplCloseAccountHelper(_ir)
      || irNeedsInitAccountHelper(_ir)
      || t22NeedsInvokeSigned
      || passThroughNeedsInvokeSigned
      || needsMpl;
    const needsSystemInstruction = irNeedsUnsignedLamportsHelper(_ir)
      || irNeedsSignedLamportsHelper(_ir)
      || irNeedsInitAccountHelper(_ir)
      || passThroughNeedsSystemInstruction;
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
      // Aliased: a user program may have an instruction handler named
      // `create_associated_token_account` (e.g. token-2022-basics fixture).
      // The unaliased import collides with the re-exported handler from
      // `instructions::*` and produces E0061 in the dispatch match arm
      // because the SPL function takes 4 args while our handler takes 3.
      imports.push(`use spl_associated_token_account::instruction::create_associated_token_account as spl_create_ata_ix;`);
    }
    if (irNeedsMemoHelper(_ir)) {
      imports.push(`use spl_memo;`);
    }
    // `init token::*` needs Rent::get() for the rent-exempt minimum.
    // sysvar::Sysvar and system_instruction are already in the base
    // preamble; Rent is added below by the needsRent check (which we
    // OR with this trigger).

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
        // `\bRent::\w` for explicit Rent::get() / Rent::default() in source.
        // `.minimum_balance|.exempt_minimum|.burn_percent` for `<sysvar>.<method>`
        // forms which postProcessInstructionBody rewrites to `Rent::get()?.<method>` —
        // detect the pre-rewrite form so the auto-import fires too.
        (s.kind === 'pass_through' && /\bRent::\w|\.(?:minimum_balance|exempt_minimum|burn_percent)\s*\(/.test(s.code)) ||
        (s.kind === 'state_field_assign' && /\bRent::\w|\.(?:minimum_balance|exempt_minimum|burn_percent)\s*\(/.test(s.value))
      ) ||
      // Realloc prelude (emitReallocPrelude) emits Rent::get()?.minimum_balance(...)
      // via the rent-delta computation. Mirrors pinocchio's needsRent check.
      i.accounts.some(a => a.constraints?.some(c => c.kind === 'realloc'))
    ) || irNeedsTokenAccountInitHelper(_ir);
    if (needsRent) {
      imports.push(`use solana_program::sysvar::rent::Rent;`);
    }

    // Auto-import Instruction / AccountMeta when source-level pass-through,
    // helper bodies, custom-type impl items, or account impl items reference
    // them unqualified. Anchor's `prelude::*` re-exports both, but our
    // import filter strips the glob — without this auto-import the
    // references are unresolved on native (coral-multisig pattern).
    // Scan every text-bearing IR field — pass_through code, state-assign
    // values, helper bodies, type/account impl items. The
    // `AccountMeta::new_readonly(...)` in coral-multisig's
    // `ix.accounts = ix.accounts.iter().map(...).collect()` lives inside a
    // state_field_assign value, not a pass_through.
    const allCarriedText = [
      ..._ir.instructions.flatMap((i) =>
        (i.body ?? []).flatMap((s) => {
          if (s.kind === "pass_through") return [(s as { code: string }).code];
          if (s.kind === "state_field_assign") return [(s as { value: string }).value];
          if (s.kind === "require") return [(s as { condition: string; errorMsg?: string }).condition];
          // EM2 Session 3 — typed T22 IR kinds carry raw expressions
          // (state literals, Option<Pubkey> authorities) that may
          // reference types needing auto-import. Surface those text
          // fields so collectT22ExtensionAutoImports sees them.
          if (s.kind === "cpi_t22_default_account_state_initialize") return [(s as { state: string }).state];
          if (s.kind === "cpi_t22_default_account_state_update") return [(s as { state: string }).state];
          if (s.kind === "cpi_t22_interest_bearing_mint_initialize") {
            return [(s as { rateAuthority: string }).rateAuthority];
          }
          if (s.kind === "cpi_t22_transfer_fee_initialize") {
            return [
              (s as { transferFeeConfigAuthority: string }).transferFeeConfigAuthority,
              (s as { withdrawWithheldAuthority: string }).withdrawWithheldAuthority,
            ];
          }
          if (s.kind === "cpi_t22_token_metadata_update_field") {
            return [(s as { field: string }).field];
          }
          if (s.kind === "cpi_t22_token_metadata_update_authority") {
            return [(s as { newAuthority: string }).newAuthority];
          }
          return [];
        }),
      ),
      ...(_ir.helperFns ?? []).map((h) => h.rawCode),
      ..._ir.types.flatMap((t) => [t.rawCode ?? "", ...(t.implItems ?? [])]),
      ..._ir.accounts.flatMap((a) => a.implItems ?? []),
    ].join("\n");
    const sourceImportsText = (_ir.imports ?? []).join("\n");
    const alreadyImportsInstruction = /\binstruction::Instruction\b/.test(sourceImportsText);
    const alreadyImportsAccountMeta = /\binstruction::AccountMeta\b/.test(sourceImportsText);
    // #45 — MPL helpers reference Instruction + AccountMeta in their body,
    // but the helper text is generated by emitHelpers (which runs after
    // emitUseStatements). Force the imports when needsMpl regardless of
    // allCarriedText regex matching.
    const referencesInstruction =
      (/\bInstruction\b/.test(allCarriedText) || needsMpl) && !alreadyImportsInstruction;
    const referencesAccountMeta =
      (/\bAccountMeta\b/.test(allCarriedText) || needsMpl) && !alreadyImportsAccountMeta;
    const items: string[] = [];
    if (referencesInstruction) items.push("Instruction");
    if (referencesAccountMeta) items.push("AccountMeta");
    if (items.length > 0) {
      imports.push(`use solana_program::instruction::{${items.join(", ")}};`);
    }

    // Auto-import SPL Token-2022 extension types when the source body
    // references them. Source typically pulls these in through nested
    // `anchor_spl::{token_2022::spl_token_2022::extension::*, …}` blocks
    // that the import filter strips wholesale (anchor_spl is always
    // filtered to avoid leaking Anchor-internals). The names below are
    // the standard Token-2022 extension surface used by program-examples
    // and the common Anchor T22 patterns. Only added when the source
    // doesn't already provide a direct `spl_token_2022::*` import.
    const t22ExtImports = collectT22ExtensionAutoImports(allCarriedText, sourceImportsText);
    if (t22ExtImports.length > 0) imports.push(...t22ExtImports);

    imports.push(...this.filteredSourceImports(_ir));
    return dedupImports(imports.join("\n"));
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

  override emitBumpSeed(programId: string, seeds: string[], expectedKey: string): string {
    const seedsStr = seeds.map((s) => `${s}`).join(", ");
    // Native AccountInfo.key is a field (&Pubkey); when caller passed a
    // foo.key expression we need to deref-and-borrow for the
    // find_program_address signature (takes &Pubkey). When caller
    // passed the bare `program_id` ident, leave it as-is.
    const progExpr = programId === "program_id" ? "program_id" : programId;
    return `    let (expected_key, bump) = Pubkey::find_program_address(&[${seedsStr}], ${progExpr});
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
      const invokeType = signerSeeds ? "invoke_signed" : "invoke";
      const signerArg = signerSeeds ? `\n        ${signerSeeds},` : "";
      if (opts?.decimals === undefined) {
        // Token-2022 transfer (unchecked) — `transfer` is deprecated but
        // still accepted; mirror the user's source choice. No mint, no
        // decimals; accounts [from, to, authority].
        return `    // Token-2022 transfer (unchecked) — ${from} → ${to}
    #[allow(deprecated)]
    let transfer_ix = ${crate}::instruction::transfer(
        &${crate}::id(),
        ${from}.key,
        ${to}.key,
        ${authority}.key,
        &[],
        ${amount},
    )?;
    ${invokeType}(
        &transfer_ix,
        &[${from}.clone(), ${to}.clone(), ${authority}.clone()],${signerArg}
    )?;`;
      }
      // Token-2022 transfer_checked — mint + decimals. Detector backfills
      // these from the TransferChecked accounts struct + trailing decimals arg.
      // Helper-method CPI shapes (e.g. `into_transfer_to_taker_context()`)
      // can leave mint unresolved — emit a comment-only stub instead of a
      // partial block whose `${mint}.key` becomes `/* TODO */.key` (syntax
      // error). Same threshold as unsupported Metaplex CPI stubs.
      if (!opts?.mint) {
        return `    // TODO(manual): Token-2022 transfer_checked — ${from} → ${to}
    // Could not resolve mint argument from helper-method CPI context.
    // Reconstruct manually: pass the mint AccountInfo + decimals literal.
    // Original call shape: transfer_checked(ctx, amount, decimals)`;
      }
      const mint = opts.mint;
      const { decimalsExpr, prelude } = resolveT22Decimals(mint, opts?.decimals);
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
      if (opts?.decimals === undefined) {
        // Token-2022 mint_to (unchecked) — accounts [mint, to, authority].
        return `    // Token-2022 mint_to (unchecked) — ${mint} → ${to}
    let mint_ix = ${crate}::instruction::mint_to(
        &${crate}::id(),
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
      if (opts?.decimals === undefined) {
        // Token-2022 burn (unchecked) — accounts [from, mint, authority].
        return `    // Token-2022 burn (unchecked) — ${from}
    let burn_ix = ${crate}::instruction::burn(
        &${crate}::id(),
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

  override emitSplSetAuthority(
    account: string,
    currentAuthority: string,
    authorityType: string,
    newAuthority: string,
    signerSeeds?: string,
    opts?: Token2022Opts,
  ): string {
    const crate = opts?.tokenProgram === "token_2022" ? "spl_token_2022" : "spl_token";
    const invokeType = signerSeeds ? "invoke_signed" : "invoke";
    const signerArg = signerSeeds ? `\n        ${signerSeeds},` : "";
    // Map Anchor's `AuthorityType::X` variant to the target's enum path.
    // Anchor exposes the same variant names as spl_token, so we just rewrite
    // the path. `.into()` covers cases where the user wrote a fully-qualified
    // SPL variant already.
    const remapped = authorityType.replace(
      /\bAuthorityType\b/g,
      `${crate}::instruction::AuthorityType`,
    );
    return `    // ${crate === "spl_token_2022" ? "Token-2022" : "SPL Token"} set authority — ${account}
    let set_authority_ix = ${crate}::instruction::set_authority(
        &${crate}::id(),
        ${account}.key,
        match &${newAuthority} { Some(pk) => Some(pk), None => None },
        ${remapped},
        ${currentAuthority}.key,
        &[],
    )?;
    ${invokeType}(
        &set_authority_ix,
        &[${account}.clone(), ${currentAuthority}.clone()],${signerArg}
    )?;`;
  }

  override emitT22NonTransferableMintInitialize(
    mint: string,
    tokenProgram: string,
    signerSeeds?: string,
  ): string {
    const invokeType = signerSeeds ? "invoke_signed" : "invoke";
    const signerArg = signerSeeds ? `\n        ${signerSeeds},` : "";
    return `    // Token-2022 NonTransferable extension init — ${mint}
    let non_transferable_init_ix = spl_token_2022::instruction::initialize_non_transferable_mint(
        &spl_token_2022::id(),
        ${mint}.key,
    )?;
    ${invokeType}(
        &non_transferable_init_ix,
        &[${mint}.clone(), ${tokenProgram}.clone()],${signerArg}
    )?;`;
  }

  override emitT22TransferFeeInitialize(
    mint: string,
    tokenProgram: string,
    transferFeeConfigAuthority: string,
    withdrawWithheldAuthority: string,
    basisPoints: string,
    maximumFee: string,
    signerSeeds?: string,
  ): string {
    const invokeType = signerSeeds ? "invoke_signed" : "invoke";
    const signerArg = signerSeeds ? `\n        ${signerSeeds},` : "";
    return `    // Token-2022 TransferFee extension init — ${mint}
    let transfer_fee_init_ix = spl_token_2022::extension::transfer_fee::instruction::initialize_transfer_fee_config(
        &spl_token_2022::id(),
        ${mint}.key,
        ${transferFeeConfigAuthority},
        ${withdrawWithheldAuthority},
        ${basisPoints},
        ${maximumFee},
    )?;
    ${invokeType}(
        &transfer_fee_init_ix,
        &[${mint}.clone(), ${tokenProgram}.clone()],${signerArg}
    )?;`;
  }

  override emitT22DefaultAccountStateInitialize(
    mint: string,
    tokenProgram: string,
    state: string,
    signerSeeds?: string,
  ): string {
    const invokeType = signerSeeds ? "invoke_signed" : "invoke";
    const signerArg = signerSeeds ? `\n        ${signerSeeds},` : "";
    return `    // Token-2022 DefaultAccountState extension init — ${mint}
    let das_init_ix = spl_token_2022::extension::default_account_state::instruction::initialize_default_account_state(
        &spl_token_2022::id(),
        ${mint}.key,
        ${state},
    )?;
    ${invokeType}(
        &das_init_ix,
        &[${mint}.clone(), ${tokenProgram}.clone()],${signerArg}
    )?;`;
  }

  override emitT22DefaultAccountStateUpdate(
    mint: string,
    tokenProgram: string,
    freezeAuthority: string,
    state: string,
    signerSeeds?: string,
  ): string {
    const invokeType = signerSeeds ? "invoke_signed" : "invoke";
    const signerArg = signerSeeds ? `\n        ${signerSeeds},` : "";
    return `    // Token-2022 DefaultAccountState — update default state on ${mint}
    let das_update_ix = spl_token_2022::extension::default_account_state::instruction::update_default_account_state(
        &spl_token_2022::id(),
        ${mint}.key,
        ${freezeAuthority}.key,
        &[],
        ${state},
    )?;
    ${invokeType}(
        &das_update_ix,
        &[${mint}.clone(), ${freezeAuthority}.clone(), ${tokenProgram}.clone()],${signerArg}
    )?;`;
  }

  override emitT22InterestBearingMintInitialize(
    mint: string,
    tokenProgram: string,
    rateAuthority: string,
    rate: string,
    signerSeeds?: string,
  ): string {
    const invokeType = signerSeeds ? "invoke_signed" : "invoke";
    const signerArg = signerSeeds ? `\n        ${signerSeeds},` : "";
    // The spl_token_2022 helper takes COption<Pubkey> directly (Some/None values).
    return `    // Token-2022 InterestBearingMint extension init — ${mint}
    let ibm_init_ix = spl_token_2022::extension::interest_bearing_mint::instruction::initialize(
        &spl_token_2022::id(),
        ${mint}.key,
        ${rateAuthority},
        ${rate},
    )?;
    ${invokeType}(
        &ibm_init_ix,
        &[${mint}.clone(), ${tokenProgram}.clone()],${signerArg}
    )?;`;
  }

  override emitT22TokenMetadataInitialize(
    metadata: string,
    mint: string,
    mintAuthority: string,
    updateAuthority: string,
    tokenProgram: string,
    name: string,
    symbol: string,
    uri: string,
    signerSeeds?: string,
  ): string {
    const invokeType = signerSeeds ? "invoke_signed" : "invoke";
    const signerArg = signerSeeds ? `\n        ${signerSeeds},` : "";
    // spl_token_metadata_interface::instruction::initialize returns
    // Instruction by value (no Result), unlike the spl_token_2022
    // helpers used elsewhere. The instruction's program_id is the
    // Token-2022 program (the metadata interface routes through it).
    return `    // Token-2022 TokenMetadata initialize — ${metadata}
    let tmi_ix = spl_token_metadata_interface::instruction::initialize(
        &spl_token_2022::id(),
        ${metadata}.key,
        ${updateAuthority}.key,
        ${mint}.key,
        ${mintAuthority}.key,
        ${name},
        ${symbol},
        ${uri},
    );
    ${invokeType}(
        &tmi_ix,
        &[${metadata}.clone(), ${updateAuthority}.clone(), ${mint}.clone(), ${mintAuthority}.clone(), ${tokenProgram}.clone()],${signerArg}
    )?;`;
  }

  override emitT22TokenMetadataUpdateField(
    metadata: string,
    updateAuthority: string,
    tokenProgram: string,
    field: string,
    value: string,
    signerSeeds?: string,
  ): string {
    const invokeType = signerSeeds ? "invoke_signed" : "invoke";
    const signerArg = signerSeeds ? `\n        ${signerSeeds},` : "";
    return `    // Token-2022 TokenMetadata update_field — ${metadata}
    let tmuf_ix = spl_token_metadata_interface::instruction::update_field(
        &spl_token_2022::id(),
        ${metadata}.key,
        ${updateAuthority}.key,
        ${field},
        ${value},
    );
    ${invokeType}(
        &tmuf_ix,
        &[${metadata}.clone(), ${updateAuthority}.clone(), ${tokenProgram}.clone()],${signerArg}
    )?;`;
  }

  override emitT22TokenMetadataUpdateAuthority(
    metadata: string,
    currentAuthority: string,
    tokenProgram: string,
    newAuthority: string,
    signerSeeds?: string,
  ): string {
    const invokeType = signerSeeds ? "invoke_signed" : "invoke";
    const signerArg = signerSeeds ? `\n        ${signerSeeds},` : "";
    return `    // Token-2022 TokenMetadata update_authority — ${metadata}
    let tmua_ix = spl_token_metadata_interface::instruction::update_authority(
        &spl_token_2022::id(),
        ${metadata}.key,
        ${currentAuthority}.key,
        ${newAuthority},
    );
    ${invokeType}(
        &tmua_ix,
        &[${metadata}.clone(), ${currentAuthority}.clone(), ${tokenProgram}.clone()],${signerArg}
    )?;`;
  }

  override emitT22InterestBearingMintUpdateRate(
    mint: string,
    tokenProgram: string,
    rateAuthority: string,
    rate: string,
    signerSeeds?: string,
  ): string {
    const invokeType = signerSeeds ? "invoke_signed" : "invoke";
    const signerArg = signerSeeds ? `\n        ${signerSeeds},` : "";
    return `    // Token-2022 InterestBearingMint — update rate on ${mint}
    let ibm_update_ix = spl_token_2022::extension::interest_bearing_mint::instruction::update_rate(
        &spl_token_2022::id(),
        ${mint}.key,
        ${rateAuthority}.key,
        &[],
        ${rate},
    )?;
    ${invokeType}(
        &ibm_update_ix,
        &[${mint}.clone(), ${rateAuthority}.clone(), ${tokenProgram}.clone()],${signerArg}
    )?;`;
  }

  override emitT22ImmutableOwnerInitialize(
    tokenAccount: string,
    tokenProgram: string,
    signerSeeds?: string,
  ): string {
    const invokeType = signerSeeds ? "invoke_signed" : "invoke";
    const signerArg = signerSeeds ? `\n        ${signerSeeds},` : "";
    return `    // Token-2022 ImmutableOwner extension init — ${tokenAccount}
    let immutable_owner_init_ix = spl_token_2022::instruction::initialize_immutable_owner(
        &spl_token_2022::id(),
        ${tokenAccount}.key,
    )?;
    ${invokeType}(
        &immutable_owner_init_ix,
        &[${tokenAccount}.clone(), ${tokenProgram}.clone()],${signerArg}
    )?;`;
  }

  override emitT22MintCloseAuthorityInitialize(
    mint: string,
    tokenProgram: string,
    closeAuthority: string,
    signerSeeds?: string,
  ): string {
    // closeAuthority is an Option<&Pubkey> source expression. Pass it
    // verbatim into spl_token_2022's instruction builder; the Rust
    // compiler validates the Option<&Pubkey> shape.
    const invokeType = signerSeeds ? "invoke_signed" : "invoke";
    const signerArg = signerSeeds ? `\n        ${signerSeeds},` : "";
    return `    // Token-2022 MintCloseAuthority extension init — ${mint}
    let mca_init_ix = spl_token_2022::instruction::initialize_mint_close_authority(
        &spl_token_2022::id(),
        ${mint}.key,
        ${closeAuthority},
    )?;
    ${invokeType}(
        &mca_init_ix,
        &[${mint}.clone(), ${tokenProgram}.clone()],${signerArg}
    )?;`;
  }

  override emitT22PermanentDelegateInitialize(
    mint: string,
    tokenProgram: string,
    delegate: string,
    signerSeeds?: string,
  ): string {
    // delegate is a `&Pubkey` source expression (REQUIRED — no Option).
    const invokeType = signerSeeds ? "invoke_signed" : "invoke";
    const signerArg = signerSeeds ? `\n        ${signerSeeds},` : "";
    return `    // Token-2022 PermanentDelegate extension init — ${mint}
    let pd_init_ix = spl_token_2022::instruction::initialize_permanent_delegate(
        &spl_token_2022::id(),
        ${mint}.key,
        ${delegate},
    )?;
    ${invokeType}(
        &pd_init_ix,
        &[${mint}.clone(), ${tokenProgram}.clone()],${signerArg}
    )?;`;
  }

  override emitT22TransferHookInitialize(
    mint: string,
    tokenProgram: string,
    authority: string,
    transferHookProgramId: string,
    signerSeeds?: string,
  ): string {
    // anchor-spl `transfer_hook_initialize` takes `Option<Pubkey>` (by
    // value) for both args. Pass the source expressions verbatim into
    // the spl_token_2022 extension instruction builder.
    const invokeType = signerSeeds ? "invoke_signed" : "invoke";
    const signerArg = signerSeeds ? `\n        ${signerSeeds},` : "";
    return `    // Token-2022 TransferHook extension init — ${mint}
    let thi_ix = spl_token_2022::extension::transfer_hook::instruction::initialize(
        &spl_token_2022::id(),
        ${mint}.key,
        ${authority},
        ${transferHookProgramId},
    )?;
    ${invokeType}(
        &thi_ix,
        &[${mint}.clone(), ${tokenProgram}.clone()],${signerArg}
    )?;`;
  }

  override emitT22TransferHookUpdate(
    mint: string,
    tokenProgram: string,
    authority: string,
    transferHookProgramId: string,
    signerSeeds?: string,
  ): string {
    // spl_token_2022::extension::transfer_hook::instruction::update
    // signature: (token_program, mint, authority, signers: &[&Pubkey],
    // transfer_hook_program_id: Option<Pubkey>). Empty signers slice =
    // single-authority shape (authority itself is the signer).
    const invokeType = signerSeeds ? "invoke_signed" : "invoke";
    const signerArg = signerSeeds ? `\n        ${signerSeeds},` : "";
    return `    // Token-2022 TransferHook update — ${mint}
    let thu_ix = spl_token_2022::extension::transfer_hook::instruction::update(
        &spl_token_2022::id(),
        ${mint}.key,
        ${authority}.key,
        &[],
        ${transferHookProgramId},
    )?;
    ${invokeType}(
        &thu_ix,
        &[${mint}.clone(), ${authority}.clone(), ${tokenProgram}.clone()],${signerArg}
    )?;`;
  }

  override emitT22MetadataPointerInitialize(
    mint: string,
    tokenProgram: string,
    authority: string,
    metadataAddress: string,
    signerSeeds?: string,
  ): string {
    // anchor-spl `metadata_pointer_initialize` takes `Option<Pubkey>`
    // (by value) for both args. Pass through verbatim.
    const invokeType = signerSeeds ? "invoke_signed" : "invoke";
    const signerArg = signerSeeds ? `\n        ${signerSeeds},` : "";
    return `    // Token-2022 MetadataPointer extension init — ${mint}
    let mpi_ix = spl_token_2022::extension::metadata_pointer::instruction::initialize(
        &spl_token_2022::id(),
        ${mint}.key,
        ${authority},
        ${metadataAddress},
    )?;
    ${invokeType}(
        &mpi_ix,
        &[${mint}.clone(), ${tokenProgram}.clone()],${signerArg}
    )?;`;
  }

  override emitT22TransferCheckedWithFee(
    source: string,
    mint: string,
    destination: string,
    authority: string,
    tokenProgram: string,
    amount: string,
    decimals: string,
    fee: string,
    signerSeeds?: string,
  ): string {
    const invokeType = signerSeeds ? "invoke_signed" : "invoke";
    const signerArg = signerSeeds ? `\n        ${signerSeeds},` : "";
    return `    // Token-2022 TransferFee — transfer_checked_with_fee
    let tcwf_ix = spl_token_2022::extension::transfer_fee::instruction::transfer_checked_with_fee(
        &spl_token_2022::id(),
        ${source}.key,
        ${mint}.key,
        ${destination}.key,
        ${authority}.key,
        &[],
        ${amount},
        ${decimals},
        ${fee},
    )?;
    ${invokeType}(
        &tcwf_ix,
        &[${source}.clone(), ${mint}.clone(), ${destination}.clone(), ${authority}.clone(), ${tokenProgram}.clone()],${signerArg}
    )?;`;
  }

  override emitT22WithdrawWithheldFromMint(
    mint: string,
    destination: string,
    authority: string,
    tokenProgram: string,
    signerSeeds?: string,
  ): string {
    const invokeType = signerSeeds ? "invoke_signed" : "invoke";
    const signerArg = signerSeeds ? `\n        ${signerSeeds},` : "";
    return `    // Token-2022 TransferFee — withdraw_withheld_tokens_from_mint
    let wwfm_ix = spl_token_2022::extension::transfer_fee::instruction::withdraw_withheld_tokens_from_mint(
        &spl_token_2022::id(),
        ${mint}.key,
        ${destination}.key,
        ${authority}.key,
        &[],
    )?;
    ${invokeType}(
        &wwfm_ix,
        &[${mint}.clone(), ${destination}.clone(), ${authority}.clone(), ${tokenProgram}.clone()],${signerArg}
    )?;`;
  }

  override emitT22HarvestWithheldToMint(
    mint: string,
    tokenProgram: string,
    sourcesExpr: string,
    signerSeeds?: string,
  ): string {
    const invokeType = signerSeeds ? "invoke_signed" : "invoke";
    const signerArg = signerSeeds ? `\n        ${signerSeeds},` : "";
    // Native expects &[&Pubkey] for source keys. Build at runtime from
    // the sources expression (typically a Vec<AccountInfo> or
    // ctx.remaining_accounts slice). Account list for invoke includes
    // mint, token_program, then each source AccountInfo.
    return `    // Token-2022 TransferFee — harvest_withheld_tokens_to_mint
    let hwtm_sources_vec: Vec<AccountInfo> = (${sourcesExpr}).iter().cloned().collect();
    let hwtm_source_keys: Vec<&Pubkey> = hwtm_sources_vec.iter().map(|a| a.key).collect();
    let hwtm_ix = spl_token_2022::extension::transfer_fee::instruction::harvest_withheld_tokens_to_mint(
        &spl_token_2022::id(),
        ${mint}.key,
        &hwtm_source_keys,
    )?;
    let mut hwtm_account_infos: Vec<AccountInfo> = vec![${mint}.clone(), ${tokenProgram}.clone()];
    hwtm_account_infos.extend(hwtm_sources_vec);
    ${invokeType}(
        &hwtm_ix,
        &hwtm_account_infos,${signerArg}
    )?;`;
  }

  override emitT22TransferFeeSetFee(
    mint: string,
    tokenProgram: string,
    authority: string,
    basisPoints: string,
    maximumFee: string,
    signerSeeds?: string,
  ): string {
    const invokeType = signerSeeds ? "invoke_signed" : "invoke";
    const signerArg = signerSeeds ? `\n        ${signerSeeds},` : "";
    return `    // Token-2022 TransferFee — set fee schedule on ${mint}
    let transfer_fee_set_ix = spl_token_2022::extension::transfer_fee::instruction::set_transfer_fee(
        &spl_token_2022::id(),
        ${mint}.key,
        ${authority}.key,
        &[],
        ${basisPoints},
        ${maximumFee},
    )?;
    ${invokeType}(
        &transfer_fee_set_ix,
        &[${mint}.clone(), ${authority}.clone(), ${tokenProgram}.clone()],${signerArg}
    )?;`;
  }

  override emitProgramAccountClose(account: string, destination: string): string {
    return `    close_program_account(${account}, ${destination})?;`;
  }

  override emitCreateProgramAccount(account: string, payer: string, spaceExpr: string, signerSeeds?: string): string {
    return `    create_program_account(${account}, ${payer}, (${spaceExpr}) as u64, program_id, ${signerSeeds ?? "&[]"})?;`;
  }

  override emitDiscriminatorWrite(accountName: string, typeName: string): string {
    return `    {
        let mut __init_data = ${accountName}.data.borrow_mut();
        __init_data[..8].copy_from_slice(&${typeName}::DISCRIMINATOR);
    }`;
  }

  override emitCreateAta(ata: string, payer: string, mint: string, authority: string, _signerSeeds?: string): string {
    return `    // Create Associated Token Account: ${ata}
    let create_ata_ix = spl_create_ata_ix(
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

  override emitCreateTokenAccount(
    account: string, payer: string, mint: string, authority: string, signerSeeds?: string,
  ): string {
    // Two-step: rent-exempt allocate (165 bytes for SPL TokenAccount) +
    // initialize_account3 binding mint and authority. The create_account
    // CPI signs with the account itself when non-PDA, or with PDA seeds
    // when given. The init CPI never needs a signer (no signer-required
    // accounts in v3 init).
    const createInvoke = signerSeeds
      ? `invoke_signed(&__ta_create, &[${payer}.clone(), ${account}.clone()], ${signerSeeds})?;`
      : `invoke(&__ta_create, &[${payer}.clone(), ${account}.clone()])?;`;
    return `    // Init token account: ${account}
    let __ta_lamports = Rent::get()?.minimum_balance(165);
    let __ta_create = system_instruction::create_account(
        ${payer}.key,
        ${account}.key,
        __ta_lamports,
        165,
        &spl_token::id(),
    );
    ${createInvoke}
    let __ta_init = spl_token::instruction::initialize_account3(
        &spl_token::id(),
        ${account}.key,
        ${mint}.key,
        ${authority}.key,
    )?;
    invoke(&__ta_init, &[${account}.clone(), ${mint}.clone()])?;`;
  }

  override emitCreateMint(
    account: string, payer: string, decimals: string, mintAuthority: string, freezeAuthority: string | null, signerSeeds?: string,
  ): string {
    // Two-step: rent-exempt allocate (82 bytes for SPL Mint) + initialize_mint2
    // (binds decimals + mint_authority + COption<freeze_authority>). Mint2
    // doesn't need the Rent sysvar in the accounts list.
    const createInvoke = signerSeeds
      ? `invoke_signed(&__mint_create, &[${payer}.clone(), ${account}.clone()], ${signerSeeds})?;`
      : `invoke(&__mint_create, &[${payer}.clone(), ${account}.clone()])?;`;
    const freezeArg = freezeAuthority ? `Some(${freezeAuthority}.key)` : `None`;
    return `    // Init mint: ${account}
    let __mint_lamports = Rent::get()?.minimum_balance(82);
    let __mint_create = system_instruction::create_account(
        ${payer}.key,
        ${account}.key,
        __mint_lamports,
        82,
        &spl_token::id(),
    );
    ${createInvoke}
    let __mint_init = spl_token::instruction::initialize_mint2(
        &spl_token::id(),
        ${account}.key,
        ${mintAuthority}.key,
        ${freezeArg},
        (${decimals}) as u8,
    )?;
    invoke(&__mint_init, &[${account}.clone()])?;`;
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

    const seedsStr = transformedSeeds.join(",\n        ");
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
    // Mirror Pinocchio: serialize the event struct (defined in events.rs
    // with BorshSerialize derive) and call sol_log_data with a single
    // concatenated [discriminator, payload] slice. Anchor's macro emits
    // sol_log_data(&[&combined]) which surfaces as a single base64-
    // encoded string in 'Program data: <b64>'. Emitting &[&disc, &payload]
    // would render as two space-separated base64 strings — same byte
    // content but different log-line format. Concatenate to byte-equal.
    if (!fields.trim()) {
      return `    solana_program::log::sol_log_data(&[&${event}::DISCRIMINATOR]);`;
    }
    return `    {
        let __evt = ${event} { ${fields} };
        let __evt_bytes = ::borsh::to_vec(&__evt).map_err(|_| ProgramError::InvalidAccountData)?;
        let mut __evt_payload = ${event}::DISCRIMINATOR.to_vec();
        __evt_payload.extend_from_slice(&__evt_bytes);
        solana_program::log::sol_log_data(&[&__evt_payload]);
    }`;
  }

  override emitClockGet(localVar: string, field?: string): string {
    return `    let ${localVar} = ${this.emitClockGetExpr(field)};`;
  }

  override emitRentGet(localVar: string, field?: string): string {
    return `    let ${localVar} = ${this.emitRentGetExpr(field)};`;
  }

  override emitClockGetExpr(field?: string): string {
    const tail = field ? `.${field}` : "";
    return `solana_program::sysvar::clock::Clock::get()?${tail}`;
  }

  override emitClockGetExprNoTry(field?: string): string {
    const tail = field ? `.${field}` : "";
    return `solana_program::sysvar::clock::Clock::get()${tail}`;
  }

  override emitRentGetExpr(field?: string): string {
    const tail = field ? `.${field}` : "";
    return `solana_program::sysvar::rent::Rent::get()?${tail}`;
  }

  override emitRentGetExprNoTry(field?: string): string {
    const tail = field ? `.${field}` : "";
    return `solana_program::sysvar::rent::Rent::get()${tail}`;
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

    if (acc.isZeroCopy) return this.emitZeroCopyAccountStruct(acc, fields);

    const bodyLen = acc.fields.reduce((s, f) => s + this.resolveTypeSize(f.type, f.maxLen), 0);
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
        // Alias to dodge field-name shadowing — a field named \`data\` would
        // shadow the parameter and break subsequent field reads.
        let __data_buf: &[u8] = data;
        let mut offset = 8usize;
${readLines}
        Ok(Self { ${ctorFields} })
    }

    pub fn write(data: &mut [u8], value: &Self) -> ProgramResult {
        if data.len() < Self::TOTAL_LEN {
            return Err(ProgramError::InvalidAccountData);
        }
        data[..8].copy_from_slice(&Self::DISCRIMINATOR);
        let __data_buf: &mut [u8] = data;
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

    /// Mirror of Pinocchio's from_account_info — the body emitter calls
    /// \`<Type>::from_account_info(account)?\` cross-target, so Native
    /// must expose the same signature even though it could equivalently
    /// borrow + read inline. Without this, programs whose handlers don't
    /// directly call \`::read(...)\` (most non-trivial Anchor sources)
    /// fail Native cargo build with E0599 'no associated item named
    /// from_account_info'.
    pub fn from_account_info(account: &AccountInfo) -> Result<Self, ProgramError> {
        let data = account.try_borrow_data()?;
        Self::read(&data)
    }
}${this.emitInherentImplItems(acc)}`;
  }

  /**
   * Zero-copy struct emit: `#[repr(C)] + Copy + Clone` and a manual
   * `unsafe impl bytemuck::Pod / Zeroable` so the buffer can be cast in-place
   * via `bytemuck::from_bytes_mut`. No borsh derives, no read()/write() —
   * zero-copy accounts never serialize. Discriminator + size constants stay
   * so `<Type>::DISCRIMINATOR` / `<Type>::LEN` resolve at the load site.
   *
   * Soundness of the manual Pod impl rests on the source struct having no
   * padding under #[repr(C)] (fields ordered so each is naturally aligned
   * with no inter-field gaps and no trailing pad). For naturally-aligned
   * shapes — Pubkey (align 1) followed by u64 (align 8) — this is true.
   * Programs whose source struct has padding need to either pre-pack their
   * fields or reach for a different transpile path; deferred until a
   * fixture surfaces it.
   */
  private emitZeroCopyAccountStruct(acc: AccountDef, fields: string): string {
    const bodyLen = acc.fields.reduce((s, f) => s + this.resolveTypeSize(f.type, f.maxLen), 0);
    return `#[repr(C)]
#[derive(Copy, Clone)]
pub struct ${acc.name} {
${fields}
}

unsafe impl bytemuck::Zeroable for ${acc.name} {}
unsafe impl bytemuck::Pod for ${acc.name} {}

impl ${acc.name} {
    pub const DISCRIMINATOR: [u8; 8] = ${this.accountDiscriminatorExpr(acc.name)};
    pub const LEN: usize = ${bodyLen};
    pub const INIT_SPACE: usize = ${bodyLen};
    pub const TOTAL_LEN: usize = 8 + Self::LEN;
    pub const SPACE: usize = Self::TOTAL_LEN;
    pub const SIZE: usize = Self::TOTAL_LEN;
}${this.emitInherentImplItems(acc)}`;
  }

  /**
   * User-authored items inside `impl <ThisAccount> { ... }` from the Anchor
   * source — typically associated consts (e.g. `pub const SEED_PREFIX`) or
   * helper fns (e.g. `pub fn required_space(...)`). Programs reference these
   * from `space = Foo::required_space(...)` / seed exprs, but the standard
   * struct emit doesn't generate them. Emit them verbatim in a separate
   * inherent impl so call sites resolve. Items whose name collides with
   * something the standard emit already produces (DISCRIMINATOR, LEN, etc.)
   * are dropped — standard emit wins because it's based on the IR's
   * computed layout, while the user's value may be stale or wrong.
   */
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

    // Re-export variants at the module level — Anchor source uses bare
    // variant names (`Err(Unauthorized.into())`); without the `pub use`,
    // every `use crate::errors::*;` brings the enum but not the variants.
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

    // #45 — Metaplex Token Metadata: create_metadata_accounts_v3 hand-rolled
    // (Native target). The mpl-token-metadata crate (5.1.1) requires borsh
    // < 1.0 but our scaffold uses borsh 1.6 — incompatible deps. Hand-roll
    // the same byte layout used by Pinocchio. Verified vs mpl-token-metadata
    // 5.1.1 source: discriminator = 33, args = DataV2 + is_mutable +
    // Option<CollectionDetails>.
    if (irNeedsMplCreateMetadataV3Helper(_ir)) {
      helpers.push(`/// Metaplex Token Metadata: create_metadata_accounts_v3 (discriminator 33).
/// Hand-rolled invoke — mpl-token-metadata crate pins borsh < 1.0,
/// incompatible with the scaffold's borsh 1.x dep. Args limited to common
/// Anchor shape: creators/collection/uses/collection_details all None.
pub fn mpl_create_metadata_accounts_v3<'a>(
    metadata: &AccountInfo<'a>,
    mint: &AccountInfo<'a>,
    mint_authority: &AccountInfo<'a>,
    payer: &AccountInfo<'a>,
    update_authority: &AccountInfo<'a>,
    system_program: &AccountInfo<'a>,
    rent: &AccountInfo<'a>,
    token_metadata_program: &AccountInfo<'a>,
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
    data.push(33);
    data.extend_from_slice(&(name.len() as u32).to_le_bytes());
    data.extend_from_slice(name.as_bytes());
    data.extend_from_slice(&(symbol.len() as u32).to_le_bytes());
    data.extend_from_slice(symbol.as_bytes());
    data.extend_from_slice(&(uri.len() as u32).to_le_bytes());
    data.extend_from_slice(uri.as_bytes());
    data.extend_from_slice(&seller_fee_basis_points.to_le_bytes());
    data.push(0);
    data.push(0);
    data.push(0);
    data.push(if is_mutable { 1 } else { 0 });
    data.push(0);
    // Anchor's anchor_spl::metadata::create_metadata_accounts_v3 wrapper
    // hard-codes \`rent: None\` in the builder — the rent sysvar slot is
    // OMITTED from the account meta list. Matching that produces byte-
    // equal CPI invocations. The \`rent\` param is kept for ABI
    // compatibility with existing call sites; the local _ binding makes
    // the unused-variable check happy.
    let _ = rent;
    let accounts = vec![
        AccountMeta::new(*metadata.key, false),
        AccountMeta::new_readonly(*mint.key, false),
        AccountMeta::new_readonly(*mint_authority.key, true),
        AccountMeta::new(*payer.key, true),
        AccountMeta::new_readonly(*update_authority.key, update_authority_is_signer),
        AccountMeta::new_readonly(*system_program.key, false),
    ];
    let ix = Instruction {
        program_id: *token_metadata_program.key,
        accounts,
        data,
    };
    let infos = [
        metadata.clone(), mint.clone(), mint_authority.clone(), payer.clone(),
        update_authority.clone(), system_program.clone(),
    ];
    match signer_seeds {
        Some(seeds) => invoke_signed(&ix, &infos, seeds),
        None => invoke(&ix, &infos),
    }
}`);
    }

    if (irNeedsMplCreateMasterEditionV3Helper(_ir)) {
      helpers.push(`/// Metaplex Token Metadata: create_master_edition_v3 (discriminator 17).
pub fn mpl_create_master_edition_v3<'a>(
    edition: &AccountInfo<'a>,
    mint: &AccountInfo<'a>,
    update_authority: &AccountInfo<'a>,
    mint_authority: &AccountInfo<'a>,
    payer: &AccountInfo<'a>,
    metadata: &AccountInfo<'a>,
    token_program: &AccountInfo<'a>,
    system_program: &AccountInfo<'a>,
    rent: &AccountInfo<'a>,
    token_metadata_program: &AccountInfo<'a>,
    max_supply: Option<u64>,
    signer_seeds: Option<&[&[&[u8]]]>,
) -> ProgramResult {
    let mut data: Vec<u8> = Vec::with_capacity(16);
    data.push(17);
    match max_supply {
        Some(n) => {
            data.push(1);
            data.extend_from_slice(&n.to_le_bytes());
        }
        None => data.push(0),
    }
    let accounts = vec![
        AccountMeta::new(*edition.key, false),
        AccountMeta::new(*mint.key, false),
        AccountMeta::new_readonly(*update_authority.key, true),
        AccountMeta::new_readonly(*mint_authority.key, true),
        AccountMeta::new(*payer.key, true),
        AccountMeta::new(*metadata.key, false),
        AccountMeta::new_readonly(*token_program.key, false),
        AccountMeta::new_readonly(*system_program.key, false),
        AccountMeta::new_readonly(*rent.key, false),
    ];
    let ix = Instruction {
        program_id: *token_metadata_program.key,
        accounts,
        data,
    };
    let infos = [
        edition.clone(), mint.clone(), update_authority.clone(),
        mint_authority.clone(), payer.clone(), metadata.clone(),
        token_program.clone(), system_program.clone(), rent.clone(),
    ];
    match signer_seeds {
        Some(seeds) => invoke_signed(&ix, &infos, seeds),
        None => invoke(&ix, &infos),
    }
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

/**
 * Build the spl_token_2022 / spl_pod use-statements needed by the emitted
 * native body. The source typically imports these through a nested
 * `anchor_spl::{token_2022::spl_token_2022::extension::*, …}` block which
 * the global anchor_spl filter strips. Without a replacement, every
 * extension-type reference in the body becomes E0412 / E0433.
 *
 * Only adds an import when (a) the body actually references the symbol
 * and (b) the source's other imports don't already cover it. Aliased
 * references like `Mint as MintState` need the explicit alias preserved
 * — we hardcode the canonical aliases used across program-examples.
 */
/**
 * Dedup imported names across all `use solana_program::*` lines in the
 * composed import block. Native's auto-import block frequently overlaps
 * with the source's own `use solana_program::*` (often surfacing as
 * `system_instruction` defined twice → E0252). This pass parses each
 * `use solana_program::{X, Y, ...}` or `use solana_program::X;` line,
 * builds a set of already-seen leaf paths, and either rewrites
 * subsequent block-imports to drop dup leaves or removes a single-name
 * import entirely if the leaf was already imported.
 *
 * Conservative: only deduplicates within `solana_program::` (the common
 * conflict source). Other crates pass through unchanged.
 */
function dedupImports(joined: string): string {
  // Fast path: if there's only one `use solana_program::` import (the
  // most common case), no dedup is possible — pass through unchanged so
  // existing single-import-block snapshots stay byte-identical.
  const solanaImportCount = (joined.match(/use\s+solana_program\s*::/g) ?? []).length;
  if (solanaImportCount <= 1) return joined;
  // Collapse multi-line `use solana_program::{ ... };` blocks to single
  // lines so the per-line regex below can extract leaf segments. Only
  // applied when dedup is actually needed (multiple imports detected).
  const collapsed = joined.replace(
    /use\s+solana_program\s*::\s*\{([\s\S]*?)\}\s*;/g,
    (_full, inner: string) => {
      const segments = inner
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
      return `use solana_program::{${segments.join(", ")}};`;
    },
  );
  const lines = collapsed.split("\n");
  const seen = new Set<string>(); // leaf paths after `solana_program::`
  const out: string[] = [];
  for (const rawLine of lines) {
    const line = rawLine;
    const blockMatch = line.match(/^(\s*)use\s+solana_program\s*::\s*\{([^}]+)\}\s*;?\s*$/);
    if (blockMatch) {
      const indent = blockMatch[1] ?? "";
      const segments = (blockMatch[2] ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
      const kept: string[] = [];
      for (const seg of segments) {
        if (!seen.has(seg)) {
          seen.add(seg);
          kept.push(seg);
        }
      }
      if (kept.length === 0) continue; // drop fully-redundant block
      // Restore multi-line format for blocks with 2+ segments — matches
      // the auto-import style native-emitter's emitUseStatements emits
      // and keeps existing snapshots byte-identical.
      if (kept.length >= 2) {
        const inner = kept.map((s) => `${indent}    ${s},`).join("\n");
        out.push(`${indent}use solana_program::{\n${inner}\n${indent}};`);
      } else {
        out.push(`${indent}use solana_program::${kept[0]};`);
      }
      continue;
    }
    const singleMatch = line.match(/^(\s*)use\s+solana_program\s*::\s*([\w:]+)\s*;?\s*$/);
    if (singleMatch) {
      const indent = singleMatch[1] ?? "";
      const seg = singleMatch[2] ?? "";
      if (seen.has(seg)) continue;
      seen.add(seg);
      out.push(`${indent}use solana_program::${seg};`);
      continue;
    }
    // Multi-line block import — split blockMatch isn't simple. Pre-track
    // leaves seen so far and skip if it's a known dup; else keep as-is.
    out.push(line);
  }
  return out.join("\n");
}

function collectT22ExtensionAutoImports(allCarriedText: string, sourceImportsText: string): string[] {
  const out: string[] = [];
  const has = (re: RegExp) => re.test(allCarriedText);

  // Anchor source typically pulls extension types in through a nested
  // `use anchor_spl::{ token_2022::spl_token_2022::extension::*, … }`
  // block. The global anchor_spl filter strips that wholesale (any
  // `use` containing the substring `anchor_spl` is dropped), so even
  // though the type identifiers ARE mentioned in the source's imports
  // text, they don't survive into the emitted file. Dedup against
  // direct `use spl_token_2022::*` / `use spl_pod::*` lines only —
  // those would have come from a user-hand-rolled non-Anchor import.
  const directSourceImports = sourceImportsText
    .split(/(?=^use\s)/m)
    .filter((stmt) => !/\banchor_spl\b/.test(stmt))
    .join("\n");
  const directHas = (re: RegExp) => re.test(directSourceImports);

  // Extension types live in `spl_token_2022::extension::*`.
  const extensionTypes: { ident: string; path: string }[] = [
    { ident: "TransferFeeConfig", path: "spl_token_2022::extension::transfer_fee::TransferFeeConfig" },
    { ident: "BaseStateWithExtensions", path: "spl_token_2022::extension::BaseStateWithExtensions" },
    { ident: "StateWithExtensions", path: "spl_token_2022::extension::StateWithExtensions" },
    { ident: "ExtensionType", path: "spl_token_2022::extension::ExtensionType" },
    { ident: "PodMint", path: "spl_token_2022::pod::PodMint" },
    { ident: "OptionalNonZeroPubkey", path: "spl_pod::optional_keys::OptionalNonZeroPubkey" },
    // EM2 Session 3 — DefaultAccountState's `state` enum lives at
    // spl_token_2022::state::AccountState; emit code references it via
    // `&AccountState::Frozen` etc. Auto-import so users don't have to.
    { ident: "AccountState", path: "spl_token_2022::state::AccountState" },
    // EM2 — TokenMetadata update_field uses Field enum; live at
    // spl_token_metadata_interface::state::Field. Source typically pulls
    // it in via a `use anchor_spl::token_interface::*` block (filtered
    // out) or via `use spl_token_metadata_interface::state::Field` direct.
    { ident: "Field", path: "spl_token_metadata_interface::state::Field" },
  ];
  for (const { ident, path } of extensionTypes) {
    if (!has(new RegExp(`\\b${ident}\\b`))) continue;
    if (directHas(new RegExp(`\\b${ident}\\b`))) continue;
    out.push(`use ${path};`);
  }

  // Aliased `state::Mint as MintState` — special-case the alias since
  // the symbol identity differs from the path tail.
  if (has(/\bMintState\b/) && !directHas(/\bspl_token_2022::state::Mint\s+as\s+MintState\b/)) {
    out.push(`use spl_token_2022::state::Mint as MintState;`);
  }

  return out;
}

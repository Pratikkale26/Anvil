/**
 * Native Emitter — Generic target emitter for native solana_program Rust.
 *
 * Extends BaseEmitter with native solana_program implementations.
 * No framework abstractions — uses raw solana_program and borsh for serialization.
 * Complete business logic generation via the BaseEmitter body walker.
 */

import type { SolanaIR, AccountDef, Instruction } from "../ir/schema.js";
import type { Token2022Opts } from "./body-emitter/index.js";
import { BaseEmitter, stubAnchorOnlyImplItem, rewriteTryIntoUnwrap, rewriteAnchorResultAlias, rewriteGetInstancePackedLen, stripAnchorWrappersInCode } from "./emitter-base.js";
import { rewriteMsgCalls, collapseModulePaths } from "./anchor-transforms.js";
import { rewriteRequireVariantsInCode } from "../parser/project-source.js";
import { applyT22ExtensionCommentout, NATIVE_T22_TYPE_BLACKLIST, NATIVE_T22_FN_BLACKLIST } from "./pinocchio-emitter.js";
import { promoteImplFnVisibility } from "./emitter-base-utils.js";
import {
  instrDiscriminator,
  routerDiscriminator,
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
  irNeedsMplUpdateMetadataAccountsV2Helper,
  irNeedsMplVerifyCollectionHelper,
  irNeedsMplSignMetadataHelper,
  irNeedsMplUnverifyCollectionHelper,
  irNeedsMplSetAndVerifyCollectionHelper,
  irNeedsMplApproveCollectionAuthorityHelper,
  irNeedsMplRevokeCollectionAuthorityHelper,
  irNeedsMplMintNewEditionFromMasterHelper,
  irNeedsMplFreezeDelegatedHelper,
  irNeedsMplThawDelegatedHelper,
  irNeedsMplCoreCreateV2Helper,
  irNeedsMplCoreUpdateV2Helper,
  irNeedsMplCoreTransferV1Helper,
  irNeedsMplCoreBurnV1Helper,
  irNeedsMplCoreCreateCollectionV2Helper,
  irNeedsMplCoreAddPluginV1Helper,
  irNeedsMplCoreRemovePluginV1Helper,
  irNeedsMplCoreUpdatePluginV1Helper,
  irNeedsMplCoreApprovePluginAuthorityV1Helper,
  irNeedsMplCoreRevokePluginAuthorityV1Helper,
  irNeedsT22ConfidentialTransferInitMintHelper,
  irNeedsT22ConfidentialTransferFeeInitHelper,
  irNeedsT22ConfidentialMintBurnInitMintHelper,
} from "./emitter-helpers.js";
import { MARKER_DECIMALS_FALLBACK } from "./markers.js";

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
  // nothing after lexing and leaves a stray comma in the args list. Marker
  // string lives in markers.ts; validator imports the same constant so a drift
  // here is caught by the linkage test (api/tests/marker-validator-linkage.test.ts).
  const fallback = decimals ?? MARKER_DECIMALS_FALLBACK;
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
    // T22 extension call-site commentout — narrower than Pinocchio's
    // because Native ships spl_token_2022 and CAN use plain types like
    // TransferFeeConfig. We only strip statements that reference types
    // whose method chains break after Anvil removes the Anchor account
    // wrappers (StateWithExtensions, InterfaceAccount,
    // ExtraAccountMetaList, etc.). Typed IR CPIs replace transfer_fee_*
    // / withdraw_withheld_* / harvest_withheld_* before this runs; any
    // remaining call-sites are user code that wouldn't compile anyway.
    bodyCode = applyT22ExtensionCommentout(bodyCode, {
      typeBlacklist: NATIVE_T22_TYPE_BLACKLIST,
      fnBlacklist: NATIVE_T22_FN_BLACKLIST,
      // Native's solana_program AccountInfo HAS a `.data` field
      // (`Rc<RefCell<&'a mut [u8]>>`), and counter/vault/escrow demos use
      // `counter.data.borrow_mut()` for state writes — completely valid
      // Native code. Skip the data-borrow trigger that's Pinocchio-only.
      matchDataBorrow: false,
    });
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
      || irNeedsMplCreateMasterEditionV3Helper(_ir)
      || irNeedsMplUpdateMetadataAccountsV2Helper(_ir)
      || irNeedsMplVerifyCollectionHelper(_ir)
      || irNeedsMplSignMetadataHelper(_ir)
      || irNeedsMplUnverifyCollectionHelper(_ir)
      || irNeedsMplSetAndVerifyCollectionHelper(_ir)
      || irNeedsMplApproveCollectionAuthorityHelper(_ir)
      || irNeedsMplRevokeCollectionAuthorityHelper(_ir)
      || irNeedsMplMintNewEditionFromMasterHelper(_ir)
      || irNeedsMplFreezeDelegatedHelper(_ir)
      || irNeedsMplThawDelegatedHelper(_ir)
      || irNeedsMplCoreCreateV2Helper(_ir)
      || irNeedsMplCoreUpdateV2Helper(_ir)
      || irNeedsMplCoreTransferV1Helper(_ir)
      || irNeedsMplCoreBurnV1Helper(_ir)
      || irNeedsMplCoreCreateCollectionV2Helper(_ir)
      || irNeedsMplCoreAddPluginV1Helper(_ir)
      || irNeedsMplCoreRemovePluginV1Helper(_ir)
      || irNeedsMplCoreUpdatePluginV1Helper(_ir)
      || irNeedsMplCoreApprovePluginAuthorityV1Helper(_ir)
      || irNeedsMplCoreRevokePluginAuthorityV1Helper(_ir)
      || irNeedsT22ConfidentialTransferInitMintHelper(_ir)
      || irNeedsT22ConfidentialTransferFeeInitHelper(_ir)
      || irNeedsT22ConfidentialMintBurnInitMintHelper(_ir);
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
      // spl_transfer's helper emission is asymmetric to the other SPL kinds:
      // when any `cpi_spl_transfer` exists, the emitter pushes BOTH
      // `spl_token_transfer` (unsigned) AND `spl_token_transfer_signed`
      // helpers in one block, so `invoke_signed` is referenced even when
      // no caller currently uses the signed path. The other SPL families
      // have separate Signed/Unsigned helper gates. Without this, /build
      // surfaced E0425 "cannot find function `invoke_signed`" on every
      // emit that included a cpi_spl_transfer.
      || irNeedsHelper(_ir, "spl_transfer")
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

    // G108 — detect bare `set_return_data` / `get_return_data` calls in
    // any instruction body (carried code uses these unqualified after
    // `use anchor_lang::solana_program::program::set_return_data` is
    // stripped). Same detection shape as needsInvoke. return-data demo
    // failed compile pre-G108 because the function wasn't imported.
    const needsSetReturnData = _ir.instructions.some((instr) =>
      instr.body.some((stmt) =>
        (stmt.kind === "pass_through" && /\bset_return_data\s*\(/.test(stmt.code))
        || (stmt.kind === "return_data_set")
      )
    );
    const needsGetReturnData = _ir.instructions.some((instr) =>
      instr.body.some((stmt) =>
        (stmt.kind === "pass_through" && /\bget_return_data\s*\(/.test(stmt.code))
        || (stmt.kind === "return_data_get")
      )
    );
    const solanaItems = [
      `account_info::AccountInfo`,
      `entrypoint`,
      `entrypoint::ProgramResult`,
      needsMsg ? `msg` : null,
      needsInvoke ? `program::invoke` : null,
      needsInvokeSigned ? `program::invoke_signed` : null,
      needsSetReturnData ? `program::set_return_data` : null,
      needsGetReturnData ? `program::get_return_data` : null,
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

    // Add Clock import when any instruction uses sysvar_clock or any body
    // text-field references Clock::get. The per-kind list below covers
    // every body kind that carries user-written expression text — adding
    // a new kind that does so requires extending this list. Caught by
    // arjun-sol-vault: `emit!()` event field initializer referenced
    // `Clock::get()` and the gate missed it.
    const bodyTextHasPattern = (re: RegExp): boolean =>
      _ir.instructions.some((i) =>
        i.body.some((s) => {
          if (s.kind === "pass_through") return re.test((s as { code: string }).code);
          if (s.kind === "state_field_assign") return re.test((s as { value: string }).value);
          if (s.kind === "require") return re.test((s as { condition: string }).condition);
          if (s.kind === "emit") return re.test((s as { fields: string }).fields);
          if (s.kind === "msg") {
            const m = s as { message: string; args?: string };
            return re.test(m.message) || (m.args ? re.test(m.args) : false);
          }
          return false;
        }),
      );

    const needsClock = _ir.instructions.some(i =>
      i.body.some(s =>
        s.kind === 'sysvar_clock' ||
        // M2b / N5 — Pyth legacy + modern emits both reference Clock::get()
        // (modern via clockExpr verbatim, legacy via crate call chain).
        s.kind === 'cpi_pyth_read_price_legacy' ||
        s.kind === 'cpi_pyth_read_price_modern' ||
        (s.kind === 'cpi_switchboard_read_feed' && s.maxStalenessSlots != null)
      )
    ) || bodyTextHasPattern(/\bClock::get\(\)/) || (() => {
      // G63 — same as G43/G49b on Pinocchio: also detect Clock as TYPE
      // in carried impl items + helper sigs (marinade `pub fn new(...
      // clock: &Clock, ...)`) and Clock::get() in those contexts.
      const TYPE_RE = /\b(?:&\s*)?Clock\b(?!\s*::\s*\w)/;
      const GET_RE = /\bClock::get\s*\(/;
      const RE_COMBINED = new RegExp(`${TYPE_RE.source}|${GET_RE.source}`);
      for (const h of _ir.helperFns ?? []) {
        if (RE_COMBINED.test(h.rawCode ?? "") || RE_COMBINED.test(h.body ?? "")) return true;
      }
      for (const acc of _ir.accounts) {
        for (const item of acc.implItems ?? []) if (RE_COMBINED.test(item)) return true;
      }
      for (const t of _ir.types ?? []) {
        for (const item of t.implItems ?? []) if (RE_COMBINED.test(item)) return true;
      }
      for (const ut of _ir.userTraits ?? []) if (RE_COMBINED.test(ut)) return true;
      for (const uti of _ir.userTraitImpls ?? []) if (RE_COMBINED.test(uti)) return true;
      return false;
    })();
    if (needsClock) {
      imports.push(`use solana_program::sysvar::clock::Clock;`);
    }
    const needsRent = _ir.instructions.some(i =>
      i.body.some(s => s.kind === 'sysvar_rent') ||
      // Realloc prelude (emitReallocPrelude) emits Rent::get()?.minimum_balance(...)
      // via the rent-delta computation. Mirrors pinocchio's needsRent check.
      i.accounts.some(a => a.constraints?.some(c => c.kind === 'realloc'))
    ) || irNeedsTokenAccountInitHelper(_ir)
      // `\bRent::\w` for explicit Rent::get() / Rent::default() in source.
      // `.minimum_balance|.exempt_minimum|.burn_percent` for `<sysvar>.<method>`
      // forms which postProcessInstructionBody rewrites to `Rent::get()?.<method>` —
      // detect the pre-rewrite form so the auto-import fires too.
      || bodyTextHasPattern(/\bRent::\w|\.(?:minimum_balance|exempt_minimum|burn_percent)\s*\(/);
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
      // G50 — include userTraits + userTraitImpls in carried-text scan
      // so auto-import detection sees AccountMeta references in
      // `impl From<&AccountMeta> for X { ... }` blocks (which G50
      // moved out of type.implItems and into userTraitImpls).
      ...(_ir.userTraits ?? []),
      ...(_ir.userTraitImpls ?? []),
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
    // G63 — auto-import spl_token::state::{Mint, TokenAccount} when carried
    // code references the bare types in signatures (Anchor's
    // anchor_spl::token::{Mint, TokenAccount} is filtered). Skip when user
    // defines their own type with the same name.
    const userTypeNamesG63 = new Set<string>([
      ...(_ir.types ?? []).map((t) => t.name),
      ...(_ir.accounts ?? []).map((a) => a.name),
    ]);
    const mintRE = /\b(?:&\s*(?:mut\s+)?)?Mint\b(?!\s*::)/;
    const taRE = /\b(?:&\s*(?:mut\s+)?)?TokenAccount\b(?!\s*::)/;
    const refsMintG63 = !userTypeNamesG63.has("Mint") && mintRE.test(allCarriedText);
    const refsTokenAccountG63 = !userTypeNamesG63.has("TokenAccount") && taRE.test(allCarriedText);
    if (refsMintG63) imports.push(`use spl_token::state::Mint;`);
    if (refsTokenAccountG63) imports.push(`use spl_token::state::Account as TokenAccount;`);

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

  /** G19 — Native target wraps the byte array with Pubkey::new_from_array
   * because Pubkey here is the solana_program type (not a bare alias). */
  protected override programIdConstExpr(byteList: string): string {
    return `Pubkey::new_from_array([${byteList}])`;
  }

  /** G5-followup — apply NATIVE_T22 blacklist to carried helper-fn bodies
   *  too (mirrors PinocchioEmitter's override). Source helpers that
   *  reference switchboard types (RandomnessAccountData /
   *  PullFeedAccountData) or other unsupported Anchor-method chains
   *  fail at link time on Native; comment-out matches the typed
   *  cpi_t22_* IR kinds' fall-back behavior. Caught by
   *  arjun-merkle-tree (Native). */
  protected override carriedFunctionBlock(rawCode: string, ir?: SolanaIR): string {
    const baseOutput = super.carriedFunctionBlock(rawCode, ir);
    const stripped = stripAnchorWrappersInCode(baseOutput, "native");
    return applyT22ExtensionCommentout(stripped, {
      typeBlacklist: NATIVE_T22_TYPE_BLACKLIST,
      fnBlacklist: NATIVE_T22_FN_BLACKLIST,
      matchDataBorrow: false,
    });
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
          `        ${routerDiscriminator(instr)} => ${snakeCase(instr.name)}(program_id, accounts, data),`
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
    // Path 2 v1 runtime dispatch on Native — same contract as the
    // Pinocchio side (commit 259c290). When tokenProgramArg is set,
    // the spl_token[_2022]::instruction::transfer*(..) functions
    // accept any program ID for arg 0; pass the runtime AccountInfo
    // key instead of the const so legacy SPL Token mints with
    // Interface<TokenInterface> route correctly.
    const useRuntimeDispatch = !!opts?.tokenProgramArg;
    const programIdArg = useRuntimeDispatch
      ? `${opts!.tokenProgramArg}.key`
      : `&${crate}::id()`;
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
        ${programIdArg},
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
        ${programIdArg},
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
    // Path 2 v1 runtime dispatch — see emitSplTransfer comment.
    const useRuntimeDispatch = !!opts?.tokenProgramArg;
    const programIdArg = useRuntimeDispatch
      ? `${opts!.tokenProgramArg}.key`
      : `&${crate}::id()`;
    if (t22) {
      if (opts?.decimals === undefined) {
        // Token-2022 mint_to (unchecked) — accounts [mint, to, authority].
        return `    // Token-2022 mint_to (unchecked) — ${mint} → ${to}
    let mint_ix = ${crate}::instruction::mint_to(
        ${programIdArg},
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
        ${programIdArg},
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
        ${programIdArg},
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
    const useRuntimeDispatch = !!opts?.tokenProgramArg;
    const programIdArg = useRuntimeDispatch
      ? `${opts!.tokenProgramArg}.key`
      : `&${crate}::id()`;
    if (t22) {
      if (opts?.decimals === undefined) {
        // Token-2022 burn (unchecked) — accounts [from, mint, authority].
        return `    // Token-2022 burn (unchecked) — ${from}
    let burn_ix = ${crate}::instruction::burn(
        ${programIdArg},
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
        ${programIdArg},
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
        ${programIdArg},
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
    const useRuntimeDispatch = !!opts?.tokenProgramArg;
    const programIdArg = useRuntimeDispatch
      ? `${opts!.tokenProgramArg}.key`
      : `&${crate}::id()`;
    return `    // ${crate === "spl_token_2022" ? "Token-2022" : "SPL Token"} close account — ${account}
    let close_ix = ${crate}::instruction::close_account(
        ${programIdArg},
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
    // Path 2 v1 runtime dispatch — same contract as emitSplTransfer.
    const useRuntimeDispatch = !!opts?.tokenProgramArg;
    const programIdArg = useRuntimeDispatch
      ? `${opts!.tokenProgramArg}.key`
      : `&${crate}::id()`;
    // Map Anchor's `AuthorityType::X` variant to the target's enum path.
    // Anchor exposes the same variant names as spl_token, so we just rewrite
    // the path. Skip when the source already wrote a fully-qualified
    // `spl_token::instruction::AuthorityType::X` path (set-authority demo).
    // Without this guard we get a double prefix:
    //   `spl_token::instruction::spl_token::instruction::AuthorityType::X`.
    const remapped = /::instruction::AuthorityType\b/.test(authorityType)
      ? authorityType
      : authorityType.replace(
          /\bAuthorityType\b/g,
          `${crate}::instruction::AuthorityType`,
        );
    return `    // ${crate === "spl_token_2022" ? "Token-2022" : "SPL Token"} set authority — ${account}
    let set_authority_ix = ${crate}::instruction::set_authority(
        ${programIdArg},
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

  override emitT22MetadataPointerUpdate(
    mint: string,
    tokenProgram: string,
    authority: string,
    metadataAddress: string,
    signerSeeds?: string,
  ): string {
    // anchor-spl 0.31/0.32 does not expose a wrapper for MetadataPointer
    // update. Programs use raw spl_token_2022::extension::metadata_pointer
    // ::instruction::update directly. Anvil's typed slot routes here so
    // the emit is uniform whether the source went through anchor-spl or
    // raw spl_token_2022. Native path emits the same raw helper.
    const invokeType = signerSeeds ? "invoke_signed" : "invoke";
    const signerArg = signerSeeds ? `\n        ${signerSeeds},` : "";
    return `    // Token-2022 MetadataPointer update — ${mint}
    let mpu_ix = spl_token_2022::extension::metadata_pointer::instruction::update(
        &spl_token_2022::id(),
        ${mint}.key,
        ${authority}.key,
        &[],
        ${metadataAddress},
    )?;
    ${invokeType}(
        &mpu_ix,
        &[${mint}.clone(), ${authority}.clone(), ${tokenProgram}.clone()],${signerArg}
    )?;`;
  }

  override emitT22GroupPointerInitialize(
    mint: string,
    tokenProgram: string,
    authority: string,
    groupAddress: string,
    signerSeeds?: string,
  ): string {
    const invokeType = signerSeeds ? "invoke_signed" : "invoke";
    const signerArg = signerSeeds ? `\n        ${signerSeeds},` : "";
    return `    // Token-2022 GroupPointer extension init — ${mint}
    let gpi_ix = spl_token_2022::extension::group_pointer::instruction::initialize(
        &spl_token_2022::id(),
        ${mint}.key,
        ${authority},
        ${groupAddress},
    )?;
    ${invokeType}(
        &gpi_ix,
        &[${mint}.clone(), ${tokenProgram}.clone()],${signerArg}
    )?;`;
  }

  override emitT22GroupPointerUpdate(
    mint: string,
    tokenProgram: string,
    authority: string,
    groupAddress: string,
    signerSeeds?: string,
  ): string {
    const invokeType = signerSeeds ? "invoke_signed" : "invoke";
    const signerArg = signerSeeds ? `\n        ${signerSeeds},` : "";
    return `    // Token-2022 GroupPointer update — ${mint}
    let gpu_ix = spl_token_2022::extension::group_pointer::instruction::update(
        &spl_token_2022::id(),
        ${mint}.key,
        ${authority}.key,
        &[],
        ${groupAddress},
    )?;
    ${invokeType}(
        &gpu_ix,
        &[${mint}.clone(), ${authority}.clone(), ${tokenProgram}.clone()],${signerArg}
    )?;`;
  }

  override emitT22GroupMemberPointerInitialize(
    mint: string,
    tokenProgram: string,
    authority: string,
    memberAddress: string,
    signerSeeds?: string,
  ): string {
    const invokeType = signerSeeds ? "invoke_signed" : "invoke";
    const signerArg = signerSeeds ? `\n        ${signerSeeds},` : "";
    return `    // Token-2022 GroupMemberPointer extension init — ${mint}
    let gmpi_ix = spl_token_2022::extension::group_member_pointer::instruction::initialize(
        &spl_token_2022::id(),
        ${mint}.key,
        ${authority},
        ${memberAddress},
    )?;
    ${invokeType}(
        &gmpi_ix,
        &[${mint}.clone(), ${tokenProgram}.clone()],${signerArg}
    )?;`;
  }

  override emitT22GroupMemberPointerUpdate(
    mint: string,
    tokenProgram: string,
    authority: string,
    memberAddress: string,
    signerSeeds?: string,
  ): string {
    const invokeType = signerSeeds ? "invoke_signed" : "invoke";
    const signerArg = signerSeeds ? `\n        ${signerSeeds},` : "";
    return `    // Token-2022 GroupMemberPointer update — ${mint}
    let gmpu_ix = spl_token_2022::extension::group_member_pointer::instruction::update(
        &spl_token_2022::id(),
        ${mint}.key,
        ${authority}.key,
        &[],
        ${memberAddress},
    )?;
    ${invokeType}(
        &gmpu_ix,
        &[${mint}.clone(), ${authority}.clone(), ${tokenProgram}.clone()],${signerArg}
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
    // Defect C fix in the line below: source iterables are typically
    // Vec<&AccountInfo> (from vec![&account, ...]), so .iter().cloned()
    // yields &AccountInfo not AccountInfo. Use map+deref+clone to
    // materialise owned AccountInfos.
    return `    // Token-2022 TransferFee — harvest_withheld_tokens_to_mint
    let hwtm_sources_vec: Vec<AccountInfo> = (${sourcesExpr}).iter().map(|a| (*a).clone()).collect();
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

  override emitZeroAccountDiscriminatorWrite(accountName: string, typeName: string): string {
    // task #43 — write disc only when buffer is zero-init (Anchor #[account(zero)]
    // precondition). Mirror of Pinocchio's emit, using AccountInfo::data.borrow_mut().
    return `    // #[account(zero)]: write ${typeName}::DISCRIMINATOR on first access
    {
        let mut __zero_data = ${accountName}.data.borrow_mut();
        if __zero_data.len() >= 8 && __zero_data[..8].iter().all(|&b| b == 0) {
            __zero_data[..8].copy_from_slice(&${typeName}::DISCRIMINATOR);
        }
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
    account: string, payer: string, decimals: string, mintAuthority: string, freezeAuthority: string | null, signerSeeds?: string, tokenProgram?: string,
  ): string {
    // Two-step: rent-exempt allocate (82 bytes for SPL Mint) + initialize_mint2
    // (binds decimals + mint_authority + COption<freeze_authority>). Mint2
    // doesn't need the Rent sysvar in the accounts list.
    //
    // tokenProgram: when set, source uses Interface<TokenInterface> or
    // similar — read program ID from the runtime AccountInfo binding
    // (.key). Both spl_token::instruction::initialize_mint2 and
    // system_instruction::create_account take program_id as their first
    // arg and tolerate the Token-2022 program ID (T22 is backward-compat
    // for the basic mint operations / wire format). When unset, fall back
    // to the legacy hardcoded ID via spl_token::id().
    const tokenProgramExpr = tokenProgram ? `${tokenProgram}.key` : `&spl_token::id()`;
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
        ${tokenProgramExpr},
    );
    ${createInvoke}
    let __mint_init = spl_token::instruction::initialize_mint2(
        ${tokenProgramExpr},
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

  /**
   * M2b — Native Pyth legacy read uses the pyth-sdk-solana crate directly.
   * The crate is auto-injected via project-scaffold's NATIVE_OPTIONAL_DEPS
   * when ir.imports references pyth_sdk_solana::* (the parser keeps the
   * `use` line even though the load_* call is consumed into the typed IR
   * kind, so the dep stays alive). Emit re-builds the call chain
   * fully-qualified so it works regardless of whether the source had
   * `use pyth_sdk_solana::load_price_feed_from_account_info;`.
   *
   * The price binding ends up typed as `pyth_sdk_solana::Price` — fields
   * `price` (i64), `conf` (u64), `exponent` (i32), `publish_time` (i64).
   * Downstream field reads (`current_price.price` etc.) compile cleanly.
   */
  // Pyth M2b/N5 emits are unified in emitter-base — both targets
  // hand-roll the byte deserialization, eliminating the pyth crate
  // borsh-derive cargo-compat issue. See emitter-base.ts
  // emitPythReadPriceLegacy / emitPythReadPriceModern.

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
}${this.emitInherentImplItems(acc, this._irForAccountEmit)}`;
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
}${this.emitInherentImplItems(acc, this._irForAccountEmit)}

${this.emitZeroCopyTraitImpls(acc.name)}`;
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
  private emitInherentImplItems(acc: AccountDef, ir?: SolanaIR): string {
    if (!acc.implItems || acc.implItems.length === 0) return "";
    const knownNames = ir ? this.collectKnownTopLevelNames(ir) : new Set<string>();
    const filtered = acc.implItems
      .filter((raw) => !STANDARD_IMPL_NAME_RE.test(raw))
      .map((raw) => {
        let processed = rewriteRequireVariantsInCode(
          rewriteMsgCalls(
            stripAnchorWrappersInCode(
              promoteImplFnVisibility(
                rewriteGetInstancePackedLen(rewriteAnchorResultAlias(rewriteTryIntoUnwrap(stubAnchorOnlyImplItem(raw)))),
              ),
              "native",
            ),
            (m: string) => this.emitMsg(m),
          ),
        );
        if (knownNames.size > 0) {
          processed = collapseModulePaths(processed, knownNames);
        }
        return processed;
      });
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

    // G94b attempt to skip auto-emit when user has its own From impl
    // cascaded marginfi /pin +8 (qualified `errors::MarginfiError` body
    // refs lost the From impl). Reverted; accept openbook 1x E0119
    // duplicate impl warning.

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
    // Option<CollectionDetails>. DataV2.creators supported via local Creator
    // struct (task #84); collection / uses / collection_details still None.
    if (irNeedsMplCreateMetadataV3Helper(_ir) || irNeedsMplUpdateMetadataAccountsV2Helper(_ir)) {
      helpers.push(`/// Mirrors mpl-token-metadata 5.1.1's Creator struct for inline Borsh
/// serialization without a runtime mpl crate dependency. address is
/// the Pubkey value (callers pass via \`*account.key\` deref or owned
/// Pubkey from find_program_address etc.).
#[derive(Clone, Copy)]
pub struct Creator {
    pub address: Pubkey,
    pub verified: bool,
    pub share: u8,
}

/// Mirrors mpl-token-metadata 5.1.1's Collection struct. 33 bytes
/// (1 byte verified + 32 byte key). Task #84 phase 4.
#[derive(Clone, Copy)]
pub struct Collection {
    pub verified: bool,
    pub key: Pubkey,
}

/// Mirrors mpl-token-metadata 5.1.1's UseMethod enum (Borsh variant
/// discriminant: Burn=0, Multiple=1, Single=2). Task #84 phase 5.
#[derive(Clone, Copy)]
pub enum UseMethod {
    Burn,
    Multiple,
    Single,
}

/// Mirrors mpl-token-metadata 5.1.1's Uses struct. 17 bytes (1 byte
/// variant + 8 byte u64 LE remaining + 8 byte u64 LE total). Task #84 phase 5.
#[derive(Clone, Copy)]
pub struct Uses {
    pub use_method: UseMethod,
    pub remaining: u64,
    pub total: u64,
}`);
    }
    if (irNeedsMplCreateMetadataV3Helper(_ir)) {
      helpers.push(`/// Metaplex Token Metadata: create_metadata_accounts_v3 (discriminator 33).
/// Hand-rolled invoke — mpl-token-metadata crate pins borsh < 1.0,
/// incompatible with the scaffold's borsh 1.x dep. DataV2.creators
/// supported via local Creator<'a>; collection / uses / collection_details
/// still hard-coded to None.
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
    creators: Option<Vec<Creator>>,
    collection: Option<Collection>,
    uses: Option<Uses>,
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
    match creators {
        Some(arr) => {
            data.push(1);
            data.extend_from_slice(&(arr.len() as u32).to_le_bytes());
            for c in arr {
                data.extend_from_slice(c.address.as_ref());
                data.push(if c.verified { 1 } else { 0 });
                data.push(c.share);
            }
        }
        None => data.push(0),
    }
    match collection {
        Some(cc) => {
            data.push(1);
            data.push(if cc.verified { 1 } else { 0 });
            data.extend_from_slice(cc.key.as_ref());
        }
        None => data.push(0),
    }
    match uses {
        Some(u) => {
            data.push(1);
            data.push(match u.use_method {
                UseMethod::Burn => 0,
                UseMethod::Multiple => 1,
                UseMethod::Single => 2,
            });
            data.extend_from_slice(&u.remaining.to_le_bytes());
            data.extend_from_slice(&u.total.to_le_bytes());
        }
        None => data.push(0),
    }
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
    // Anchor's anchor_spl::metadata::create_master_edition_v3 wrapper
    // hard-codes \`rent: None\` — the rent slot is OMITTED from the
    // account list. Matching that produces byte-equal CPI invocations
    // (mirrors the create_metadata_v3 sibling fix). The \`rent\` param
    // stays for ABI compat; the let _ binding silences unused.
    let _ = rent;
    let accounts = vec![
        AccountMeta::new(*edition.key, false),
        AccountMeta::new(*mint.key, false),
        AccountMeta::new_readonly(*update_authority.key, true),
        AccountMeta::new_readonly(*mint_authority.key, true),
        AccountMeta::new(*payer.key, true),
        AccountMeta::new(*metadata.key, false),
        AccountMeta::new_readonly(*token_program.key, false),
        AccountMeta::new_readonly(*system_program.key, false),
    ];
    let ix = Instruction {
        program_id: *token_metadata_program.key,
        accounts,
        data,
    };
    let infos = [
        edition.clone(), mint.clone(), update_authority.clone(),
        mint_authority.clone(), payer.clone(), metadata.clone(),
        token_program.clone(), system_program.clone(),
    ];
    match signer_seeds {
        Some(seeds) => invoke_signed(&ix, &infos, seeds),
        None => invoke(&ix, &infos),
    }
}`);
    }

    if (irNeedsMplUpdateMetadataAccountsV2Helper(_ir)) {
      helpers.push(`/// Metaplex Token Metadata: update_metadata_accounts_v2 (discriminator 15).
/// Hand-rolled invoke for the native target. 2 accounts (metadata writable +
/// update_authority signer). 4 Option fields after the 1-byte disc.
pub fn mpl_update_metadata_accounts_v2<'a>(
    metadata: &AccountInfo<'a>,
    update_authority: &AccountInfo<'a>,
    token_metadata_program: &AccountInfo<'a>,
    new_update_authority: Option<&Pubkey>,
    has_data_update: bool,
    new_name: &str,
    new_symbol: &str,
    new_uri: &str,
    new_seller_fee_basis_points: u16,
    creators: Option<Vec<Creator>>,
    collection: Option<Collection>,
    uses: Option<Uses>,
    primary_sale_happened: Option<bool>,
    is_mutable: Option<bool>,
    signer_seeds: Option<&[&[&[u8]]]>,
) -> ProgramResult {
    let mut data: Vec<u8> =
        Vec::with_capacity(64 + new_name.len() + new_symbol.len() + new_uri.len());
    data.push(15);
    // MPL 5.1.1 UpdateMetadataAccountV2InstructionArgs Borsh field order:
    // data, new_update_authority, primary_sale_happened, is_mutable.
    if has_data_update {
        data.push(1);
        data.extend_from_slice(&(new_name.len() as u32).to_le_bytes());
        data.extend_from_slice(new_name.as_bytes());
        data.extend_from_slice(&(new_symbol.len() as u32).to_le_bytes());
        data.extend_from_slice(new_symbol.as_bytes());
        data.extend_from_slice(&(new_uri.len() as u32).to_le_bytes());
        data.extend_from_slice(new_uri.as_bytes());
        data.extend_from_slice(&new_seller_fee_basis_points.to_le_bytes());
        match creators {
            Some(arr) => {
                data.push(1);
                data.extend_from_slice(&(arr.len() as u32).to_le_bytes());
                for c in arr {
                    data.extend_from_slice(c.address.as_ref());
                    data.push(if c.verified { 1 } else { 0 });
                    data.push(c.share);
                }
            }
            None => data.push(0),
        }
        match collection {
            Some(cc) => {
                data.push(1);
                data.push(if cc.verified { 1 } else { 0 });
                data.extend_from_slice(cc.key.as_ref());
            }
            None => data.push(0),
        }
        match uses {
            Some(u) => {
                data.push(1);
                data.push(match u.use_method {
                    UseMethod::Burn => 0,
                    UseMethod::Multiple => 1,
                    UseMethod::Single => 2,
                });
                data.extend_from_slice(&u.remaining.to_le_bytes());
                data.extend_from_slice(&u.total.to_le_bytes());
            }
            None => data.push(0),
        }
    } else {
        let _ = creators;
        let _ = collection;
        let _ = uses;
        data.push(0);
    }
    match new_update_authority {
        Some(pk) => { data.push(1); data.extend_from_slice(pk.as_ref()); }
        None => data.push(0),
    }
    match primary_sale_happened {
        Some(b) => { data.push(1); data.push(if b { 1 } else { 0 }); }
        None => data.push(0),
    }
    match is_mutable {
        Some(b) => { data.push(1); data.push(if b { 1 } else { 0 }); }
        None => data.push(0),
    }
    let accounts = vec![
        AccountMeta::new(*metadata.key, false),
        AccountMeta::new_readonly(*update_authority.key, true),
    ];
    let ix = Instruction {
        program_id: *token_metadata_program.key,
        accounts,
        data,
    };
    let infos = [metadata.clone(), update_authority.clone()];
    match signer_seeds {
        Some(seeds) => invoke_signed(&ix, &infos, seeds),
        None => invoke(&ix, &infos),
    }
}`);
    }

    if (irNeedsMplVerifyCollectionHelper(_ir)) {
      helpers.push(`/// Metaplex Token Metadata: verify_collection (discriminator 18).
/// Hand-rolled invoke for the native target.
pub fn mpl_verify_collection<'a>(
    metadata: &AccountInfo<'a>,
    collection_authority: &AccountInfo<'a>,
    payer: &AccountInfo<'a>,
    collection_mint: &AccountInfo<'a>,
    collection: &AccountInfo<'a>,
    collection_master_edition: &AccountInfo<'a>,
    token_metadata_program: &AccountInfo<'a>,
    collection_authority_record: Option<&AccountInfo<'a>>,
    signer_seeds: Option<&[&[&[u8]]]>,
) -> ProgramResult {
    let data: Vec<u8> = vec![18];
    let mut accounts = vec![
        AccountMeta::new(*metadata.key, false),
        AccountMeta::new_readonly(*collection_authority.key, true),
        AccountMeta::new(*payer.key, true),
        AccountMeta::new_readonly(*collection_mint.key, false),
        AccountMeta::new_readonly(*collection.key, false),
        AccountMeta::new_readonly(*collection_master_edition.key, false),
    ];
    if let Some(record) = collection_authority_record {
        accounts.push(AccountMeta::new_readonly(*record.key, false));
    }
    let ix = Instruction {
        program_id: *token_metadata_program.key,
        accounts,
        data,
    };
    let mut infos = vec![
        metadata.clone(), collection_authority.clone(), payer.clone(),
        collection_mint.clone(), collection.clone(), collection_master_edition.clone(),
    ];
    if let Some(record) = collection_authority_record {
        infos.push(record.clone());
    }
    match signer_seeds {
        Some(seeds) => invoke_signed(&ix, &infos, seeds),
        None => invoke(&ix, &infos),
    }
}`);
    }

    if (irNeedsMplFreezeDelegatedHelper(_ir)) {
      helpers.push(`/// Metaplex Token Metadata: freeze_delegated_account (discriminator 26).
pub fn mpl_freeze_delegated<'a>(
    delegate: &AccountInfo<'a>,
    token_account: &AccountInfo<'a>,
    edition: &AccountInfo<'a>,
    mint: &AccountInfo<'a>,
    token_program: &AccountInfo<'a>,
    token_metadata_program: &AccountInfo<'a>,
    signer_seeds: Option<&[&[&[u8]]]>,
) -> ProgramResult {
    let data: Vec<u8> = vec![26];
    let accounts = vec![
        AccountMeta::new_readonly(*delegate.key, true),
        AccountMeta::new(*token_account.key, false),
        AccountMeta::new_readonly(*edition.key, false),
        AccountMeta::new_readonly(*mint.key, false),
        AccountMeta::new_readonly(*token_program.key, false),
    ];
    let ix = Instruction { program_id: *token_metadata_program.key, accounts, data };
    let infos = [
        delegate.clone(), token_account.clone(), edition.clone(),
        mint.clone(), token_program.clone(),
    ];
    match signer_seeds {
        Some(seeds) => invoke_signed(&ix, &infos, seeds),
        None => invoke(&ix, &infos),
    }
}`);
    }

    if (irNeedsMplThawDelegatedHelper(_ir)) {
      helpers.push(`/// Metaplex Token Metadata: thaw_delegated_account (discriminator 27).
pub fn mpl_thaw_delegated<'a>(
    delegate: &AccountInfo<'a>,
    token_account: &AccountInfo<'a>,
    edition: &AccountInfo<'a>,
    mint: &AccountInfo<'a>,
    token_program: &AccountInfo<'a>,
    token_metadata_program: &AccountInfo<'a>,
    signer_seeds: Option<&[&[&[u8]]]>,
) -> ProgramResult {
    let data: Vec<u8> = vec![27];
    let accounts = vec![
        AccountMeta::new_readonly(*delegate.key, true),
        AccountMeta::new(*token_account.key, false),
        AccountMeta::new_readonly(*edition.key, false),
        AccountMeta::new_readonly(*mint.key, false),
        AccountMeta::new_readonly(*token_program.key, false),
    ];
    let ix = Instruction { program_id: *token_metadata_program.key, accounts, data };
    let infos = [
        delegate.clone(), token_account.clone(), edition.clone(),
        mint.clone(), token_program.clone(),
    ];
    match signer_seeds {
        Some(seeds) => invoke_signed(&ix, &infos, seeds),
        None => invoke(&ix, &infos),
    }
}`);
    }

    if (irNeedsMplMintNewEditionFromMasterHelper(_ir)) {
      helpers.push(`/// Metaplex Token Metadata: mint_new_edition_from_master_edition_via_token (discriminator 11).
pub fn mpl_mint_new_edition_from_master<'a>(
    new_metadata: &AccountInfo<'a>,
    new_edition: &AccountInfo<'a>,
    master_edition: &AccountInfo<'a>,
    new_mint: &AccountInfo<'a>,
    edition_mark_pda: &AccountInfo<'a>,
    new_mint_authority: &AccountInfo<'a>,
    payer: &AccountInfo<'a>,
    token_account_owner: &AccountInfo<'a>,
    token_account: &AccountInfo<'a>,
    new_metadata_update_authority: &AccountInfo<'a>,
    metadata: &AccountInfo<'a>,
    token_program: &AccountInfo<'a>,
    system_program: &AccountInfo<'a>,
    rent: &AccountInfo<'a>,
    token_metadata_program: &AccountInfo<'a>,
    edition: u64,
    signer_seeds: Option<&[&[&[u8]]]>,
) -> ProgramResult {
    let mut data: Vec<u8> = Vec::with_capacity(9);
    data.push(11);
    data.extend_from_slice(&edition.to_le_bytes());
    // anchor-spl 0.31's mint_new_edition_from_master_edition_via_token
    // wrapper hard-codes \`rent: None\` (sibling pattern). The rent slot
    // is OMITTED from the account list to keep byte-equal with the
    // Anchor reference CPI.
    let _ = rent;
    let accounts = vec![
        AccountMeta::new(*new_metadata.key, false),
        AccountMeta::new(*new_edition.key, false),
        AccountMeta::new(*master_edition.key, false),
        AccountMeta::new(*new_mint.key, false),
        AccountMeta::new(*edition_mark_pda.key, false),
        AccountMeta::new_readonly(*new_mint_authority.key, true),
        AccountMeta::new(*payer.key, true),
        AccountMeta::new_readonly(*token_account_owner.key, true),
        AccountMeta::new_readonly(*token_account.key, false),
        AccountMeta::new_readonly(*new_metadata_update_authority.key, false),
        AccountMeta::new_readonly(*metadata.key, false),
        AccountMeta::new_readonly(*token_program.key, false),
        AccountMeta::new_readonly(*system_program.key, false),
    ];
    let ix = Instruction { program_id: *token_metadata_program.key, accounts, data };
    let infos = [
        new_metadata.clone(), new_edition.clone(), master_edition.clone(),
        new_mint.clone(), edition_mark_pda.clone(), new_mint_authority.clone(),
        payer.clone(), token_account_owner.clone(), token_account.clone(),
        new_metadata_update_authority.clone(), metadata.clone(),
        token_program.clone(), system_program.clone(),
    ];
    match signer_seeds {
        Some(seeds) => invoke_signed(&ix, &infos, seeds),
        None => invoke(&ix, &infos),
    }
}`);
    }

    if (irNeedsMplRevokeCollectionAuthorityHelper(_ir)) {
      helpers.push(`/// Metaplex Token Metadata: revoke_collection_authority (discriminator 24).
pub fn mpl_revoke_collection_authority<'a>(
    collection_authority_record: &AccountInfo<'a>,
    delegate_authority: &AccountInfo<'a>,
    revoke_authority: &AccountInfo<'a>,
    metadata: &AccountInfo<'a>,
    mint: &AccountInfo<'a>,
    token_metadata_program: &AccountInfo<'a>,
    signer_seeds: Option<&[&[&[u8]]]>,
) -> ProgramResult {
    let data: Vec<u8> = vec![24];
    // MPL RevokeCollectionAuthority spec: delegate_authority is writable
    // (writable=true, signer=false) — used in the record PDA close.
    let accounts = vec![
        AccountMeta::new(*collection_authority_record.key, false),
        AccountMeta::new(*delegate_authority.key, false),
        AccountMeta::new(*revoke_authority.key, true),
        AccountMeta::new_readonly(*metadata.key, false),
        AccountMeta::new_readonly(*mint.key, false),
    ];
    let ix = Instruction { program_id: *token_metadata_program.key, accounts, data };
    let infos = [
        collection_authority_record.clone(), delegate_authority.clone(),
        revoke_authority.clone(), metadata.clone(), mint.clone(),
    ];
    match signer_seeds {
        Some(seeds) => invoke_signed(&ix, &infos, seeds),
        None => invoke(&ix, &infos),
    }
}`);
    }

    if (irNeedsMplApproveCollectionAuthorityHelper(_ir)) {
      helpers.push(`/// Metaplex Token Metadata: approve_collection_authority (discriminator 23).
pub fn mpl_approve_collection_authority<'a>(
    collection_authority_record: &AccountInfo<'a>,
    new_collection_authority: &AccountInfo<'a>,
    update_authority: &AccountInfo<'a>,
    payer: &AccountInfo<'a>,
    metadata: &AccountInfo<'a>,
    mint: &AccountInfo<'a>,
    system_program: &AccountInfo<'a>,
    rent: &AccountInfo<'a>,
    token_metadata_program: &AccountInfo<'a>,
    signer_seeds: Option<&[&[&[u8]]]>,
) -> ProgramResult {
    let data: Vec<u8> = vec![23];
    // anchor-spl 0.31's approve_collection_authority wrapper hard-codes
    // \`rent: None\` — the rent slot is OMITTED from the account list.
    let _ = rent;
    let accounts = vec![
        AccountMeta::new(*collection_authority_record.key, false),
        AccountMeta::new_readonly(*new_collection_authority.key, false),
        AccountMeta::new_readonly(*update_authority.key, true),
        AccountMeta::new(*payer.key, true),
        AccountMeta::new_readonly(*metadata.key, false),
        AccountMeta::new_readonly(*mint.key, false),
        AccountMeta::new_readonly(*system_program.key, false),
    ];
    let ix = Instruction { program_id: *token_metadata_program.key, accounts, data };
    let infos = [
        collection_authority_record.clone(), new_collection_authority.clone(),
        update_authority.clone(), payer.clone(), metadata.clone(), mint.clone(),
        system_program.clone(),
    ];
    match signer_seeds {
        Some(seeds) => invoke_signed(&ix, &infos, seeds),
        None => invoke(&ix, &infos),
    }
}`);
    }

    if (irNeedsMplSetAndVerifyCollectionHelper(_ir)) {
      helpers.push(`/// Metaplex Token Metadata: set_and_verify_collection (discriminator 25).
/// Sets DataV2.collection on the metadata + marks it verified in one CPI.
pub fn mpl_set_and_verify_collection<'a>(
    metadata: &AccountInfo<'a>,
    collection_authority: &AccountInfo<'a>,
    payer: &AccountInfo<'a>,
    update_authority: &AccountInfo<'a>,
    collection_mint: &AccountInfo<'a>,
    collection: &AccountInfo<'a>,
    collection_master_edition: &AccountInfo<'a>,
    token_metadata_program: &AccountInfo<'a>,
    collection_authority_record: Option<&AccountInfo<'a>>,
    signer_seeds: Option<&[&[&[u8]]]>,
) -> ProgramResult {
    let data: Vec<u8> = vec![25];
    let mut accounts = vec![
        AccountMeta::new(*metadata.key, false),
        AccountMeta::new_readonly(*collection_authority.key, true),
        AccountMeta::new(*payer.key, true),
        AccountMeta::new_readonly(*update_authority.key, true),
        AccountMeta::new_readonly(*collection_mint.key, false),
        AccountMeta::new_readonly(*collection.key, false),
        AccountMeta::new_readonly(*collection_master_edition.key, false),
    ];
    if let Some(record) = collection_authority_record {
        accounts.push(AccountMeta::new_readonly(*record.key, false));
    }
    let ix = Instruction {
        program_id: *token_metadata_program.key,
        accounts,
        data,
    };
    let mut infos = vec![
        metadata.clone(), collection_authority.clone(), payer.clone(),
        update_authority.clone(), collection_mint.clone(),
        collection.clone(), collection_master_edition.clone(),
    ];
    if let Some(record) = collection_authority_record {
        infos.push(record.clone());
    }
    match signer_seeds {
        Some(seeds) => invoke_signed(&ix, &infos, seeds),
        None => invoke(&ix, &infos),
    }
}`);
    }

    if (irNeedsMplUnverifyCollectionHelper(_ir)) {
      helpers.push(`/// Metaplex Token Metadata: unverify_collection (discriminator 22).
/// Symmetric inverse of verify_collection — removes the verified-
/// collection flag from the metadata.
pub fn mpl_unverify_collection<'a>(
    metadata: &AccountInfo<'a>,
    collection_authority: &AccountInfo<'a>,
    payer: &AccountInfo<'a>,
    collection_mint: &AccountInfo<'a>,
    collection: &AccountInfo<'a>,
    collection_master_edition: &AccountInfo<'a>,
    token_metadata_program: &AccountInfo<'a>,
    collection_authority_record: Option<&AccountInfo<'a>>,
    signer_seeds: Option<&[&[&[u8]]]>,
) -> ProgramResult {
    let data: Vec<u8> = vec![22];
    // mpl-token-metadata 5.1.1 UnverifyCollection has 5 base accounts
    // (NO payer slot — unlike VerifyCollection). Drop from metas + infos.
    let _ = payer;
    let mut accounts = vec![
        AccountMeta::new(*metadata.key, false),
        AccountMeta::new_readonly(*collection_authority.key, true),
        AccountMeta::new_readonly(*collection_mint.key, false),
        AccountMeta::new_readonly(*collection.key, false),
        AccountMeta::new_readonly(*collection_master_edition.key, false),
    ];
    if let Some(record) = collection_authority_record {
        accounts.push(AccountMeta::new_readonly(*record.key, false));
    }
    let ix = Instruction {
        program_id: *token_metadata_program.key,
        accounts,
        data,
    };
    let mut infos = vec![
        metadata.clone(), collection_authority.clone(),
        collection_mint.clone(), collection.clone(), collection_master_edition.clone(),
    ];
    if let Some(record) = collection_authority_record {
        infos.push(record.clone());
    }
    match signer_seeds {
        Some(seeds) => invoke_signed(&ix, &infos, seeds),
        None => invoke(&ix, &infos),
    }
}`);
    }

    if (irNeedsMplCoreCreateV2Helper(_ir)) {
      helpers.push(`/// MPL Core: CreateV2 (discriminator 20).
/// v1 scope: plugins / external_plugin_adapters always None. Kinobi's
/// convention: keep all 8 account slots; substitute the mpl_core program
/// itself (readonly, non-signer) for any None optional.
pub fn mpl_core_create_v2<'a>(
    program: &AccountInfo<'a>,
    asset: &AccountInfo<'a>,
    collection: Option<&AccountInfo<'a>>,
    authority: Option<&AccountInfo<'a>>,
    payer: &AccountInfo<'a>,
    owner: Option<&AccountInfo<'a>>,
    update_authority: Option<&AccountInfo<'a>>,
    system_program: &AccountInfo<'a>,
    log_wrapper: Option<&AccountInfo<'a>>,
    name: &str,
    uri: &str,
    data_state: u8,
    signer_seeds: Option<&[&[&[u8]]]>,
) -> ProgramResult {
    let name_bytes = name.as_bytes();
    let uri_bytes = uri.as_bytes();
    let mut data: Vec<u8> = Vec::with_capacity(1 + 1 + 4 + name_bytes.len() + 4 + uri_bytes.len() + 1 + 1);
    data.push(20);
    data.push(data_state);
    data.extend_from_slice(&(name_bytes.len() as u32).to_le_bytes());
    data.extend_from_slice(name_bytes);
    data.extend_from_slice(&(uri_bytes.len() as u32).to_le_bytes());
    data.extend_from_slice(uri_bytes);
    data.push(0);
    data.push(0);
    let collection_info = collection.unwrap_or(program);
    let authority_info = authority.unwrap_or(program);
    let owner_info = owner.unwrap_or(program);
    let update_authority_info = update_authority.unwrap_or(program);
    let log_wrapper_info = log_wrapper.unwrap_or(program);
    let accounts = vec![
        AccountMeta::new(*asset.key, true),
        if collection.is_some() {
            AccountMeta::new(*collection_info.key, false)
        } else {
            AccountMeta::new_readonly(*collection_info.key, false)
        },
        if authority.is_some() {
            AccountMeta::new_readonly(*authority_info.key, true)
        } else {
            AccountMeta::new_readonly(*authority_info.key, false)
        },
        AccountMeta::new(*payer.key, true),
        AccountMeta::new_readonly(*owner_info.key, false),
        AccountMeta::new_readonly(*update_authority_info.key, false),
        AccountMeta::new_readonly(*system_program.key, false),
        AccountMeta::new_readonly(*log_wrapper_info.key, false),
    ];
    let ix = Instruction {
        program_id: *program.key,
        accounts,
        data,
    };
    let infos = [
        asset.clone(),
        collection_info.clone(),
        authority_info.clone(),
        payer.clone(),
        owner_info.clone(),
        update_authority_info.clone(),
        system_program.clone(),
        log_wrapper_info.clone(),
    ];
    match signer_seeds {
        Some(seeds) => invoke_signed(&ix, &infos, seeds),
        None => invoke(&ix, &infos),
    }
}`);
    }

    if (irNeedsMplCoreAddPluginV1Helper(_ir)) {
      helpers.push(`/// MPL Core: AddPluginV1 (discriminator 2).
pub fn mpl_core_add_plugin_v1<'a>(
    program: &AccountInfo<'a>,
    asset: &AccountInfo<'a>,
    collection: Option<&AccountInfo<'a>>,
    payer: &AccountInfo<'a>,
    authority: Option<&AccountInfo<'a>>,
    system_program: &AccountInfo<'a>,
    log_wrapper: Option<&AccountInfo<'a>>,
    plugin_bytes: &[u8],
    signer_seeds: Option<&[&[&[u8]]]>,
) -> ProgramResult {
    let mut data: Vec<u8> = Vec::with_capacity(1 + plugin_bytes.len() + 1);
    data.push(2);
    data.extend_from_slice(plugin_bytes);
    data.push(0);
    let collection_info = collection.unwrap_or(program);
    let authority_info = authority.unwrap_or(program);
    let log_wrapper_info = log_wrapper.unwrap_or(program);
    let accounts = vec![
        AccountMeta::new(*asset.key, false),
        if collection.is_some() {
            AccountMeta::new(*collection_info.key, false)
        } else {
            AccountMeta::new_readonly(*collection_info.key, false)
        },
        AccountMeta::new(*payer.key, true),
        if authority.is_some() {
            AccountMeta::new_readonly(*authority_info.key, true)
        } else {
            AccountMeta::new_readonly(*authority_info.key, false)
        },
        AccountMeta::new_readonly(*system_program.key, false),
        AccountMeta::new_readonly(*log_wrapper_info.key, false),
    ];
    let ix = Instruction { program_id: *program.key, accounts, data };
    let infos = [asset.clone(), collection_info.clone(), payer.clone(), authority_info.clone(), system_program.clone(), log_wrapper_info.clone()];
    match signer_seeds {
        Some(seeds) => invoke_signed(&ix, &infos, seeds),
        None => invoke(&ix, &infos),
    }
}`);
    }

    if (irNeedsMplCoreRemovePluginV1Helper(_ir)) {
      helpers.push(`/// MPL Core: RemovePluginV1 (discriminator 4).
pub fn mpl_core_remove_plugin_v1<'a>(
    program: &AccountInfo<'a>,
    asset: &AccountInfo<'a>,
    collection: Option<&AccountInfo<'a>>,
    payer: &AccountInfo<'a>,
    authority: Option<&AccountInfo<'a>>,
    system_program: &AccountInfo<'a>,
    log_wrapper: Option<&AccountInfo<'a>>,
    plugin_type_disc: u8,
    signer_seeds: Option<&[&[&[u8]]]>,
) -> ProgramResult {
    let data: Vec<u8> = vec![4, plugin_type_disc];
    let collection_info = collection.unwrap_or(program);
    let authority_info = authority.unwrap_or(program);
    let log_wrapper_info = log_wrapper.unwrap_or(program);
    let accounts = vec![
        AccountMeta::new(*asset.key, false),
        if collection.is_some() {
            AccountMeta::new(*collection_info.key, false)
        } else {
            AccountMeta::new_readonly(*collection_info.key, false)
        },
        AccountMeta::new(*payer.key, true),
        if authority.is_some() {
            AccountMeta::new_readonly(*authority_info.key, true)
        } else {
            AccountMeta::new_readonly(*authority_info.key, false)
        },
        AccountMeta::new_readonly(*system_program.key, false),
        AccountMeta::new_readonly(*log_wrapper_info.key, false),
    ];
    let ix = Instruction { program_id: *program.key, accounts, data };
    let infos = [asset.clone(), collection_info.clone(), payer.clone(), authority_info.clone(), system_program.clone(), log_wrapper_info.clone()];
    match signer_seeds {
        Some(seeds) => invoke_signed(&ix, &infos, seeds),
        None => invoke(&ix, &infos),
    }
}`);
    }

    if (irNeedsMplCoreUpdatePluginV1Helper(_ir)) {
      helpers.push(`/// MPL Core: UpdatePluginV1 (discriminator 6).
pub fn mpl_core_update_plugin_v1<'a>(
    program: &AccountInfo<'a>,
    asset: &AccountInfo<'a>,
    collection: Option<&AccountInfo<'a>>,
    payer: &AccountInfo<'a>,
    authority: Option<&AccountInfo<'a>>,
    system_program: &AccountInfo<'a>,
    log_wrapper: Option<&AccountInfo<'a>>,
    plugin_bytes: &[u8],
    signer_seeds: Option<&[&[&[u8]]]>,
) -> ProgramResult {
    let mut data: Vec<u8> = Vec::with_capacity(1 + plugin_bytes.len());
    data.push(6);
    data.extend_from_slice(plugin_bytes);
    let collection_info = collection.unwrap_or(program);
    let authority_info = authority.unwrap_or(program);
    let log_wrapper_info = log_wrapper.unwrap_or(program);
    let accounts = vec![
        AccountMeta::new(*asset.key, false),
        if collection.is_some() {
            AccountMeta::new(*collection_info.key, false)
        } else {
            AccountMeta::new_readonly(*collection_info.key, false)
        },
        AccountMeta::new(*payer.key, true),
        if authority.is_some() {
            AccountMeta::new_readonly(*authority_info.key, true)
        } else {
            AccountMeta::new_readonly(*authority_info.key, false)
        },
        AccountMeta::new_readonly(*system_program.key, false),
        AccountMeta::new_readonly(*log_wrapper_info.key, false),
    ];
    let ix = Instruction { program_id: *program.key, accounts, data };
    let infos = [asset.clone(), collection_info.clone(), payer.clone(), authority_info.clone(), system_program.clone(), log_wrapper_info.clone()];
    match signer_seeds {
        Some(seeds) => invoke_signed(&ix, &infos, seeds),
        None => invoke(&ix, &infos),
    }
}`);
    }

    if (irNeedsMplCoreApprovePluginAuthorityV1Helper(_ir)) {
      helpers.push(`/// MPL Core: ApprovePluginAuthorityV1 (discriminator 8).
pub fn mpl_core_approve_plugin_authority_v1<'a>(
    program: &AccountInfo<'a>,
    asset: &AccountInfo<'a>,
    collection: Option<&AccountInfo<'a>>,
    payer: &AccountInfo<'a>,
    authority: Option<&AccountInfo<'a>>,
    system_program: &AccountInfo<'a>,
    log_wrapper: Option<&AccountInfo<'a>>,
    plugin_type_disc: u8,
    new_authority_disc: u8,
    signer_seeds: Option<&[&[&[u8]]]>,
) -> ProgramResult {
    let data: Vec<u8> = vec![8, plugin_type_disc, new_authority_disc];
    let collection_info = collection.unwrap_or(program);
    let authority_info = authority.unwrap_or(program);
    let log_wrapper_info = log_wrapper.unwrap_or(program);
    let accounts = vec![
        AccountMeta::new(*asset.key, false),
        if collection.is_some() {
            AccountMeta::new(*collection_info.key, false)
        } else {
            AccountMeta::new_readonly(*collection_info.key, false)
        },
        AccountMeta::new(*payer.key, true),
        if authority.is_some() {
            AccountMeta::new_readonly(*authority_info.key, true)
        } else {
            AccountMeta::new_readonly(*authority_info.key, false)
        },
        AccountMeta::new_readonly(*system_program.key, false),
        AccountMeta::new_readonly(*log_wrapper_info.key, false),
    ];
    let ix = Instruction { program_id: *program.key, accounts, data };
    let infos = [asset.clone(), collection_info.clone(), payer.clone(), authority_info.clone(), system_program.clone(), log_wrapper_info.clone()];
    match signer_seeds {
        Some(seeds) => invoke_signed(&ix, &infos, seeds),
        None => invoke(&ix, &infos),
    }
}`);
    }

    if (irNeedsMplCoreRevokePluginAuthorityV1Helper(_ir)) {
      helpers.push(`/// MPL Core: RevokePluginAuthorityV1 (discriminator 10).
pub fn mpl_core_revoke_plugin_authority_v1<'a>(
    program: &AccountInfo<'a>,
    asset: &AccountInfo<'a>,
    collection: Option<&AccountInfo<'a>>,
    payer: &AccountInfo<'a>,
    authority: Option<&AccountInfo<'a>>,
    system_program: &AccountInfo<'a>,
    log_wrapper: Option<&AccountInfo<'a>>,
    plugin_type_disc: u8,
    signer_seeds: Option<&[&[&[u8]]]>,
) -> ProgramResult {
    let data: Vec<u8> = vec![10, plugin_type_disc];
    let collection_info = collection.unwrap_or(program);
    let authority_info = authority.unwrap_or(program);
    let log_wrapper_info = log_wrapper.unwrap_or(program);
    let accounts = vec![
        AccountMeta::new(*asset.key, false),
        if collection.is_some() {
            AccountMeta::new(*collection_info.key, false)
        } else {
            AccountMeta::new_readonly(*collection_info.key, false)
        },
        AccountMeta::new(*payer.key, true),
        if authority.is_some() {
            AccountMeta::new_readonly(*authority_info.key, true)
        } else {
            AccountMeta::new_readonly(*authority_info.key, false)
        },
        AccountMeta::new_readonly(*system_program.key, false),
        AccountMeta::new_readonly(*log_wrapper_info.key, false),
    ];
    let ix = Instruction { program_id: *program.key, accounts, data };
    let infos = [asset.clone(), collection_info.clone(), payer.clone(), authority_info.clone(), system_program.clone(), log_wrapper_info.clone()];
    match signer_seeds {
        Some(seeds) => invoke_signed(&ix, &infos, seeds),
        None => invoke(&ix, &infos),
    }
}`);
    }

    if (irNeedsMplCoreCreateCollectionV2Helper(_ir)) {
      helpers.push(`/// MPL Core: CreateCollectionV2 (discriminator 21).
/// 4 accounts, no log_wrapper. v1 scope: plugins / external_plugin_adapters both None.
pub fn mpl_core_create_collection_v2<'a>(
    program: &AccountInfo<'a>,
    collection: &AccountInfo<'a>,
    update_authority: Option<&AccountInfo<'a>>,
    payer: &AccountInfo<'a>,
    system_program: &AccountInfo<'a>,
    name: &str,
    uri: &str,
    signer_seeds: Option<&[&[&[u8]]]>,
) -> ProgramResult {
    let name_bytes = name.as_bytes();
    let uri_bytes = uri.as_bytes();
    let mut data: Vec<u8> = Vec::with_capacity(1 + 4 + name_bytes.len() + 4 + uri_bytes.len() + 1 + 1);
    data.push(21);
    data.extend_from_slice(&(name_bytes.len() as u32).to_le_bytes());
    data.extend_from_slice(name_bytes);
    data.extend_from_slice(&(uri_bytes.len() as u32).to_le_bytes());
    data.extend_from_slice(uri_bytes);
    data.push(0);
    data.push(0);
    let update_authority_info = update_authority.unwrap_or(program);
    let accounts = vec![
        AccountMeta::new(*collection.key, true),
        AccountMeta::new_readonly(*update_authority_info.key, false),
        AccountMeta::new(*payer.key, true),
        AccountMeta::new_readonly(*system_program.key, false),
    ];
    let ix = Instruction {
        program_id: *program.key,
        accounts,
        data,
    };
    let infos = [
        collection.clone(),
        update_authority_info.clone(),
        payer.clone(),
        system_program.clone(),
    ];
    match signer_seeds {
        Some(seeds) => invoke_signed(&ix, &infos, seeds),
        None => invoke(&ix, &infos),
    }
}`);
    }

    if (irNeedsMplCoreBurnV1Helper(_ir)) {
      helpers.push(`/// MPL Core: BurnV1 (discriminator 12).
/// v1 scope: compression_proof always None.
pub fn mpl_core_burn_v1<'a>(
    program: &AccountInfo<'a>,
    asset: &AccountInfo<'a>,
    collection: Option<&AccountInfo<'a>>,
    payer: &AccountInfo<'a>,
    authority: Option<&AccountInfo<'a>>,
    system_program: &AccountInfo<'a>,
    log_wrapper: Option<&AccountInfo<'a>>,
    signer_seeds: Option<&[&[&[u8]]]>,
) -> ProgramResult {
    let data: Vec<u8> = vec![12, 0];
    let collection_info = collection.unwrap_or(program);
    let authority_info = authority.unwrap_or(program);
    let log_wrapper_info = log_wrapper.unwrap_or(program);
    let accounts = vec![
        AccountMeta::new(*asset.key, false),
        if collection.is_some() {
            AccountMeta::new(*collection_info.key, false)
        } else {
            AccountMeta::new_readonly(*collection_info.key, false)
        },
        AccountMeta::new(*payer.key, true),
        if authority.is_some() {
            AccountMeta::new_readonly(*authority_info.key, true)
        } else {
            AccountMeta::new_readonly(*authority_info.key, false)
        },
        AccountMeta::new_readonly(*system_program.key, false),
        AccountMeta::new_readonly(*log_wrapper_info.key, false),
    ];
    let ix = Instruction {
        program_id: *program.key,
        accounts,
        data,
    };
    let infos = [
        asset.clone(),
        collection_info.clone(),
        payer.clone(),
        authority_info.clone(),
        system_program.clone(),
        log_wrapper_info.clone(),
    ];
    match signer_seeds {
        Some(seeds) => invoke_signed(&ix, &infos, seeds),
        None => invoke(&ix, &infos),
    }
}`);
    }

    if (irNeedsMplCoreTransferV1Helper(_ir)) {
      helpers.push(`/// MPL Core: TransferV1 (discriminator 14).
/// v1 scope: compression_proof always None.
pub fn mpl_core_transfer_v1<'a>(
    program: &AccountInfo<'a>,
    asset: &AccountInfo<'a>,
    collection: Option<&AccountInfo<'a>>,
    payer: &AccountInfo<'a>,
    authority: Option<&AccountInfo<'a>>,
    new_owner: &AccountInfo<'a>,
    system_program: &AccountInfo<'a>,
    log_wrapper: Option<&AccountInfo<'a>>,
    signer_seeds: Option<&[&[&[u8]]]>,
) -> ProgramResult {
    let data: Vec<u8> = vec![14, 0];
    let collection_info = collection.unwrap_or(program);
    let authority_info = authority.unwrap_or(program);
    let log_wrapper_info = log_wrapper.unwrap_or(program);
    let accounts = vec![
        AccountMeta::new(*asset.key, false),
        AccountMeta::new_readonly(*collection_info.key, false),
        AccountMeta::new(*payer.key, true),
        if authority.is_some() {
            AccountMeta::new_readonly(*authority_info.key, true)
        } else {
            AccountMeta::new_readonly(*authority_info.key, false)
        },
        AccountMeta::new_readonly(*new_owner.key, false),
        AccountMeta::new_readonly(*system_program.key, false),
        AccountMeta::new_readonly(*log_wrapper_info.key, false),
    ];
    let ix = Instruction {
        program_id: *program.key,
        accounts,
        data,
    };
    let infos = [
        asset.clone(),
        collection_info.clone(),
        payer.clone(),
        authority_info.clone(),
        new_owner.clone(),
        system_program.clone(),
        log_wrapper_info.clone(),
    ];
    match signer_seeds {
        Some(seeds) => invoke_signed(&ix, &infos, seeds),
        None => invoke(&ix, &infos),
    }
}`);
    }

    if (irNeedsMplCoreUpdateV2Helper(_ir)) {
      helpers.push(`/// MPL Core: UpdateV2 (discriminator 30).
/// v1 scope: new_update_authority always None.
pub fn mpl_core_update_v2<'a>(
    program: &AccountInfo<'a>,
    asset: &AccountInfo<'a>,
    collection: Option<&AccountInfo<'a>>,
    payer: &AccountInfo<'a>,
    authority: Option<&AccountInfo<'a>>,
    new_collection: Option<&AccountInfo<'a>>,
    system_program: &AccountInfo<'a>,
    log_wrapper: Option<&AccountInfo<'a>>,
    new_name: Option<&str>,
    new_uri: Option<&str>,
    signer_seeds: Option<&[&[&[u8]]]>,
) -> ProgramResult {
    let mut data: Vec<u8> = Vec::with_capacity(64);
    data.push(30);
    match new_name {
        Some(s) => {
            data.push(1);
            data.extend_from_slice(&(s.len() as u32).to_le_bytes());
            data.extend_from_slice(s.as_bytes());
        }
        None => data.push(0),
    }
    match new_uri {
        Some(s) => {
            data.push(1);
            data.extend_from_slice(&(s.len() as u32).to_le_bytes());
            data.extend_from_slice(s.as_bytes());
        }
        None => data.push(0),
    }
    data.push(0);
    let collection_info = collection.unwrap_or(program);
    let authority_info = authority.unwrap_or(program);
    let new_collection_info = new_collection.unwrap_or(program);
    let log_wrapper_info = log_wrapper.unwrap_or(program);
    let accounts = vec![
        AccountMeta::new(*asset.key, false),
        if collection.is_some() {
            AccountMeta::new(*collection_info.key, false)
        } else {
            AccountMeta::new_readonly(*collection_info.key, false)
        },
        AccountMeta::new(*payer.key, true),
        if authority.is_some() {
            AccountMeta::new_readonly(*authority_info.key, true)
        } else {
            AccountMeta::new_readonly(*authority_info.key, false)
        },
        if new_collection.is_some() {
            AccountMeta::new(*new_collection_info.key, false)
        } else {
            AccountMeta::new_readonly(*new_collection_info.key, false)
        },
        AccountMeta::new_readonly(*system_program.key, false),
        AccountMeta::new_readonly(*log_wrapper_info.key, false),
    ];
    let ix = Instruction {
        program_id: *program.key,
        accounts,
        data,
    };
    let infos = [
        asset.clone(),
        collection_info.clone(),
        payer.clone(),
        authority_info.clone(),
        new_collection_info.clone(),
        system_program.clone(),
        log_wrapper_info.clone(),
    ];
    match signer_seeds {
        Some(seeds) => invoke_signed(&ix, &infos, seeds),
        None => invoke(&ix, &infos),
    }
}`);
    }

    if (irNeedsMplSignMetadataHelper(_ir)) {
      helpers.push(`/// Metaplex Token Metadata: sign_metadata (discriminator 7).
pub fn mpl_sign_metadata<'a>(
    metadata: &AccountInfo<'a>,
    creator: &AccountInfo<'a>,
    token_metadata_program: &AccountInfo<'a>,
    signer_seeds: Option<&[&[&[u8]]]>,
) -> ProgramResult {
    let data: Vec<u8> = vec![7];
    let accounts = vec![
        AccountMeta::new(*metadata.key, false),
        AccountMeta::new_readonly(*creator.key, true),
    ];
    let ix = Instruction {
        program_id: *token_metadata_program.key,
        accounts,
        data,
    };
    let infos = [metadata.clone(), creator.clone()];
    match signer_seeds {
        Some(seeds) => invoke_signed(&ix, &infos, seeds),
        None => invoke(&ix, &infos),
    }
}`);
    }

    if (irNeedsT22ConfidentialTransferInitMintHelper(_ir)) {
      helpers.push(`/// Token-2022 Confidential Transfer extension: initialize_mint.
pub fn t22_confidential_transfer_initialize_mint<'a>(
    mint: &AccountInfo<'a>,
    token_program: &AccountInfo<'a>,
    authority: Option<Pubkey>,
    auto_approve_new_accounts: bool,
    auditor_elgamal_pubkey: Option<[u8; 32]>,
    signer_seeds: Option<&[&[&[u8]]]>,
) -> ProgramResult {
    let mut d = [0u8; 67];
    d[0] = 27;
    d[1] = 0;
    if let Some(a) = authority {
        d[2..34].copy_from_slice(a.as_ref());
    }
    d[34] = if auto_approve_new_accounts { 1 } else { 0 };
    if let Some(e) = auditor_elgamal_pubkey {
        d[35..67].copy_from_slice(&e);
    }
    let accounts = vec![AccountMeta::new(*mint.key, false)];
    let ix = Instruction { program_id: *token_program.key, accounts, data: d.to_vec() };
    let infos = [mint.clone()];
    match signer_seeds {
        Some(seeds) => invoke_signed(&ix, &infos, seeds),
        None => invoke(&ix, &infos),
    }
}`);
    }

    if (irNeedsT22ConfidentialTransferFeeInitHelper(_ir)) {
      helpers.push(`/// Token-2022 ConfidentialTransferFee extension: init config.
pub fn t22_confidential_transfer_fee_init<'a>(
    mint: &AccountInfo<'a>,
    token_program: &AccountInfo<'a>,
    authority: Option<Pubkey>,
    withdraw_withheld_authority_elgamal_pubkey: [u8; 32],
    signer_seeds: Option<&[&[&[u8]]]>,
) -> ProgramResult {
    let mut d = [0u8; 66];
    d[0] = 37;
    d[1] = 0;
    if let Some(a) = authority {
        d[2..34].copy_from_slice(a.as_ref());
    }
    d[34..66].copy_from_slice(&withdraw_withheld_authority_elgamal_pubkey);
    let accounts = vec![AccountMeta::new(*mint.key, false)];
    let ix = Instruction { program_id: *token_program.key, accounts, data: d.to_vec() };
    let infos = [mint.clone()];
    match signer_seeds {
        Some(seeds) => invoke_signed(&ix, &infos, seeds),
        None => invoke(&ix, &infos),
    }
}`);
    }

    if (irNeedsT22ConfidentialMintBurnInitMintHelper(_ir)) {
      helpers.push(`/// Token-2022 ConfidentialMintBurn extension: initialize_mint.
pub fn t22_confidential_mint_burn_initialize_mint<'a>(
    mint: &AccountInfo<'a>,
    token_program: &AccountInfo<'a>,
    supply_elgamal_pubkey: [u8; 32],
    decryptable_supply: [u8; 36],
    signer_seeds: Option<&[&[&[u8]]]>,
) -> ProgramResult {
    let mut d = [0u8; 70];
    d[0] = 42;
    d[1] = 0;
    d[2..34].copy_from_slice(&supply_elgamal_pubkey);
    d[34..70].copy_from_slice(&decryptable_supply);
    let accounts = vec![AccountMeta::new(*mint.key, false)];
    let ix = Instruction { program_id: *token_program.key, accounts, data: d.to_vec() };
    let infos = [mint.clone()];
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
  // G38 — generic line-level dedup pass first. Catches duplicate full-line
  // `use ... as Alias;` imports (e.g. `solana_program::sysvar::instructions::
  // Instructions as SysInstructions` emitted twice by source-filter +
  // auto-import) and any other identical `use` line. The structural pass
  // below handles per-leaf collapsing within `solana_program::{ ... }`.
  {
    const seenLines = new Set<string>();
    const out: string[] = [];
    for (const rawLine of joined.split("\n")) {
      const trimmed = rawLine.trim();
      if (/^use\s+/.test(trimmed)) {
        if (seenLines.has(trimmed)) continue;
        seenLines.add(trimmed);
      }
      out.push(rawLine);
    }
    joined = out.join("\n");
  }
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
  // Strip line and block comments before scanning so types that appear
  // ONLY inside the T22 commentout pass's // — ⚠️ Anvil … blocks don't
  // trigger phantom auto-imports (which would then fail at module level
  // because the underlying crate, e.g. spl_pod, isn't in scaffold deps).
  const liveCode = allCarriedText
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/[^\n]*/g, (_m, before: string) => before);
  const has = (re: RegExp) => re.test(liveCode);

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
    // OptionalNonZeroPubkey lives at spl_pod::optional_keys, but spl_pod
    // isn't in Native's scaffold deps. Native emit code never produces a
    // direct OptionalNonZeroPubkey reference (the typed IR for T22
    // pointer-init/update hand-rolls the bytes); the only triggers were
    // source pass-through chains that the Native T22 commentout pass now
    // wraps as comments. Don't auto-add — if a user genuinely needs it
    // they must scaffold spl_pod themselves.
    // { ident: "OptionalNonZeroPubkey", path: "spl_pod::optional_keys::OptionalNonZeroPubkey" },
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

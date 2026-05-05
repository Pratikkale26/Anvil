/**
 * Emitter Base — Shared foundation for all target framework emitters.
 *
 * Provides:
 *   - Abstract interface that each framework emitter implements
 *   - Generic instruction body emitter that walks BodyStatements and
 *     calls framework-specific transform functions for TRANSFORM ops,
 *     while passing through pure Rust code unchanged.
 *   - Multi-file output generation (lib.rs, state.rs, instructions/, errors.rs)
 *
 * Utility functions, IR helpers, body walking, and anchor transforms are
 * factored into separate modules and re-exported from here for backward
 * compatibility.
 */

import type {
  SolanaIR,
  AccountDef,
  Instruction,
  Arg,
  BodyStatement,
  EmitterOutput,
  EmitterFile,
  TypeDef,
} from "../ir/schema.js";

// ─── Re-export utilities for backward compatibility ──────────────────────────

export {
  instrDiscriminator,
  accountDiscriminator,
  eventDiscriminator,
  discriminatorBytes,
  formatByteArray,
  isProgramAccount,
  isCheckedArithmeticType,
  typeSize,
  parseFixedArrayType,
  resolveConstExprValue,
  snakeCase,
  toPascalCase,
  capitalize,
  cleanInlineExpr,
  stripAnchorConstraintError,
  indentBlock,
  trimOuterParens,
  unwrapTopLevelNegation,
  normalizeConditionKey,
  emitRequireGuard,
  simplifyPassThroughCode,
} from "./emitter-utils.js";

export {
  irNeedsHelper,
  irNeedsUnsignedLamportsHelper,
  irNeedsSignedLamportsHelper,
  irNeedsTokenAmountHelper,
  irNeedsUnsignedSplMintToHelper,
  irNeedsSignedSplMintToHelper,
  irNeedsUnsignedSplBurnHelper,
  irNeedsSignedSplBurnHelper,
  irNeedsSignedSplCloseAccountHelper,
  irNeedsUnsignedSplCloseAccountHelper,
  irNeedsInitAccountHelper,
  irNeedsToken2022Helper,
  irNeedsAtaCreationHelper,
  hasResidualAnchorPatterns,
  hasUnsalvageableHelperSignature,
} from "./emitter-helpers.js";

import { hasResidualAnchorPatterns, hasUnsalvageableHelperSignature } from "./emitter-helpers.js";

// ─── Internal imports ────────────────────────────────────────────────────────

import {
  snakeCase,
  toPascalCase,
  isProgramAccount,
  cleanInlineExpr,
  stripAnchorConstraintError,
  emitRequireGuard,
  typeSize,
  parseFixedArrayType,
  resolveConstExprValue,
  accountDiscriminator,
  eventDiscriminator,
} from "./emitter-utils.js";
import {
  emitBodyStatements as emitBodyStatementsImpl,
  type BodyEmitterContext,
  type BodyEmitterCallbacks,
  type Token2022Opts,
} from "./body-emitter/index.js";
import { transformHelperCode as transformHelperCodeImpl } from "./anchor-transforms.js";
import {
  commentOutHelperBlock,
  commentOutUnsalvageableCallSites,
  stripTrailingOffsetBump,
  prefixUnusedProphylacticBindings,
  promoteFreeFnVisibility,
} from "./emitter-base-utils.js";

// ─── Abstract Emitter Interface ──────────────────────────────────────────────

export abstract class BaseEmitter {
  abstract readonly frameworkName: string;
  protected currentIr: SolanaIR | null = null;

  /** Warnings accumulated during emission */
  protected warnings: string[] = [];
  protected transformedCount = 0;
  protected passedThroughCount = 0;
  protected details: string[] = [];
  /**
   * Helpers whose signature/body uses Anchor-only types we can't transpile
   * (`InterfaceAccount`, `Interface<TokenInterface>`, `Box<Account>`, etc.).
   * Computed in `emit()` and consumed by `emitHelpersFile` (skipped) and
   * `emitInstructionFile` (call sites commented out). Same compile-clean
   * fallback the Metaplex-stub commentout uses for unsupported CPIs.
   */
  protected unsalvageableHelpers: Set<string> = new Set();

  // ── Framework-specific methods (MUST override) ──

  abstract emitUseStatements(ir: SolanaIR): string;
  abstract emitEntrypoint(ir: SolanaIR): string;
  abstract emitRouter(ir: SolanaIR): string;
  abstract emitAccountStruct(acc: AccountDef): string;
  abstract emitErrorEnum(ir: SolanaIR): string;

  // ── Account access patterns ──
  abstract emitAccountBinding(name: string, index: number): string;
  abstract emitSignerCheck(name: string): string;
  abstract emitOwnerCheck(name: string): string;
  abstract emitWritableCheck(names: string[]): string;
  abstract emitAccountKeyExpr(accountName: string): string;
  abstract emitAccountKeyAsRefExpr(accountName: string): string;
  abstract emitAccountLamportsExpr(accountName: string): string;
  abstract emitStateRead(accountName: string, typeName: string, localVar: string, mutable: boolean): string;
  abstract emitStateSave(accountName: string, typeName: string, localVar: string): string;
  abstract emitBumpSeed(programId: string, seeds: string[], expectedKey: string): string;

  // ── CPI transforms ──
  abstract emitSystemTransfer(from: string, to: string, amount: string, signerSeeds?: string): string;
  abstract emitSplTransfer(from: string, to: string, authority: string, amount: string, signerSeeds?: string, opts?: Token2022Opts): string;
  abstract emitSplMintTo(mint: string, to: string, authority: string, amount: string, signerSeeds?: string, opts?: Token2022Opts): string;
  abstract emitSplBurn(from: string, mint: string, authority: string, amount: string, signerSeeds?: string, opts?: Token2022Opts): string;
  abstract emitSplCloseAccount(account: string, destination: string, authority: string, signerSeeds?: string, opts?: Token2022Opts): string;
  abstract emitSplSetAuthority(account: string, currentAuthority: string, authorityType: string, newAuthority: string, signerSeeds?: string, opts?: Token2022Opts): string;
  abstract emitProgramAccountClose(account: string, destination: string): string;
  abstract emitCreateProgramAccount(
    account: string,
    payer: string,
    spaceExpr: string,
    signerSeeds?: string,
  ): string;

  // ── ATA creation ──
  abstract emitCreateAta(
    ata: string,
    payer: string,
    mint: string,
    authority: string,
    signerSeeds?: string,
  ): string;

  /**
   * Init a non-ATA token account from `init token::mint = X, token::authority = Y`.
   * Two CPIs: system::create_account (165 bytes, owner=token_program) +
   * Token::initialize_account3 (binds mint + authority). Sibling of
   * emitCreateAta — different macro path in Anchor, different CPI sequence.
   */
  abstract emitCreateTokenAccount(
    account: string,
    payer: string,
    mint: string,
    authority: string,
    signerSeeds?: string,
  ): string;

  // ── Memo CPI ──
  abstract emitMemo(data: string, signerSeeds?: string): string;

  // ── PDA signer seeds ──
  abstract emitPdaSignerSeeds(
    account: string,
    accountInfoVar: string,
    seeds: string[],
    bumpField?: string,
    stateVar?: string,
    typeName?: string,
  ): string;

  // ── Macro transforms ──
  abstract emitRequire(condition: string, error: string): string;
  abstract emitMsg(message: string): string;
  abstract emitEmit(event: string, fields: string): string;

  // ── Sysvar transforms ──
  abstract emitClockGet(localVar: string): string;
  abstract emitRentGet(localVar: string): string;

  // ── Type mapping ──
  abstract rustTypeForFramework(typeName: string): string;

  // ── Helpers that the framework might need ──
  abstract emitHelperFunctions(ir: SolanaIR): string;

  /**
   * Hook for target-specific post-processing of an instruction's assembled body.
   *
   * Default: identity. Native + pinocchio override to inject a `Mint::unpack`-style
   * prelude when bare `<account>.decimals` references survive from the Anchor
   * source — neither target's `AccountInfo` exposes a `.decimals` field, so the
   * pass-through emit produces E0609 without intervention.
   */
  protected postProcessInstructionBody(
    bodyCode: string,
    _instr: Instruction,
    _ir: SolanaIR,
  ): string {
    return bodyCode;
  }

  /**
   * Emit a system program create_account CPI.
   * Default implementation emits a generic invoke() call.
   * Framework-specific emitters can override for native helpers.
   */
  emitCreateAccountCpi(
    from: string,
    to: string,
    lamports: string,
    space: string,
    owner: string,
  ): string {
    return `// System Program: create_account\n    invoke(\n        &system_instruction::create_account(\n            ${from}.key,\n            ${to}.key,\n            ${lamports},\n            ${space} as u64,\n            ${owner},\n        ),\n        &[${from}.clone(), ${to}.clone()],\n    )?;`;
  }

  /**
   * Transform an amount expression from Anchor-style to target framework.
   * Handles patterns like:
   *   - "vault.amount" → "token_account_amount(vault)?" (Pinocchio)
   *   - "maker_ata_a.amount" → "token_account_amount(maker_ata_a)?" (Pinocchio)
   *   - raw numbers/variables pass through unchanged
   * Subclasses can override for framework-specific behavior.
   */
  transformAmountExpr(amount: string): string {
    // Pattern: X.amount → token account read
    const tokenAmountMatch = amount.match(/^(\w+)\.amount$/);
    if (tokenAmountMatch?.[1]) {
      return `token_account_amount(${snakeCase(tokenAmountMatch[1])})?`;
    }
    return amount;
  }

  protected filteredSourceImports(ir: SolanaIR): string[] {
    // Native target ships solana-program + can pull in additional crates via
    // project-scaffold's NATIVE_OPTIONAL_DEPS. So `mpl_core`, `pyth_*` etc.
    // are kept; only Anchor-internals (which we replaced with hand-written
    // emit) and project-internal modules (`crate::`, `self::`, ...) are
    // stripped. Pinocchio still drops external-Solana crates because its
    // Cargo.toml doesn't ship those deps.
    const isNative = this.frameworkName === "Native";
    return (ir.imports ?? [])
      .map((statement) => {
        const trimmed = statement.trim().replace(/;$/, "");
        const normalized = trimmed.startsWith("use ") || trimmed.startsWith("pub use ")
          ? `${trimmed};`
          : `use ${trimmed};`;
        // Anchor re-exports solana-program, so users often write
        // `use anchor_lang::solana_program::instruction::Instruction;`.
        // The anchor_lang filter below would strip that, leaving the
        // referenced types undefined. Rewrite to `use solana_program::...`
        // so they resolve against the target's solana-program dep
        // (native ships it; pinocchio doesn't, so the rewrite survives
        // for native and gets dropped by the pinocchio filter below).
        const rewritten = normalized.replace(
          /\banchor_lang\s*::\s*solana_program\b/g,
          "solana_program",
        );
        // Skip rewritten Clock / Rent imports — the native emitter adds
        // those automatically when sysvar usage is detected, and a second
        // import for the same type triggers E0252 (defined multiple times).
        if (/^use\s+solana_program::(?:sysvar::)?clock::Clock\s*;?$/.test(rewritten.trim())) return "";
        if (/^use\s+solana_program::(?:sysvar::)?rent::Rent\s*;?$/.test(rewritten.trim())) return "";
        return rewritten;
      })
      .filter((stmt) => stmt.length > 0)
      .filter((statement) => {
        if (statement.startsWith("use anchor_lang::")) return false;
        // Filter out `use { anchor_lang::..., anchor_spl::... }` block imports
        if (/^use\s*\{[\s\S]*\banchor_lang::/.test(statement)) return false;
        // Filter out imports from external Anchor crates that leak through
        if (/\banchor_lang\b/.test(statement)) return false;
        if (statement.startsWith("use crate::")) return false;
        if (statement.startsWith("use self::")) return false;
        if (statement.startsWith("use super::")) return false;
        if (statement.startsWith("use instructions::")) return false;
        if (statement.startsWith("use state::")) return false;
        if (statement.startsWith("use error::")) return false;
        if (statement.startsWith("use errors::")) return false;
        if (statement.startsWith("use hash::")) return false;
        if (statement.startsWith("pub use ")) return false;
        // anchor_spl always filtered: the CPI transformer rewrites the actual
        // call sites (e.g., `anchor_spl::token::transfer(...)`) into native
        // SPL helpers, so the import isn't needed in any target.
        if (statement.startsWith("use anchor_spl::")) return false;
        if (/^use\s*\{[\s\S]*\banchor_spl::/.test(statement)) return false;
        if (/\banchor_spl\b/.test(statement)) return false;
        // Sibling Anchor program imports — `use <crate>::cpi::*`,
        // `<crate>::accounts::*`, `<crate>::program::*` are Anchor's
        // auto-generated cross-program-invocation surface for a sibling
        // program in the same workspace. The standalone Anvil emit doesn't
        // ship those crates, and the corresponding CPI call sites in the
        // body are emitted as TODO stubs (see pass-through.ts handler).
        // Drop the imports so the file compiles. Affects fixtures like
        // cpi-hand → cpi-lever.
        if (/^use\s+\w+::(?:cpi|accounts|program)(?:::|;)/.test(statement)) return false;
        // solana_program imports are valid on native (which deps it) but
        // not on pinocchio (which uses its own crate). Drop on
        // non-native. The anchor_lang::solana_program rewrite above means
        // a source `use anchor_lang::solana_program::X;` lands here as
        // `use solana_program::X;` and gets correctly stripped on those
        // targets while surviving on native.
        if (!isNative && /^use\s+solana_program(?:::|;)/.test(statement)) return false;
        // External crates: native carries them through (project-scaffold adds
        // matching deps to Cargo.toml). Pinocchio filters them out
        // because there's no compatible dep in their Cargo.toml.
        if (!isNative) {
          if (/\bnum_derive\b/.test(statement)) return false;
          if (/\bnum_traits\b/.test(statement)) return false;
          if (/\bmpl_core\b/.test(statement)) return false;
          if (/\bmpl_token_metadata\b/.test(statement)) return false;
          if (/\bpyth_solana_receiver_sdk\b/.test(statement)) return false;
          if (/\bswitchboard_on_demand\b/.test(statement)) return false;
          if (/\bsolana_keccak_hasher\b/.test(statement)) return false;
          if (/\bsolana_sha256_hasher\b/.test(statement)) return false;
          if (/\bsha2_const_stable\b/.test(statement)) return false;
        }
        // Token-2022 transfer-hook helper crates. These are SBF-only crates
        // not in the Pinocchio OR Native scaffold (Native ships
        // spl_token_2022 + spl_pod, but not the transfer-hook-specific
        // helpers). The body-level usages of types from these imports are
        // commented out by commentOutT22ExtensionCallSites on Pinocchio;
        // dropping the imports themselves keeps lib.rs from cascading
        // E0432/E0433 errors at module scope.
        if (/\bspl_tlv_account_resolution\b/.test(statement)) return false;
        if (/\bspl_transfer_hook_interface\b/.test(statement)) return false;
        if (/\bspl_discriminator\b/.test(statement)) return false;
        // spl_pod isn't in any scaffold — neither Pinocchio nor Native
        // ship it. Drop on both targets.
        if (/\bspl_pod\b/.test(statement)) return false;
        return true;
      });
  }

  protected rustTypeForCustomType(typeName: string): string {
    if (typeName === "String" || typeName === "Vec<u8>") return typeName;
    return this.rustTypeForFramework(typeName);
  }

  // ─── Generic emission pipeline ─────────────────────────────────────────────

  /**
   * Main entry point: emit the full program from a SolanaIR.
   *
   * Generates both a multi-file project layout (lib.rs, state.rs,
   * instructions/*.rs, errors.rs, helpers.rs) and a combined single-file
   * output for backward compatibility. Also collects warnings and a
   * transform report showing how many body statements were transformed
   * vs passed through.
   *
   * Subclasses do not override this method. Instead they implement the
   * abstract methods (`emitUseStatements`, `emitEntrypoint`, etc.) that
   * this method calls.
   *
   * @param ir - The validated SolanaIR to emit
   * @returns `EmitterOutput` containing files, singleFile, warnings, and transformReport
   */
  emit(ir: SolanaIR): EmitterOutput {
    this.currentIr = ir;
    this.warnings = [];
    this.transformedCount = 0;
    this.passedThroughCount = 0;
    this.details = [];
    this.unsalvageableHelpers = this.computeUnsalvageableHelpers(ir);

    const files: EmitterFile[] = [];

    // ── lib.rs ──
    const libContent = this.emitLibFile(ir);
    files.push({ path: "lib.rs", content: libContent });

    const hasHelperModule = this.hasHelperModule(ir);

    // ── state.rs (account structs) ──
    if (ir.accounts.length > 0) {
      const stateContent = this.emitStateFile(ir);
      files.push({ path: "state.rs", content: stateContent });
    }

    // ── events.rs (#[event] structs) ──
    // Emitted as separate file when the source has #[event] structs so
    // emit!/emit_cpi! handlers can reference them via crate::events::*.
    // Each event gets a borsh-derive struct + a sha256-based discriminator
    // const so sol_log_data byte-equals Anchor's expansion.
    if (ir.events && ir.events.length > 0) {
      const eventsContent = this.emitEventsFile(ir);
      files.push({ path: "events.rs", content: eventsContent });
    }

    // ── instructions/ ──
    if (ir.instructions.length > 0) {
      const instrModContent = this.emitInstructionsModFile(ir);
      files.push({ path: "instructions/mod.rs", content: instrModContent });

      for (const instr of ir.instructions) {
        const instrContent = this.emitInstructionFile(instr, ir);
        files.push({ path: `instructions/${snakeCase(instr.name)}.rs`, content: instrContent });
      }
    }

    // ── errors.rs ──
    if (ir.errors.length > 0) {
      const errorsContent = this.emitErrorsFile(ir);
      files.push({ path: "errors.rs", content: errorsContent });
    }

    // ── helpers.rs ──
    const helpersContent = this.emitHelpersFile(ir);
    if (hasHelperModule && helpersContent.trim()) {
      files.push({ path: "helpers.rs", content: helpersContent });
    }

    // ── Combined single file (backward compat) ──
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

  // ── File generators ──

  private emitLibFile(ir: SolanaIR): string {
    const sections: string[] = [];
    const constants = ir.constants ?? [];
    const types = ir.types ?? [];
    const hasHelperModule = this.hasHelperModule(ir);
    sections.push(this.fileHeader(ir.name));
    sections.push(this.emitUseStatements(ir));
    if (constants.length > 0) sections.push(constants.join("\n\n"));
    if (types.length > 0) sections.push(this.emitCustomTypes({ ...ir, types }));

    if (ir.accounts.length > 0) sections.push("mod state;");
    if ((ir.events ?? []).length > 0) sections.push("mod events;");
    if (ir.instructions.length > 0) sections.push("mod instructions;");
    if (ir.errors.length > 0) sections.push("mod errors;");
    if (hasHelperModule) sections.push("mod helpers;");
    if (ir.instructions.length > 0) {
      sections.push("use instructions::*;");
    }
    // User trait impls land AFTER `mod state;` so account-struct types
    // emitted into state.rs resolve when referenced. We pull them into
    // lib.rs scope with `use state::*;` since trait-impl bodies often
    // reference state structs verbatim (coral-multisig:
    // `impl From<&Transaction> for Instruction { … }`).
    const userTraitImpls = this.emitUserTraitImpls(ir);
    if (userTraitImpls) {
      if (ir.accounts.length > 0) sections.push("use state::*;");
      sections.push(userTraitImpls);
    }

    sections.push(this.emitEntrypoint(ir));
    sections.push(this.emitRouter(ir));

    return sections.join("\n\n");
  }

  private emitStateFile(ir: SolanaIR): string {
    const sections: string[] = [];
    sections.push(`//! State account definitions for ${toPascalCase(ir.name)}`);
    sections.push(`//! Generated by Anvil v0.3.0 — Target: ${this.frameworkName}\n`);
    sections.push(`use super::*;`);
    // State methods (e.g. `impl Config { fn validate() }`) frequently
    // reference error variants — `use crate::errors::*;` brings the
    // re-exported variants into scope. Same as instructions/*.rs.
    if (ir.errors.length > 0) {
      sections.push(`use crate::errors::*;`);
    }

    for (const acc of ir.accounts) {
      sections.push(this.emitAccountStruct(acc));
    }
    return sections.join("\n\n");
  }

  /**
   * Emit each #[event] struct as a borsh-derive struct + a discriminator
   * const computed from sha256("event:<EventName>")[..8] (Anchor's
   * convention). emit!() / emit_cpi!() handlers reference the const for
   * sol_log_data's first slice.
   */
  private emitEventsFile(ir: SolanaIR): string {
    const sections: string[] = [];
    sections.push(`//! Event payload structs for ${toPascalCase(ir.name)}`);
    sections.push(`//! Generated by Anvil v0.3.0 — Target: ${this.frameworkName}`);
    sections.push(`//!`);
    sections.push(`//! Each #[event] from the Anchor source is mirrored as a borsh-derive`);
    sections.push(`//! struct + an 8-byte sha256 discriminator. emit!() handlers serialize`);
    sections.push(`//! via borsh and sol_log_data the result so off-chain indexers see a`);
    sections.push(`//! payload byte-identical to Anchor's macro expansion.\n`);
    sections.push(`use borsh::{BorshDeserialize, BorshSerialize};`);

    for (const ev of (ir.events ?? [])) {
      const fieldDecls = ev.fields
        .map((f) => `    pub ${snakeCase(f.name)}: ${this.rustTypeForCustomType(f.type)},`)
        .join("\n");
      const disc = eventDiscriminator(ev.name);
      sections.push(
        `#[derive(BorshSerialize, BorshDeserialize, Debug)]\npub struct ${ev.name} {\n${fieldDecls}\n}\n\nimpl ${ev.name} {\n    pub const DISCRIMINATOR: [u8; 8] = ${disc};\n}`,
      );
    }
    return sections.join("\n\n");
  }

  private emitInstructionsModFile(ir: SolanaIR): string {
    const mods = ir.instructions
      .map((i) => {
        const name = snakeCase(i.name);
        return `pub mod ${name};\npub use ${name}::${name};`;
      })
      .join("\n");
    const preludes = [
      `use crate::*;`,
      ir.accounts.length > 0 ? `use crate::state::*;` : "",
      (ir.events ?? []).length > 0 ? `use crate::events::*;` : "",
      ir.errors.length > 0 ? `use crate::errors::*;` : "",
      this.hasHelperModule(ir) ? `use crate::helpers::*;` : "",
    ].filter(Boolean).join("\n");
    return `//! Instruction processors for ${toPascalCase(ir.name)}\n\n${preludes}\n\n${mods}\n`;
  }

  private emitInstructionFile(instr: Instruction, ir: SolanaIR): string {
    // `use crate::errors::*;` brings the error enum + (now) the
    // re-exported variants into the instruction file's scope. Anchor
    // source frequently references error variants by bare name
    // (`Err(Unauthorized.into())`); without this import the bare names
    // resolve to "cannot find value" on cargo build. Only emit when the
    // IR has errors to import — keeps single-error-free programs clean.
    const errorImport = ir.errors.length > 0 ? `use crate::errors::*;\n` : "";
    const raw = `use super::*;\n${errorImport}\n${this.emitInstructionFunction(instr, ir)}`;
    return this.unsalvageableHelpers.size > 0
      ? commentOutUnsalvageableCallSites(raw, this.unsalvageableHelpers)
      : raw;
  }

  /**
   * Walk `ir.helperFns` and return the set of helper names that can't be
   * transpiled because their signature/body uses Anchor-only types. The
   * same gate applies to all targets — the wrapper types simply don't
   * exist on Pinocchio or Native, regardless of how the body is rewritten.
   *
   * Result feeds into emitHelpersFile (skip emit) and emitInstructionFile
   * (comment out call sites) so neither helpers.rs nor the instruction
   * files reference these helpers — the program compiles, with `// ⚠️
   * Anvil TODO` markers at every affected site documenting the manual
   * port required for runtime correctness.
   */
  private computeUnsalvageableHelpers(ir: SolanaIR): Set<string> {
    const out = new Set<string>();
    for (const helper of ir.helperFns ?? []) {
      if (hasUnsalvageableHelperSignature(helper.signature)) {
        out.add(helper.name);
        continue;
      }
      // Body-residual check: helper might have a clean signature but call
      // CpiContext / token_interface internally. Run the same target-side
      // transform we'd otherwise apply, then check if Anchor patterns
      // survived. If yes, the body can't compile.
      const transformed = this.transformHelperCode(helper.rawCode, ir);
      if (hasResidualAnchorPatterns(transformed)) out.add(helper.name);
    }
    return out;
  }

  private emitErrorsFile(ir: SolanaIR): string {
    return `//! Error definitions for ${toPascalCase(ir.name)}\n\nuse super::*;\n\n` + this.emitErrorEnum(ir);
  }

  private emitHelpersFile(ir: SolanaIR): string {
    const sections: string[] = [];
    // Carried helpers may reference state structs (e.g. `&mut Market`) and
    // error enums (`FundingError::MathOverflow`) declared in sibling modules.
    // `use super::*;` only re-exports what lib.rs publishes, and lib.rs
    // declares `state`/`errors` as private modules — so we mirror what
    // `emitInstructionsModFile` does and pull those scopes in directly.
    const preludes = [
      `use super::*;`,
      ir.accounts.length > 0 ? `use crate::state::*;` : "",
      ir.errors.length > 0 ? `use crate::errors::*;` : "",
    ].filter(Boolean).join("\n");
    sections.push(preludes);

    // Framework-specific helpers (transfer_lamports, etc.)
    const frameworkHelpers = this.emitHelperFunctions(ir);
    if (frameworkHelpers.trim()) sections.push(frameworkHelpers);

    // Carry over helper functions from source. Unsalvageable helpers
    // (Anchor-only types in signature/body) get a comment-out block so
    // helpers.rs still compiles; instruction files have their call sites
    // commented out by the post-process pass below.
    for (const helper of ir.helperFns) {
      if (this.unsalvageableHelpers.has(helper.name)) {
        sections.push(commentOutHelperBlock(helper.rawCode, helper.name, this.frameworkName));
        continue;
      }
      sections.push(this.carriedFunctionBlock(helper.rawCode, ir));
    }

    if (sections.length === 1) return "";
    return `//! Helper functions for ${toPascalCase(ir.name)}\n\n` + sections.join("\n\n");
  }

  protected hasHelperModule(ir: SolanaIR): boolean {
    // Unsalvageable helpers no longer count toward "needs a helper module"
    // — they're commented out, so a project with only those + no framework
    // helpers shouldn't carry a helpers.rs file at all.
    const salvageableCount = (ir.helperFns ?? []).filter(
      (h) => !this.unsalvageableHelpers.has(h.name),
    ).length;
    return Boolean(this.emitHelperFunctions(ir).trim()) || salvageableCount > 0;
  }

  // ── Combined single-file output ──

  protected emitSingleFile(ir: SolanaIR): string {
    const sections: string[] = [];
    const constants = ir.constants ?? [];
    const types = ir.types ?? [];

    sections.push(this.fileHeader(ir.name));
    sections.push(this.emitUseStatements(ir));
    if (constants.length > 0) sections.push(constants.join("\n\n"));
    if (types.length > 0) sections.push(this.emitCustomTypes({ ...ir, types }));
    const userTraitImplsSingle = this.emitUserTraitImpls(ir);
    if (userTraitImplsSingle) sections.push(userTraitImplsSingle);
    // Inline event struct definitions when the source has #[event] structs.
    // Multi-file emit puts these in events.rs; for single-file builds they
    // need to live alongside the rest. emit!() lowering references the
    // typename + ::DISCRIMINATOR const, so the definitions must be in scope.
    if ((ir.events ?? []).length > 0) {
      // Strip `//!` inner-doc comments (only valid at file-top) and the
      // `use borsh::...` line (already emitted by emitUseStatements when
      // events are present, so the inlined re-import would cause E0252).
      const eventsContent = this.emitEventsFile(ir)
        .split("\n")
        .filter((line) => !line.startsWith("//!") && !/^use borsh::/.test(line.trim()))
        .join("\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
      if (eventsContent) sections.push(eventsContent);
    }
    sections.push(this.emitEntrypoint(ir));
    sections.push(this.emitRouter(ir));

    for (const instr of ir.instructions) {
      sections.push(this.emitInstructionFunction(instr, ir));
    }

    for (const acc of ir.accounts) {
      sections.push(this.emitAccountStruct(acc));
    }

    const helpers = this.emitHelperFunctions(ir);
    if (helpers.trim()) sections.push(helpers);

    // Carry over helper functions from source. Same unsalvageable check as
    // multi-file emit — these helpers can't compile against the target's
    // type system, so emit a comment-out block with a TODO marker instead.
    for (const helper of ir.helperFns) {
      if (this.unsalvageableHelpers.has(helper.name)) {
        sections.push(commentOutHelperBlock(helper.rawCode, helper.name, this.frameworkName));
        continue;
      }
      sections.push(this.carriedFunctionBlock(helper.rawCode, ir));
    }

    if (ir.errors.length > 0) {
      sections.push(this.emitErrorEnum(ir));
    }

    let combined = sections.join("\n\n");
    if (this.unsalvageableHelpers.size > 0) {
      combined = commentOutUnsalvageableCallSites(combined, this.unsalvageableHelpers);
    }
    return combined;
  }

  // ─── Generic instruction function emitter ──────────────────────────────────

  protected emitInstructionFunction(instr: Instruction, ir: SolanaIR): string {
    const requiredAccountCount = instr.accounts.filter((a) => !a.isOptional).length;

    // Account bindings
    const bindings = instr.accounts
      .map((acc, idx) => acc.isOptional
        ? `    let ${snakeCase(acc.name)} = accounts.get(${idx});`
        : this.emitAccountBinding(snakeCase(acc.name), idx))
      .join("\n");

    // Signer checks
    const signerChecks = instr.accounts
      .filter((a) => a.isSigner && !a.isOptional)
      .map((a) => this.emitSignerCheck(snakeCase(a.name)))
      .join("\n");

    // Writable checks — ensure all mutable non-program accounts are actually writable.
    // Missing this allows attackers to pass read-only accounts where writes are expected.
    const isCustomState = (accountType: string) =>
      ir.accounts.some((a) => a.name === accountType);

    const writableAccountNames = instr.accounts
      .filter((a) => a.isMut && !a.isOptional && !isProgramAccount(a.accountType))
      .map((a) => snakeCase(a.name));
    const writableCheck = writableAccountNames.length > 0
      ? this.emitWritableCheck(writableAccountNames)
      : "";

    // Owner checks — only for accounts whose type is a custom state struct
    // (i.e., in ir.accounts). Token/System/Sysvar accounts are excluded:
    // they are owned by their respective programs, not this one.
    const ownerChecks = instr.accounts
      .filter((a) => !a.isOptional && !a.isInit && a.isMut && isCustomState(a.accountType))
      .map((a) => this.emitOwnerCheck(snakeCase(a.name)))
      .join("\n");

    // Arg parsing
    const argsBlock = this.emitArgParsing(instr.args);

    // Inline-init accounts whose address is NOT a PDA derived by us:
    // (a) `init associated_token::*` — address derived by the ATA program
    //     from (mint, authority); we emit a CreateAssociatedToken CPI.
    // (b) `init token::*` — non-ATA token account; account itself signs
    //     system::create_account, then we emit Token::initialize_account3.
    // Without these two clauses, the emitter silently drops the prelude and
    // downstream code (e.g. `token::transfer`) runs against an
    // uninitialized account. Both shapes share the "needs an external init
    // CPI" property — neither is a custom-state PDA.
    const isInlineAtaInit = (a: Instruction["accounts"][number]) =>
      a.constraints.some((c) => c.kind === "associated_token::mint" && c.value) &&
      a.constraints.some((c) => c.kind === "associated_token::authority" && c.value);
    const isInlineTokenInit = (a: Instruction["accounts"][number]) =>
      a.constraints.some((c) => c.kind === "token::mint" && c.value) &&
      a.constraints.some((c) => c.kind === "token::authority" && c.value);
    const isInlineAccountInit = (a: Instruction["accounts"][number]) =>
      isInlineAtaInit(a) || isInlineTokenInit(a);
    const initAccountsWithBumps = instr.accounts
      .filter((a) => a.isInit && a.isPda && a.pdaSeeds?.length && (isCustomState(a.accountType) || (a.isPda && a.pdaSeeds?.length)));
    const initPreludes = instr.accounts
      .filter((a) => a.isInit && (isCustomState(a.accountType) || (a.isPda && a.pdaSeeds?.length) || isInlineAccountInit(a)))
      .map((a) => this.emitInitAccountPrelude(a, instr, ir))
      .filter(Boolean)
      .join("\n");
    // Names of accounts whose bump was already derived in the preamble.
    // The body walker checks this before re-emitting on a `ctx.bumps.X`
    // reference, avoiding duplicate `let (expected_key, bump_X) = ...`
    // pairs in the emit (which compile but produce broken `*X.key` reads
    // when X is later state-shadowed by `let mut X = StateType { … }`).
    const preEmittedBumps = initAccountsWithBumps.map((a) => snakeCase(a.name));

    // Realloc preludes: Anchor's `realloc = <size-expr>` asks the runtime to
    // resize the account data buffer at instruction time. Anvil emits the
    // resize call + a best-effort rent-delta top-up from the signer; if the
    // rent delta is more complex (split payer, escrow, etc.) the user can
    // review the generated block. Pinocchio doesn't expose realloc
    // directly — we emit a warning block so at least the requirement is
    // visible in the generated code.
    const reallocPreludes = instr.accounts
      .map((a) => this.emitReallocPrelude(a, instr))
      .filter(Boolean)
      .join("\n");

    // Body emission — the main event
    const rawBodyCode = this.emitBodyStatements(instr.body, instr, ir, preEmittedBumps);
    // Hook: lets target emitters post-process the assembled body. Preludes
    // (init create_program_account, realloc CPI) are concatenated INTO the
    // string we hand to the post-process so target-specific commentout
    // passes (e.g. Pinocchio's T22 extension call-site commentout) can also
    // strip unresolvable references inside size expressions like
    // `space = ExtraAccountMetaList::size_of(...)`. Without this, prelude-
    // emitted lines bypassed the commentout pass and surfaced cargo errors.
    const preBodyContent = `${initPreludes}${initPreludes && reallocPreludes ? "\n" : ""}${reallocPreludes}${(initPreludes || reallocPreludes) ? "\n" : ""}${rawBodyCode}`;
    const processedContent = this.postProcessInstructionBody(preBodyContent, instr, ir);
    // Re-split: the post-process may have rewritten the concatenated string
    // arbitrarily; we just take it as the final body. The function signature
    // below references `bodyCode` not the separate preludes anymore.
    const bodyCode = processedContent;

    // Check if body already ends with Ok(()) — no `return_ok` in body means we add one
    const bodyHasReturnOk = instr.body.some(s => s.kind === "return_ok");
    const bodyHasOkPassThrough = instr.body.some(
      s => s.kind === "pass_through" && s.code.trim() === "Ok(())"
    );
    const needsOkReturn = !bodyHasReturnOk && !bodyHasOkPassThrough;

    const preChecks = [signerChecks, writableCheck, ownerChecks].filter(Boolean).join("\n");

    // `pub fn` so the multi-file layout's `pub use X::X;` re-export in
    // instructions/mod.rs resolves (CLI emits project-layout by default;
    // the router dispatches across modules). Harmless in singleFile too.
    const fn = `pub fn ${snakeCase(instr.name)}(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    data: &[u8],
) -> ProgramResult {
    if accounts.len() < ${requiredAccountCount} {
        return Err(ProgramError::NotEnoughAccountKeys);
    }

${bindings}
${preChecks ? `\n${preChecks}\n` : ""}
${argsBlock}

${bodyCode}
${needsOkReturn ? "\n    Ok(())" : ""}
}`;
    return prefixUnusedProphylacticBindings(fn);
  }

  // ─── Body statement walker ─────────────────────────────────────────────────

  protected emitBodyStatements(
    statements: BodyStatement[],
    instr: Instruction,
    ir: SolanaIR,
    preEmittedBumps?: string[],
  ): string {
    const ctx: BodyEmitterContext = {
      transformedCount: this.transformedCount,
      passedThroughCount: this.passedThroughCount,
      details: this.details,
      warnings: this.warnings,
      preEmittedBumps,
    };

    const result = emitBodyStatementsImpl(
      this as unknown as BodyEmitterCallbacks,
      ctx,
      statements,
      instr,
      ir,
    );

    // Sync mutable state back
    this.transformedCount = ctx.transformedCount;
    this.passedThroughCount = ctx.passedThroughCount;

    return result;
  }

  // ─── Arg parsing ───────────────────────────────────────────────────────────

  protected emitArgParsing(args: Arg[]): string {
    if (args.length === 0) {
      return `    if !data.is_empty() {
        return Err(ProgramError::InvalidInstructionData);
    }`;
    }

    const lines = ["    // Args", "    let mut remaining = data;"];
    for (const arg of args) {
      lines.push(this.emitArgDeserialize(arg));
    }
    lines.push(`    if !remaining.is_empty() {
        return Err(ProgramError::InvalidInstructionData);
    }`);
    return lines.join("\n");
  }

  protected emitArgDeserialize(arg: Arg): string {
    const size = this.resolveTypeSize(arg.type);
    const name = snakeCase(arg.name);
    const fixedArray = parseFixedArrayType(arg.type);

    switch (arg.type) {
      case "u8":
        return `    if remaining.len() < 1 {
        return Err(ProgramError::InvalidInstructionData);
    }
    let (arg_bytes, rest) = remaining.split_at(1);
    remaining = rest;
    let ${name}: u8 = arg_bytes[0];`;
      case "u16": case "u32": case "u64": case "u128":
      case "i16": case "i32": case "i64": case "i128":
        return `    if remaining.len() < ${size} {
        return Err(ProgramError::InvalidInstructionData);
    }
    let (arg_bytes, rest) = remaining.split_at(${size});
    remaining = rest;
    let ${name}: ${arg.type} = ${arg.type}::from_le_bytes(
        arg_bytes.try_into().map_err(|_| ProgramError::InvalidInstructionData)?
    );`;
      case "i8":
        return `    if remaining.len() < 1 {
        return Err(ProgramError::InvalidInstructionData);
    }
    let (arg_bytes, rest) = remaining.split_at(1);
    remaining = rest;
    let ${name}: i8 = arg_bytes[0] as i8;`;
      case "bool":
        return `    if remaining.len() < 1 {
        return Err(ProgramError::InvalidInstructionData);
    }
    let (arg_bytes, rest) = remaining.split_at(1);
    remaining = rest;
    let ${name}: bool = match arg_bytes[0] {
        0 => false,
        1 => true,
        _ => return Err(ProgramError::InvalidInstructionData),
    };`;
      case "Pubkey":
        return `    if remaining.len() < 32 {
        return Err(ProgramError::InvalidInstructionData);
    }
    let (arg_bytes, rest) = remaining.split_at(32);
    remaining = rest;
    let ${name}: ${this.rustTypeForFramework("Pubkey")} = ${this.emitPubkeyDeserializeSlice("arg_bytes")};`;
      case "String":
      case "Vec<u8>":
        return `    let ${name}: ${arg.type} = BorshDeserialize::deserialize(&mut remaining)
        .map_err(|_| ProgramError::InvalidInstructionData)?;`;
      default:
        // Handle Option<T> types — Borsh format: first byte 0=None, 1=Some, then inner value
        if (arg.type.startsWith("Option<") && arg.type.endsWith(">")) {
          return `    let ${name}: ${arg.type} = BorshDeserialize::deserialize(&mut remaining)
        .map_err(|_| ProgramError::InvalidInstructionData)?;`;
        }
        // Vec<T> for any borsh-deserializable T. Borsh format is u32 length
        // prefix + concatenated borsh-encoded elements; the standard derive
        // handles it without us reaching for a TODO.
        if (/^Vec<.+>$/.test(arg.type)) {
          return `    let ${name}: ${arg.type} = BorshDeserialize::deserialize(&mut remaining)
        .map_err(|_| ProgramError::InvalidInstructionData)?;`;
        }
        if (/^\[\s*u8\s*;\s*\d+\s*\]$/.test(arg.type)) {
          return `    if remaining.len() < ${size} {
        return Err(ProgramError::InvalidInstructionData);
    }
    let (arg_bytes, rest) = remaining.split_at(${size});
    remaining = rest;
    let ${name}: ${arg.type} = arg_bytes
        .try_into().map_err(|_| ProgramError::InvalidInstructionData)?;`;
        }
        if (fixedArray) {
          return `    let ${name}: ${arg.type} = BorshDeserialize::deserialize(&mut remaining)
        .map_err(|_| ProgramError::InvalidInstructionData)?;`;
        }
        const typeDef = this.customTypeDef(arg.type);
        if (typeDef) {
          return `    let ${name}: ${arg.type} = BorshDeserialize::deserialize(&mut remaining)
        .map_err(|_| ProgramError::InvalidInstructionData)?;`;
        }
        return `    // TODO: parse ${name}: ${arg.type}`;
    }
  }

  protected emitPubkeyDeserialize(start: number, end: number): string {
    return `data[${start}..${end}].try_into().map_err(|_| ProgramError::InvalidInstructionData)?`;
  }

  protected emitPubkeyDeserializeSlice(sliceExpr: string): string {
    return `${sliceExpr}.try_into().map_err(|_| ProgramError::InvalidInstructionData)?`;
  }

  protected customTypeDef(typeName: string) {
    return this.currentIr?.types.find((type) => type.name === typeName);
  }

  protected sourceErrorEnumName(ir: SolanaIR): string {
    const variantNames = new Set(ir.errors.map((error) => error.name));
    const prefixes = new Map<string, number>();
    const recordPrefixes = (text: string | undefined): void => {
      if (!text) return;
      for (const variant of variantNames) {
        const matches = [...text.matchAll(new RegExp(`\\b([A-Za-z_][A-Za-z0-9_]*)::${variant}\\b`, "g"))];
        for (const match of matches) {
          const prefix = match[1];
          if (!prefix) continue;
          prefixes.set(prefix, (prefixes.get(prefix) ?? 0) + 1);
        }
      }
    };

    for (const instr of ir.instructions) {
      recordPrefixes(instr.rawBody);
      for (const stmt of instr.body) {
        switch (stmt.kind) {
          case "require":
            recordPrefixes(stmt.error);
            break;
          case "return_err":
            recordPrefixes(stmt.error);
            break;
          case "pass_through":
            recordPrefixes(stmt.code);
            break;
        }
      }
    }

    const ranked = [...prefixes.entries()].sort((a, b) => b[1] - a[1]);
    return ranked[0]?.[0] ?? `${toPascalCase(ir.name)}Error`;
  }

  protected resolveTypeSize(typeName: string, visited = new Set<string>()): number {
    const fixedArray = parseFixedArrayType(typeName);
    if (fixedArray) {
      const elementSize = this.resolveTypeSize(fixedArray.elementType, visited);
      const len = resolveConstExprValue(fixedArray.lenExpr, this.currentIr?.constants ?? []);
      if (elementSize > 0 && len !== null) {
        return elementSize * len;
      }
    }

    if (visited.has(typeName)) return 0;
    const typeDef = this.customTypeDef(typeName);
    if (!typeDef) {
      return typeSize(typeName);
    }

    if (typeDef.kind === "enum") return 1;
    if (!typeDef.fields) return typeSize(typeName);

    visited.add(typeName);
    const size = typeDef.fields.reduce((sum, field) => sum + this.resolveTypeSize(field.type, visited), 0);
    visited.delete(typeName);
    return size;
  }

  /**
   * Emit user-defined trait impls collected by the parser. Default impl is
   * a verbatim concatenation; targets that need to filter or rewrite can
   * override. Returns "" when there are none so callers can guard with a
   * truthy check.
   */
  protected emitUserTraitImpls(ir: SolanaIR): string {
    const impls = ir.userTraitImpls ?? [];
    if (impls.length === 0) return "";
    return impls.join("\n\n");
  }

  protected emitCustomTypes(ir: SolanaIR): string {
    return ir.types.map((typeDef) => {
      if (typeDef.rawCode && typeDef.kind === "enum" && /\w+\s*\([^)]*\)/.test(typeDef.rawCode)) {
        // Complex enums with tuple variants need derive macros so they can be
        // used inside structs that derive BorshSerialize/BorshDeserialize.
        const rawCode = typeDef.rawCode.trim();
        const alreadyHasDerive = /^#\[derive\(/.test(rawCode);
        if (alreadyHasDerive) {
          return rawCode;
        }
        return `#[derive(Clone, Debug, PartialEq, BorshSerialize, BorshDeserialize)]\n#[borsh(use_discriminant = true)]\n${rawCode}`;
      }
      if (typeDef.kind === "enum") {
        const variants = (typeDef.variants ?? []).map((variant, index) => `    ${variant} = ${index},`).join("\n");
        const arms = (typeDef.variants ?? []).map((variant, index) => `            ${index} => Ok(Self::${variant}),`).join("\n");
        return `#[derive(Clone, Copy, Debug, PartialEq, BorshDeserialize, BorshSerialize)]
#[borsh(use_discriminant = true)]
#[repr(u8)]
pub enum ${typeDef.name} {
${variants}
}

impl TryFrom<u8> for ${typeDef.name} {
    type Error = ();

    fn try_from(value: u8) -> Result<Self, Self::Error> {
        match value {
${arms}
            _ => Err(()),
        }
    }
}`;
      }

      const fields = (typeDef.fields ?? [])
        .map((field) => `    pub ${snakeCase(field.name)}: ${this.rustTypeForCustomType(field.type)},`)
        .join("\n");
      const implBlock = this.emitTypeInherentImpl(typeDef);
      // Preserve `<'info>` / generic params on the struct decl so fields
      // that reference them (e.g. `MarketAccounts<'info>`) compile.
      const generics = typeDef.generics ?? "";
      return `#[derive(Clone, Debug, PartialEq, BorshDeserialize, BorshSerialize)]
pub struct ${typeDef.name}${generics} {
${fields}
}${implBlock}`;
    }).join("\n\n");
  }

  /** Append `impl <ThisType> { ...rawItems }` for user-authored helpers like
   * `Ride::new(...)` constructors. Mirrors the AccountDef-side
   * emitInherentImplItems hook in the target emitters. */
  protected emitTypeInherentImpl(typeDef: TypeDef): string {
    if (!typeDef.implItems || typeDef.implItems.length === 0) return "";
    // Mirror the struct's generics on the impl block so methods can use
    // them. `impl<'info> Foo<'info> { … }` for a `struct Foo<'info>`.
    const gen = typeDef.generics ?? "";
    return `\n\nimpl${gen} ${typeDef.name}${gen} {\n${typeDef.implItems.map((s) => `    ${s}`).join("\n\n")}\n}`;
  }

  // ─── File header ───────────────────────────────────────────────────────────

  protected fileHeader(name: string): string {
    // Allow attributes silence four classes of warnings that come with the
    // territory of generated code:
    //  - unexpected_cfgs: `#[cfg(target_os = "solana")]` is a Solana SBF
    //    target, but rustc on a regular host doesn't know about it.
    //  - dead_code: emitted constants like SIZE/SPACE/INIT_SPACE on state
    //    structs are part of the public API of the generated crate even
    //    when this particular program doesn't use them internally.
    //  - deprecated: `solana_program::system_instruction` is being phased out
    //    in favor of `solana_system_interface`, but the latter doesn't ship
    //    everywhere yet — keep working until we can switch wholesale.
    //  - unused_imports: prophylactic `use` statements at the top of every
    //    generated file (Borsh serde, Clock sysvar, CreateAssociatedToken)
    //    aren't always needed; keeping them blanket-imported saves the
    //    emitter from per-instruction conditional logic.
    return `//! ${toPascalCase(name)} — generated by Anvil v0.3.0
//! Source framework: Anchor → Target: ${this.frameworkName}
//!
//! This code was automatically generated. Sections marked with
//! "⚠️ Anvil: Review" should be verified before deployment.
#![deny(clippy::all)]
#![allow(unexpected_cfgs, dead_code, deprecated, unused_imports)]`;
  }

  // ─── Shared byte-layout serialization helpers ──────────────────────────────
  // These power the read()/write() impls emitted for every account struct.
  // Subclasses inherit them; override rustTypeForFramework() to adapt the Pubkey
  // representation ([u8;32] in Pinocchio, Pubkey in Native).

  protected accountDiscriminatorExpr(name: string): string {
    return accountDiscriminator(name);
  }

  protected buildReadLines(acc: AccountDef): string {
    return acc.fields
      .map((f, i) => stripTrailingOffsetBump(
        this.buildReadLine(f.type, snakeCase(f.name)),
        i === acc.fields.length - 1,
      ))
      .join("\n");
  }

  protected buildWriteLines(acc: AccountDef): string {
    return acc.fields
      .map((f, i) => stripTrailingOffsetBump(
        this.buildWriteLine(f.type, snakeCase(f.name)),
        i === acc.fields.length - 1,
      ))
      .join("\n");
  }

  protected buildReadLine(typeName: string, fieldName: string): string {
    const size = this.resolveTypeSize(typeName);
    const typeDef = this.customTypeDef(typeName);
    const rustType = this.rustTypeForFramework(typeName);
    const fixedArray = parseFixedArrayType(typeName);

    if (typeName === "Pubkey") {
      // Use rustTypeForFramework so Pinocchio gets [u8;32], others get Pubkey
      return `        let ${fieldName}: ${rustType} = ${this.emitPubkeyFieldRead(size)};
        offset += ${size};`;
    }
    if (/^\[\s*u8\s*;\s*\d+\s*\]$/.test(typeName)) {
      return `        let ${fieldName}: ${typeName} = data[offset..offset + ${size}]
            .try_into().map_err(|_| ProgramError::InvalidAccountData)?;
        offset += ${size};`;
    }
    if (fixedArray || typeDef?.kind === "struct") {
      return `        let mut ${fieldName}_bytes = &data[offset..offset + ${size}];
        let ${fieldName}: ${typeName} = BorshDeserialize::deserialize(&mut ${fieldName}_bytes)
            .map_err(|_| ProgramError::InvalidAccountData)?;
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
    // Dynamically-sized / borsh-native types — String and Vec<T> are
    // length-prefixed (4-byte u32 length + content). The account layout
    // does NOT pad them to a fixed size: subsequent fields start right
    // after the variable-length tail, exactly like Anchor's borsh derive.
    //
    // Pre-fix the harness used a hardcoded `size` and read a fixed slice,
    // which truncated long values, panicked on slice-OOB when the on-chain
    // String was shorter than `size`, AND silently desynced the offset
    // cursor for any field that came after. Fix: pass an open-ended slice
    // to Borsh, let it consume length-prefix + content, and advance offset
    // by exactly what Borsh read.
    if (typeName === "String" || /^Vec<.+>$/.test(typeName) || /^Option<.+>$/.test(typeName)) {
      return `        let mut ${fieldName}_bytes: &[u8] = &data[offset..];
        let __${fieldName}_before = ${fieldName}_bytes.len();
        let ${fieldName}: ${typeName} = BorshDeserialize::deserialize(&mut ${fieldName}_bytes)
            .map_err(|_| ProgramError::InvalidAccountData)?;
        offset += __${fieldName}_before - ${fieldName}_bytes.len();`;
    }
    return `        let ${fieldName}: ${typeName} = ${typeName}::from_le_bytes(
            data[offset..offset + ${size}].try_into().map_err(|_| ProgramError::InvalidAccountData)?
        );
        offset += ${size};`;
  }

  protected buildWriteLine(typeName: string, fieldName: string): string {
    const size = this.resolveTypeSize(typeName);
    const typeDef = this.customTypeDef(typeName);
    const fixedArray = parseFixedArrayType(typeName);

    if (typeName === "Pubkey" || /^\[\s*u8\s*;\s*\d+\s*\]$/.test(typeName)) {
      return `        data[offset..offset + ${size}].copy_from_slice(&value.${fieldName}${this.emitPubkeyFieldAsRef()});
        offset += ${size};`;
    }
    if (fixedArray || typeDef?.kind === "struct") {
      return `        {
            let mut ${fieldName}_bytes = &mut data[offset..offset + ${size}];
            BorshSerialize::serialize(&value.${fieldName}, &mut ${fieldName}_bytes)
                .map_err(|_| ProgramError::InvalidAccountData)?;
        }
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
    // Dynamically-sized / borsh-native types — mirror the buildReadLine
    // branch. Serialize through a Vec, then copy into the account slot
    // and advance offset by the actual byte count. The account must have
    // been sized to hold this at init (Anchor's `space = ...`); we don't
    // re-validate here because the caller (handler) is responsible for
    // the size budget. Slice-OOB on copy_from_slice will surface as a
    // panic at runtime if it's wrong, exactly like Anchor's behavior.
    if (typeName === "String" || /^Vec<.+>$/.test(typeName) || /^Option<.+>$/.test(typeName)) {
      return `        let __${fieldName}_serialized = ::borsh::to_vec(&value.${fieldName})
            .map_err(|_| ProgramError::InvalidAccountData)?;
        data[offset..offset + __${fieldName}_serialized.len()].copy_from_slice(&__${fieldName}_serialized);
        offset += __${fieldName}_serialized.len();`;
    }
    return `        data[offset..offset + ${size}].copy_from_slice(&value.${fieldName}.to_le_bytes());
        offset += ${size};`;
  }

  /**
   * How to deserialize a Pubkey at the current `offset` in a read() body.
   * Pinocchio overrides to return the raw array (since Pubkey IS [u8;32]).
   * Native keeps it as Pubkey::new_from_array(...).
   */
  protected emitPubkeyFieldRead(_size: number): string {
    return `data[offset..offset + 32].try_into().map_err(|_| ProgramError::InvalidAccountData)?`;
  }

  /**
   * Whether a Pubkey field value needs `.as_ref()` to get &[u8] for copy_from_slice.
   * Returns "" for Pinocchio ([u8;32] IS already a byte array),
   * returns ".as_ref()" for frameworks where Pubkey wraps [u8;32].
   */
  protected emitPubkeyFieldAsRef(): string {
    return "";
  }

  protected emitInitAccountPrelude(
    accountRef: Instruction["accounts"][number],
    instr: Instruction,
    ir: SolanaIR,
  ): string {
    const accountName = snakeCase(accountRef.name);
    const payerName = accountRef.initPayer ? snakeCase(accountRef.initPayer) : undefined;

    // ── ATA creation: if the account has associated_token::mint and associated_token::authority,
    // emit an ATA creation CPI instead of create_program_account ──
    const ataMintConstraint = accountRef.constraints.find((c) => c.kind === "associated_token::mint" && c.value);
    const ataAuthorityConstraint = accountRef.constraints.find((c) => c.kind === "associated_token::authority" && c.value);
    if (ataMintConstraint?.value && ataAuthorityConstraint?.value) {
      const mint = snakeCase(ataMintConstraint.value);
      const authority = snakeCase(ataAuthorityConstraint.value);
      const payer = payerName ?? "payer";
      return this.emitCreateAta(accountName, payer, mint, authority);
    }

    // ── `init token::*` (non-ATA token account): account is a fresh keypair
    // OR a PDA. Both shapes share the same Anchor lowering — system::
    // create_account (165 bytes, owner=token program) + initialize_account3
    // — but the create_account CPI signs with the account itself when
    // non-PDA, and with the PDA's signer seeds when seeds + bump are set.
    // vesting/staking/amm vaults use the PDA shape; escrow uses the fresh-
    // keypair shape. Both cases needed before we could claim emit parity.
    const tokenMintConstraint = accountRef.constraints.find((c) => c.kind === "token::mint" && c.value);
    const tokenAuthorityConstraint = accountRef.constraints.find((c) => c.kind === "token::authority" && c.value);
    if (tokenMintConstraint?.value && tokenAuthorityConstraint?.value) {
      const mint = snakeCase(tokenMintConstraint.value);
      const authority = snakeCase(tokenAuthorityConstraint.value);
      const payer = payerName ?? "payer";

      // PDA case: derive bump first (body code references bump_<name>) +
      // build the signer-seeds expression that gets threaded into the
      // create_account CPI. Reuses the same shape as the existing
      // emitInitAccountPrelude PDA branch — keeping naming consistent
      // (init_<name>_seeds / init_<name>_signer_seeds) so a downstream
      // body-code reference resolves identically.
      if (accountRef.isPda && accountRef.pdaSeeds?.length) {
        const pdaSeeds = accountRef.pdaSeeds.map((seed) => this.normalizeInitSeedExpr(seed));
        const bumpPrelude = this.emitBumpSeed("program_id", pdaSeeds, accountName)
          .replace(/\blet bump =/g, `let bump_${accountName} =`)
          .replace(/\blet\s+\(expected_key,\s*bump\)\s*=/g, `let (expected_key, bump_${accountName}) =`);

        const initSeedPrelude: string[] = [];
        let initTempCount = 0;
        const liftedSeeds = pdaSeeds.map((seed) => {
          const asRefMatch = seed.match(/^(.+)\.to_le_bytes\(\)\.as_ref\(\)$/);
          if (asRefMatch?.[1]) {
            const v = initTempCount === 0 ? `init_seed_bytes` : `init_seed_bytes_${initTempCount + 1}`;
            initTempCount++;
            initSeedPrelude.push(`    let ${v} = ${asRefMatch[1].trim()}.to_le_bytes();`);
            return `${v}.as_ref()`;
          }
          const refMatch = seed.match(/^&(.+)\.to_le_bytes\(\)$/);
          if (refMatch?.[1]) {
            const v = initTempCount === 0 ? `init_seed_bytes` : `init_seed_bytes_${initTempCount + 1}`;
            initTempCount++;
            initSeedPrelude.push(`    let ${v} = ${refMatch[1].trim()}.to_le_bytes();`);
            return `&${v}`;
          }
          return seed;
        });
        const seedPreludeStr = initSeedPrelude.length > 0 ? `${initSeedPrelude.join("\n")}\n` : "";
        const seedsPrelude = `${seedPreludeStr}    let init_${accountName}_seeds: &[&[u8]] = &[
            ${[...liftedSeeds, `&[bump_${accountName}]`].join(",\n            ")},
        ];
    let init_${accountName}_signer_seeds = &[&init_${accountName}_seeds[..]];`;
        const signerSeedsExpr = `init_${accountName}_signer_seeds`;
        const tokenCreate = this.emitCreateTokenAccount(accountName, payer, mint, authority, signerSeedsExpr);
        return `${bumpPrelude}\n${seedsPrelude}\n${tokenCreate}`;
      }

      // Non-PDA case: account-as-signer create. Just the init CPI.
      return this.emitCreateTokenAccount(accountName, payer, mint, authority);
    }

    if (!payerName || !accountRef.initSpace) {
      // Even without full payer/space info, PDA init accounts still need bump derivation
      // so that body code referencing ctx.bumps.X (e.g., pool.vault_bump = bump_vault) compiles.
      if (accountRef.isPda && accountRef.pdaSeeds?.length) {
        const pdaSeeds = (accountRef.pdaSeeds).map((seed) =>
          this.normalizeInitSeedExpr(seed)
        );
        const bumpOnly = this.emitBumpSeed("program_id", pdaSeeds, accountName)
          .replace(/\blet bump =/g, `let bump_${accountName} =`)
          .replace(/\blet\s+\(expected_key,\s*bump\)\s*=/g, `let (expected_key, bump_${accountName}) =`);
        this.warnings.push(
          `Init account '${accountName}' is missing payer/space metadata (token account?); bump derived but allocation must be handled externally.`
        );
        return bumpOnly;
      }
      this.warnings.push(
        `Init account '${accountName}' is missing payer/space metadata; generated output may require manual allocation wiring.`
      );
      return "";
    }

    const payerRef = instr.accounts.find((account) => snakeCase(account.name) === payerName);
    if (!payerRef) {
      this.warnings.push(
        `Init account '${accountName}' references unknown payer '${payerName}'.`
      );
      return "";
    }

    // The PDA prelude has two halves: the bump derivation (deterministic
    // from program_id+seeds) and the signer-seed bookkeeping (only used on
    // the create_program_account path). Keep them as separate strings so
    // we can hoist the bump out of the `init_if_needed` guard below — the
    // body code references `bump_X` to write `account.bump = bump_X` after
    // the guard, and that reference must be in scope on both branches.
    let bumpPrelude = "";
    let seedsPrelude = "";
    let signerSeedsExpr: string | undefined;
    if (accountRef.isPda) {
      const pdaSeeds = (accountRef.pdaSeeds ?? [`b"${accountName}"`]).map((seed) =>
        this.normalizeInitSeedExpr(seed)
      );
      bumpPrelude = this.emitBumpSeed(
        "program_id",
        pdaSeeds,
        accountName,
      )
        .replace(/\blet bump =/g, `let bump_${accountName} =`)
        .replace(/\blet\s+\(expected_key,\s*bump\)\s*=/g, `let (expected_key, bump_${accountName}) =`);

      // Lift to_le_bytes() temporaries out of the init seeds array to avoid
      // E0716 (temporary dropped while borrowed).
      const initSeedPrelude: string[] = [];
      let initTempCount = 0;
      const liftedSeeds = pdaSeeds.map((seed) => {
        // Match patterns like: seed.to_le_bytes().as_ref()
        const asRefMatch = seed.match(/^(.+)\.to_le_bytes\(\)\.as_ref\(\)$/);
        if (asRefMatch?.[1]) {
          const varName = initTempCount === 0 ? `init_seed_bytes` : `init_seed_bytes_${initTempCount + 1}`;
          initTempCount++;
          initSeedPrelude.push(`    let ${varName} = ${asRefMatch[1].trim()}.to_le_bytes();`);
          return `${varName}.as_ref()`;
        }
        // Match patterns like: &seed.to_le_bytes()
        const refMatch = seed.match(/^&(.+)\.to_le_bytes\(\)$/);
        if (refMatch?.[1]) {
          const varName = initTempCount === 0 ? `init_seed_bytes` : `init_seed_bytes_${initTempCount + 1}`;
          initTempCount++;
          initSeedPrelude.push(`    let ${varName} = ${refMatch[1].trim()}.to_le_bytes();`);
          return `&${varName}`;
        }
        return seed;
      });

      const initSeedPreludeStr = initSeedPrelude.length > 0 ? `${initSeedPrelude.join("\n")}\n` : "";
      seedsPrelude = `${initSeedPreludeStr}    let init_${accountName}_seeds: &[&[u8]] = &[
            ${[...liftedSeeds, `&[bump_${accountName}]`].join(",\n            ")},
        ];
    let init_${accountName}_signer_seeds = &[&init_${accountName}_seeds[..]];`;
      signerSeedsExpr = `init_${accountName}_signer_seeds`;
    }

    const createCall = this.emitCreateProgramAccount(
      accountName,
      payerName,
      accountRef.initSpace,
      signerSeedsExpr,
    );

    // `init_if_needed` means: only allocate if the account doesn't already
    // exist on-chain. An empty data buffer + zero lamports is the standard
    // heuristic. The seeds bookkeeping + create call are gated, but the
    // bump derivation is hoisted to function scope: deterministic from
    // program_id+seeds (so cheap on either branch) and required by the
    // body — `account.bump = bump_X` runs after the guard, on both the
    // freshly-created and pre-existing paths, and must see `bump_X` in
    // scope.
    const isIfNeeded = accountRef.constraints.some(
      (c) => c.kind === "init_if_needed",
    );
    if (isIfNeeded) {
      const inner = [seedsPrelude, createCall].filter(Boolean).join("\n");
      // Indent body so the emitted block stays readable.
      const indented = inner.replace(/^/gm, "    ");
      const block = `    // init_if_needed: only allocate when the account is empty.
    if ${accountName}.data_is_empty() {
${indented}
    }`;
      return [bumpPrelude, block].filter(Boolean).join("\n");
    }

    return [bumpPrelude, seedsPrelude, createCall].filter(Boolean).join("\n");
  }

  /**
   * Emit realloc prelude — resize the account buffer to the expression
   * given by `#[account(realloc = <expr>)]`. Native emits the real call
   * (`account.realloc`) plus a rent-delta top-up via a system transfer
   * from the first signer. Pinocchio doesn't expose realloc at the
   * account-info level the same way; they get a warning block so the
   * requirement stays visible in the generated code.
   */
  protected emitReallocPrelude(
    accountRef: Instruction["accounts"][number],
    instr: Instruction,
  ): string {
    const reallocConstraint = accountRef.constraints.find((c) => c.kind === "realloc");
    if (!reallocConstraint?.value) return "";
    const accountName = snakeCase(accountRef.name);
    const sizeExpr = reallocConstraint.value;

    // Native path — real realloc + rent top-up. Pick the first mut Signer
    // in the instruction as the rent-delta payer; matches Anchor's default
    // when `realloc::payer` isn't explicitly different.
    const payerAcc = instr.accounts.find((a) => a.isSigner && a.isMut);
    const payer = payerAcc ? snakeCase(payerAcc.name) : "payer";

    // State-field-in-realloc-expr support. Anchor's macro deserializes the
    // existing account before evaluating `realloc = <expr>`, so expressions
    // like `realloc = 8 + 4 + state.log.len() + 1` reference the deserialized
    // struct's fields. Anvil's emit runs BEFORE any deserialize — so the
    // expression sees `state` (the AccountInfo) and bails with E0609 / E0599.
    //
    // Detection: scan sizeExpr for `<account>.<field>` against the
    // instruction's account names. If any match, deserialize that account
    // ONCE inside the new-size scope and rewrite the expression to use the
    // local var. The body's subsequent state_read still runs (and deserializes
    // again) — two deserializations is fine; runtime cost is sub-µs.
    const accountFieldPattern = (acc: string) =>
      new RegExp(`\\b${acc.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\.(\\w+)`, "g");
    const stateAccountsInScope = instr.accounts.filter((a) => a.accountType && this.currentIr?.accounts.some((sa) => sa.name === a.accountType));
    const referencedStateAccounts: Array<{ name: string; type: string }> = [];
    for (const acc of stateAccountsInScope) {
      const accName = snakeCase(acc.name);
      if (accountFieldPattern(accName).test(sizeExpr)) {
        referencedStateAccounts.push({ name: accName, type: acc.accountType! });
      }
    }
    let resolvedSizeExpr = sizeExpr;
    let predeserialize = "";
    if (referencedStateAccounts.length > 0) {
      const lines: string[] = [];
      for (const { name, type } of referencedStateAccounts) {
        const localVar = `__${name}_for_realloc`;
        lines.push(`        let ${localVar} = ${type}::from_account_info(${name})?;`);
        // Rewrite `<name>.<field>` → `<localVar>.<field>` in the size expr.
        resolvedSizeExpr = resolvedSizeExpr.replace(accountFieldPattern(name), `${localVar}.$1`);
      }
      predeserialize = lines.join("\n") + "\n";
    }

    // Detect realloc::zero — Anchor's flag for whether to zero-fill the
    // newly-grown region. Defaults to false (matches Anchor's default).
    const reallocZero = accountRef.constraints.some(
      (c) => c.kind === "realloc" && false, // realloc::zero is parsed as a separate flag; check the IR carrier
    );
    void reallocZero; // not yet wired to a constraint kind; default to false matches Anchor

    if (this.frameworkName === "Native") {
      return `    // realloc — resize ${accountName} to ${sizeExpr}
    {
${predeserialize}        let __new_size = (${resolvedSizeExpr}) as usize;
        let __rent = solana_program::sysvar::rent::Rent::get()?;
        let __new_lamports = __rent.minimum_balance(__new_size);
        let __delta = __new_lamports.saturating_sub(${accountName}.lamports());
        if __delta > 0 {
            let __ix = solana_program::system_instruction::transfer(
                ${payer}.key,
                ${accountName}.key,
                __delta,
            );
            solana_program::program::invoke(
                &__ix,
                &[${payer}.clone(), ${accountName}.clone()],
            )?;
        }
        ${accountName}.realloc(__new_size, false)?;
    }`;
    }

    if (this.frameworkName === "Pinocchio") {
      // Pinocchio 0.9 exposes AccountInfo::realloc(new_len, zero_init) →
      // Result<(), ProgramError>. We previously assumed it wasn't stable
      // and emitted a TODO(manual). Now we emit the same shape as Native:
      // compute new size (with optional state-field deserialize), top up
      // rent via system_program transfer, then realloc the buffer.
      //
      // Rent top-up is via pinocchio_system::Transfer{from, to, lamports}.
      // Both signers (payer + account) are from the instruction's account
      // slice — Pinocchio's Transfer takes &AccountInfo refs directly.
      return `    // realloc — resize ${accountName} to ${sizeExpr}
    {
${predeserialize}        let __new_size = (${resolvedSizeExpr}) as usize;
        let __rent = pinocchio::sysvars::rent::Rent::get()?;
        let __new_lamports = __rent.minimum_balance(__new_size);
        let __delta = __new_lamports.saturating_sub(${accountName}.lamports());
        if __delta > 0 {
            pinocchio_system::instructions::Transfer {
                from: ${payer},
                to: ${accountName},
                lamports: __delta,
            }.invoke()?;
        }
        ${accountName}.realloc(__new_size, false)?;
    }`;
    }

    // Both supported frameworks return above; the fallthrough was historically
    // for Quasar, which has been removed. Surface as an explicit assertion in
    // case a new framework is added later without updating the realloc emit.
    throw new Error(
      `emitReallocPrelude: unhandled frameworkName='${this.frameworkName}'. Add a branch for this target.`,
    );
  }

  protected normalizeInitSeedExpr(seed: string): string {
    const trimmed = cleanInlineExpr(seed);
    return trimmed
      .replace(/ctx\.accounts\.(\w+)\.key\(\)\.as_ref\(\)/g, (_full, name: string) =>
        this.emitAccountKeyAsRefExpr(snakeCase(name))
      )
      .replace(/ctx\.accounts\.(\w+)\.key\.as_ref\(\)/g, (_full, name: string) =>
        this.emitAccountKeyAsRefExpr(snakeCase(name))
      )
      // Catch non-prefixed .key().as_ref() forms (e.g. authority.key().as_ref())
      .replace(/(\w+)\.key\(\)\.as_ref\(\)/g, (_full, name: string) =>
        this.emitAccountKeyAsRefExpr(snakeCase(name))
      )
      // Catch non-prefixed .key.as_ref() forms (e.g. authority.key.as_ref())
      .replace(/(\w+)\.key\.as_ref\(\)/g, (_full, name: string) =>
        this.emitAccountKeyAsRefExpr(snakeCase(name))
      );
  }

  /**
   * Return the default/zero value for a given Rust type in generated code.
   * Subclasses can override for framework-specific type representations
   * (e.g. Pinocchio uses [0u8; 32] instead of Pubkey::default()).
   */
  protected defaultValueForType(typeName: string): string {
    const normalized = typeName.trim();
    const typeDef = this.customTypeDef(normalized);
    const fixedArray = parseFixedArrayType(normalized);

    if (normalized === "bool") return "false";
    if (/^(u|i)\d+$/.test(normalized)) return "0";
    if (normalized === "Pubkey") return this.defaultPubkeyValue();
    if (fixedArray) {
      return `[${this.defaultValueForType(fixedArray.elementType)}; ${fixedArray.lenExpr.trim()}]`;
    }
    const arrayMatch = normalized.match(/^\[\s*u8\s*;\s*(\d+)\s*\]$/);
    if (arrayMatch?.[1]) return `[0u8; ${arrayMatch[1]}]`;
    if (normalized === "String") return "String::new()";
    if (normalized === "Vec<u8>") return "Vec::new()";
    if (typeDef?.kind === "enum" && typeDef.variants?.[0]) {
      return `${normalized}::${typeDef.variants[0]}`;
    }
    // Generic types (Vec<T>, Option<T>, HashMap<K,V>, …) require turbofish
    // when calling associated functions: `Vec<String>::default()` is a
    // syntax error, `Vec::<String>::default()` is correct. Detecting the
    // angle bracket and rewriting handles the common cases without listing
    // every container type.
    const ltIdx = normalized.indexOf("<");
    if (ltIdx > 0) {
      return `${normalized.slice(0, ltIdx)}::${normalized.slice(ltIdx)}::default()`;
    }
    return `${normalized}::default()`;
  }

  /**
   * Returns the zero-value for a Pubkey field in generated struct initialization.
   * Pinocchio overrides this because Pubkey IS [u8; 32] — Pubkey::default() doesn't exist.
   */
  protected defaultPubkeyValue(): string {
    return "Pubkey::default()";
  }

  /**
   * Emit a conditional state read for `init_if_needed` accounts: read existing
   * state when the account isn't empty, default-init when it is. The resulting
   * `let mut <var>` binding is the same shape regardless of branch, so the
   * body code that follows doesn't need to know which path it took.
   *
   * Default implementation composes the existing read + init helpers; targets
   * with cheaper paths can override.
   */
  // Public so the body-emitter walker can call it via the
  // BodyEmitterCallbacks interface (init_if_needed branch). Default impl
  // composes existing read + init helpers; targets with cheaper paths
  // can override.
  //
  // Match-on-Result vs data_is_empty: the upstream prelude calls
  // `create_program_account` on an empty account, which allocates `space`
  // bytes (all zeros) — leaving data_is_empty() returning FALSE. If we
  // gated the read-or-init on data_is_empty(), the post-allocation path
  // would try to deserialize a discriminator-less zero buffer and fail
  // with InvalidAccountData.
  //
  // The cleaner cross-target fix: try `from_account_info` first, and if
  // it errors (discriminator absent, length-too-short, etc.), fall back
  // to default-init. Works on Pinocchio (borrow_data_unchecked under the
  // hood) and Native (account.data.borrow()) without target-specific
  // code here. The Err branch also handles a future `init_if_needed`
  // semantic Anchor adds — anything that makes from_account_info fail
  // gets treated as "first call, default-init."
  emitStateReadOrInit(
    accountInfoVar: string,
    typeName: string,
    localVar: string,
    _mutable: boolean,
  ): string {
    const accountDef = this.currentIr?.accounts.find((account) => account.name === typeName);
    const initStruct = accountDef
      ? `${typeName} {\n${accountDef.fields
          .map((field) => `            ${snakeCase(field.name)}: ${this.defaultValueForType(field.type)},`)
          .join("\n")}\n        }`
      : `${typeName}::default()`;
    return `    let mut ${localVar} = match ${typeName}::from_account_info(${accountInfoVar}) {
        Ok(__existing) => __existing,
        Err(_) => ${initStruct},
    };`;
  }

  /**
   * Emit a safe field-by-field initialized local variable for an account struct
   * that is being created (isInit). This avoids reading discriminator-protected
   * account data before the create-account CPI has happened and avoids `unsafe`
   * zeroing in generated output.
   */
  protected emitStateInit(typeName: string, localVar: string): string {
    const accountDef = this.currentIr?.accounts.find((account) => account.name === typeName);
    if (!accountDef) {
      return `    let mut ${localVar} = ${typeName}::default();`;
    }

    const fields = accountDef.fields
      .map((field) => `        ${snakeCase(field.name)}: ${this.defaultValueForType(field.type)},`)
      .join("\n");
    return `    let mut ${localVar} = ${typeName} {
${fields}
    };`;
  }

  /**
   * Wrap a helper function that was carried verbatim from the Anchor source.
   *
   * If the function body contains Anchor-specific API patterns (ctx, CpiContext,
   * system_program::transfer, anchor_spl, require!, emit!) it receives a full
   * warning banner so the developer knows it must be rewritten.
   *
   * Pure Rust helpers (arithmetic, bit manipulation, lookups, etc.) that happen
   * to live in the same Anchor file are plain-correct and get only a light
   * comment — no false-positive warning.
   */
  protected carriedFunctionBlock(rawCode: string, ir?: SolanaIR): string {
    let transformed = promoteFreeFnVisibility(this.transformHelperCode(rawCode, ir));
    // Same module-collapse rewrite as walker.ts.transformNestedAnchorCode —
    // helpers.rs carries source-side `<modname>::<helper>(...)` calls, but
    // Anvil flattens helpers into a single module, so collapse those calls
    // to the bare `<helper>(...)` form. Without this, multi-module fixtures
    // like carnival hit E0433 unresolved-module on every cross-mod call.
    if (ir) {
      const helperNames = new Set((ir.helperFns ?? []).map((h) => h.name));
      if (helperNames.size > 0) {
        transformed = transformed.replace(
          /\b(\w+)::(\w+)\s*\(/g,
          (full, _modName: string, fnName: string) =>
            helperNames.has(fnName) ? `${fnName}(` : full,
        );
      }
    }
    // Check the *transformed* code for residual Anchor patterns — the transform
    // may have cleaned up everything that was originally Anchor-specific.
    if (!hasResidualAnchorPatterns(transformed)) {
      // No Anchor-specific APIs detected after transformation — the function
      // is pure Rust (or was fully transformed) and should compile as-is.
      return `// Carried from source (transformed for ${this.frameworkName})\n${transformed}`;
    }
    return [
      `// ╔════════════════════════════════════════════════════════════════════════════════╗`,
      `// ║  ⚠️  ANVIL: function below was carried from the Anchor source and partially  ║`,
      `// ║  transformed. It may still use Anchor APIs (ctx, CpiContext, etc.) and        ║`,
      `// ║  MUST be reviewed for ${this.frameworkName.padEnd(52)} ║`,
      `// ║  before this code will compile.                                              ║`,
      `// ╚════════════════════════════════════════════════════════════════════════════════╝`,
      transformed,
    ].join("\n");
  }

  protected transformHelperCode(code: string, ir?: SolanaIR): string {
    const stateTypes = new Set(ir?.accounts.map((acc) => acc.name) ?? []);
    return transformHelperCodeImpl(
      code,
      (event, fields) => this.emitEmit(event, fields),
      (message) => this.emitMsg(message),
      stateTypes,
    );
  }
}

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
} from "./emitter-utils.js";
import {
  emitBodyStatements as emitBodyStatementsImpl,
  type BodyEmitterContext,
  type BodyEmitterCallbacks,
  type Token2022Opts,
} from "./body-emitter/index.js";
import { transformHelperCode as transformHelperCodeImpl } from "./anchor-transforms.js";

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
   * pass-through emit produces E0609 without intervention. Quasar leaves it
   * unchanged because Quasar's `Account<Mint>` wrapper still has the field.
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
    // stripped. Pinocchio/Quasar still drop external-Solana crates because
    // their Cargo.toml doesn't ship those deps.
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
        // not on pinocchio/quasar (which use their own crate). Drop on
        // non-native. The anchor_lang::solana_program rewrite above means
        // a source `use anchor_lang::solana_program::X;` lands here as
        // `use solana_program::X;` and gets correctly stripped on those
        // targets while surviving on native.
        if (!isNative && /^use\s+solana_program(?:::|;)/.test(statement)) return false;
        // External crates: native carries them through (project-scaffold adds
        // matching deps to Cargo.toml). Pinocchio/Quasar filter them out
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

    for (const acc of ir.accounts) {
      sections.push(this.emitAccountStruct(acc));
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
      ir.errors.length > 0 ? `use crate::errors::*;` : "",
      this.hasHelperModule(ir) ? `use crate::helpers::*;` : "",
    ].filter(Boolean).join("\n");
    return `//! Instruction processors for ${toPascalCase(ir.name)}\n\n${preludes}\n\n${mods}\n`;
  }

  private emitInstructionFile(instr: Instruction, ir: SolanaIR): string {
    const raw = `use super::*;\n\n${this.emitInstructionFunction(instr, ir)}`;
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
    // review the generated block. Pinocchio/quasar don't expose realloc
    // directly — we emit a warning block so at least the requirement is
    // visible in the generated code.
    const reallocPreludes = instr.accounts
      .map((a) => this.emitReallocPrelude(a, instr))
      .filter(Boolean)
      .join("\n");

    // Body emission — the main event
    const rawBodyCode = this.emitBodyStatements(instr.body, instr, ir, preEmittedBumps);
    // Hook: lets target emitters post-process the assembled body (e.g. inject
    // `Mint::unpack` preludes when bare `<account>.decimals` survives from
    // Anchor source code, since neither native AccountInfo nor pinocchio
    // AccountInfo expose a `.decimals` field).
    const bodyCode = this.postProcessInstructionBody(rawBodyCode, instr, ir);

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
${initPreludes ? `\n${initPreludes}\n` : ""}${reallocPreludes ? `\n${reallocPreludes}\n` : ""}

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
  // representation ([u8;32] in Pinocchio, Pubkey in Native/Quasar).

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
    // Dynamically-sized / borsh-native types — String and Vec<T> don't have
    // `::from_le_bytes` and must round-trip through borsh like structs do.
    if (typeName === "String" || /^Vec<.+>$/.test(typeName)) {
      return `        let mut ${fieldName}_bytes = &data[offset..offset + ${size}];
        let ${fieldName}: ${typeName} = BorshDeserialize::deserialize(&mut ${fieldName}_bytes)
            .map_err(|_| ProgramError::InvalidAccountData)?;
        offset += ${size};`;
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
    // Dynamically-sized / borsh-native types — mirror the buildReadLine branch.
    if (typeName === "String" || /^Vec<.+>$/.test(typeName)) {
      return `        {
            let mut ${fieldName}_bytes = &mut data[offset..offset + ${size}];
            BorshSerialize::serialize(&value.${fieldName}, &mut ${fieldName}_bytes)
                .map_err(|_| ProgramError::InvalidAccountData)?;
        }
        offset += ${size};`;
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
   * from the first signer. Pinocchio / Quasar don't expose realloc at the
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

    if (this.frameworkName === "Native") {
      return `    // realloc — resize ${accountName} to ${sizeExpr}
    {
        let __new_size = (${sizeExpr}) as usize;
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

    // Pinocchio / Quasar: leave a warning so the user wires realloc manually
    // using the framework-native API (pinocchio::account_info::realloc is
    // gated behind a nightly feature as of 0.9).
    return `    // ⚠️ Anvil: \`realloc = ${sizeExpr}\` on \`${accountName}\`
    //   Pinocchio/Quasar don't expose AccountInfo::realloc in the stable API.
    //   After porting, wire the resize manually (e.g., split into
    //   close-and-recreate, or target the native backend which emits realloc
    //   + rent top-up automatically).`;
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
    return `    let mut ${localVar} = if ${accountInfoVar}.data_is_empty() {
        ${initStruct}
    } else {
        ${typeName}::from_account_info(${accountInfoVar})?
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

/**
 * Wrap an unsalvageable helper's full source in a single-line-prefixed
 * comment block with a TODO marker at the top. Used by emitHelpersFile
 * when the helper signature/body uses Anchor types that don't exist on
 * the target. Single-file output uses the same wrapper.
 *
 * Line-prefix `// ` (vs block `/* ... *​/`) is safer because the source
 * may itself contain `*​/` inside doc comments or string literals; a
 * single line-prefix sweep is unambiguous.
 */
function commentOutHelperBlock(rawCode: string, name: string, frameworkName: string): string {
  const banner = [
    `// ╔════════════════════════════════════════════════════════════════════════════╗`,
    `// ║  ⚠️  ANVIL TODO: helper '${name}' uses Anchor-only types`,
    `// ║  (InterfaceAccount, Interface<TokenInterface>, Box<Account>, etc.) that`,
    `// ║  don't exist on ${frameworkName}. Body commented out below; instruction call sites`,
    `// ║  are also commented out so the program compiles. MANUAL PORT REQUIRED.`,
    `// ╚════════════════════════════════════════════════════════════════════════════╝`,
  ].join("\n");
  const commented = rawCode
    .split("\n")
    .map((line) => (line.length > 0 ? `// ${line}` : "//"))
    .join("\n");
  return `${banner}\n${commented}`;
}

/**
 * Post-process emitted instruction file text to comment out any statement
 * that calls an unsalvageable helper. Statement boundaries: from the
 * previous `;` (or block-open `{`) to the matching trailing `;` or `?;`.
 *
 * The pass is text-level rather than IR-level because the emitter renders
 * pass_through statements verbatim from the parsed source — we don't have
 * a clean IR-level "this statement is a helper call" hook. Conservative:
 * only triggers on `<helperName>(` after a word boundary, and only on
 * statements where that's the dominant call.
 */
function commentOutUnsalvageableCallSites(text: string, helpers: Set<string>): string {
  if (helpers.size === 0) return text;
  const helperPattern = new RegExp(
    `\\b(?:${[...helpers].map((h) => h.replace(/[.*+?^${}()|[\\\]\\\\]/g, "\\\\$&")).join("|")})\\s*\\(`,
    "g",
  );
  let out = "";
  let lineStart = 0;
  const lines = text.split("\n");
  // Walk lines, marking those that are part of a call-site statement that
  // hits an unsalvageable helper. We scan the FULL text once for matches,
  // then for each match expand backward to the start of its statement
  // (previous `;` or `{`) and forward to its terminating `;`.
  const ranges: { startLine: number; endLine: number }[] = [];
  let m: RegExpExecArray | null;
  helperPattern.lastIndex = 0;
  while ((m = helperPattern.exec(text)) !== null) {
    const matchOffset = m.index;
    // Walk backward to find the statement start.
    let depth = 0;
    let stmtStart = 0;
    let stopChar: string | null = null;
    let stopPrevChar: string | null = null;
    for (let i = matchOffset - 1; i >= 0; i--) {
      const ch = text[i];
      if (ch === ")" || ch === "}" || ch === "]") depth++;
      else if (ch === "(" || ch === "{" || ch === "[") {
        if (depth === 0) { stmtStart = i + 1; stopChar = ch; break; }
        depth--;
      } else if ((ch === ";" || ch === "\n") && depth === 0) {
        // Only treat `;` as a hard boundary; `\n` we use only as a soft
        // hint (let-bindings can span lines). Continue scanning unless we
        // also see a clear semicolon or block boundary.
        if (ch === ";") {
          stmtStart = i + 1;
          stopChar = ch;
          // The char just before this `;` tells us whether it's `};`
          // (block-closer + stmt terminator) vs `expr;` (normal stmt end).
          // Walk back over whitespace to find the meaningful char.
          let j = i - 1;
          while (j >= 0 && /\s/.test(text[j] ?? "")) j--;
          stopPrevChar = j >= 0 ? text[j] ?? null : null;
          break;
        }
      }
    }
    // Walk forward to find the statement end (trailing `;` at depth 0).
    let fwdDepth = 0;
    let stmtEnd = text.length;
    for (let i = matchOffset; i < text.length; i++) {
      const ch = text[i];
      if (ch === "(" || ch === "{" || ch === "[") fwdDepth++;
      else if (ch === ")" || ch === "}" || ch === "]") fwdDepth--;
      else if (ch === ";" && fwdDepth === 0) { stmtEnd = i + 1; break; }
    }
    // Block-closer detection: when the walk-back stopped at a `;` whose
    // preceding non-whitespace was `}`, that's a `};` shape — the line
    // also contains the closer of an outer block (e.g. `let X = { … };`)
    // that we MUST NOT comment out. Advance stmtStart past the trailing
    // `;\n` to the next line.
    //
    // Same advance for `?;` shape: the prior statement is a `?`-postfix
    // fallible call (real CPI invocation, helper that returns Result, etc.)
    // — almost certainly NOT orphan setup. Without this, the new ATA-init
    // prelude (`invoke(…)?;` for the vault) gets swallowed when the body
    // also calls an unsalvageable helper. escrow2025/native demonstrated
    // the cross-statement sweep producing a syntax error.
    //
    // For non-block `;` (preceding char `)`, ident, literal — i.e. the
    // tail of `let X = …;` shape) we keep the original behavior, including
    // the `;` line in the comment range. This cleans up orphan setup
    // let-bindings (CpiContext / cpi_program / cpi_accounts) whose only
    // consumer was the commented helper call.
    let normalizedStart = stmtStart;
    if (stopChar === ";" && (stopPrevChar === "}" || stopPrevChar === "?")) {
      while (normalizedStart < text.length && /[ \t]/.test(text[normalizedStart] ?? "")) normalizedStart++;
      if (text[normalizedStart] === "\n") normalizedStart++;
    }
    // Convert offsets to line numbers.
    const startLine = text.slice(0, normalizedStart).split("\n").length - 1;
    const endLine = text.slice(0, stmtEnd).split("\n").length - 1;
    ranges.push({ startLine, endLine });
  }
  if (ranges.length === 0) return text;
  // Build a "comment-out" set of line indices.
  const commentOut = new Set<number>();
  for (const r of ranges) {
    for (let i = r.startLine; i <= r.endLine; i++) commentOut.add(i);
  }
  let prevCommented = false;
  for (let i = 0; i < lines.length; i++) {
    if (commentOut.has(i)) {
      if (!prevCommented) {
        out += `// ⚠️ Anvil TODO: call site of unsalvageable helper commented out — manual port required\n`;
      }
      const original = lines[i] ?? "";
      out += `// ${original}` + (i < lines.length - 1 ? "\n" : "");
      prevCommented = true;
    } else {
      out += (lines[i] ?? "") + (i < lines.length - 1 ? "\n" : "");
      prevCommented = false;
    }
  }
  return out;
}

/**
 * Drop the trailing `offset += N;` from a field-read/write block when it's
 * the last field — nothing reads `offset` after the final field, so rustc
 * complains "value assigned to `offset` is never read". Per-field templates
 * always emit the increment for uniformity; we strip it here once we know
 * we're at the end of the loop.
 */
function stripTrailingOffsetBump(block: string, isLast: boolean): string {
  if (!isLast) return block;
  return block.replace(/\n\s*offset\s*\+=\s*\d+\s*;\s*$/, "");
}

/**
 * Prefix unused prophylactic bindings with `_` so rustc doesn't warn about
 * them. We emit account bindings (`let X = &accounts[N];`) and bump
 * derivations (`let bump_X = bump_seed(...);`) prophylactically — every
 * instruction binds every account in its Context struct, every PDA gets a
 * bump derived. Most instructions use most of these; some don't. Renaming
 * the unused ones to `_X` is the idiomatic Rust signal that the binding
 * is intentional and inert.
 *
 * Scoped narrowly: we only touch the two binding shapes we know we emit.
 * Generic "find unused let" would be too broad and risk renaming bindings
 * the body uses indirectly (through macros, nested closures, etc.).
 */
function prefixUnusedProphylacticBindings(fn: string): string {
  const isUnused = (name: string): boolean => {
    if (name.startsWith("_")) return false;
    const re = new RegExp(`\\b${name}\\b`, "g");
    return (fn.match(re) ?? []).length <= 1;
  };

  // Pattern A — account slice bindings. Two forms emitInstructionFunction emits:
  //   let X = &accounts[N];
  //   let X = accounts.get(N);                  (optional accounts)
  // Pattern B — bump_X bindings via the pinocchio bump_seed helper.
  let out = fn.replace(
    /^(\s*let\s+(?:mut\s+)?)([a-zA-Z_]\w*)(\s*=\s*(?:&accounts\[\d+\]|accounts\.get\(\d+\)|bump_seed\([\s\S]*?\)\?)\s*;)/gm,
    (full, prefix: string, name: string, after: string) =>
      isUnused(name) ? `${prefix}_${name}${after}` : full,
  );

  // Pattern C — tuple-destructured PDA derivation, native target.
  //   let (expected_key, bump_X) = Pubkey::find_program_address(…);
  // Both names checked independently because the common case is that
  // expected_key is verified (the verify check uses it) while bump_X is
  // only useful if the same instruction needs a PDA-signed CPI later.
  out = out.replace(
    /^(\s*let\s+\()([a-zA-Z_]\w*)(\s*,\s*)([a-zA-Z_]\w*)(\)\s*=\s*Pubkey::find_program_address\([\s\S]*?\);)/gm,
    (full, head: string, a: string, sep: string, b: string, tail: string) => {
      const renamedA = isUnused(a) ? `_${a}` : a;
      const renamedB = isUnused(b) ? `_${b}` : b;
      if (renamedA === a && renamedB === b) return full;
      return `${head}${renamedA}${sep}${renamedB}${tail}`;
    },
  );

  return out;
}

/**
 * Promote a leading `fn NAME(...)` to `pub fn NAME(...)` so the carried helper
 * is visible across the multi-file module graph. In single-file mode `pub`
 * is a no-op; in multi-file mode `use crate::helpers::*` only re-exports
 * `pub` items, so a private `fn vested_amount` silently disappears and
 * `instructions/*.rs` gets `cannot find function` at cargo build.
 *
 * Matches only the first top-level free-function signature (optionally with
 * leading whitespace, comments, or attributes). Impl blocks, trait methods,
 * and already-`pub`/`pub(crate)` functions pass through unchanged.
 */
function promoteFreeFnVisibility(code: string): string {
  return code.replace(
    /^((?:\s*(?:\/\/[^\n]*|\/\*[\s\S]*?\*\/|#\[[^\]]*\])\n?)*\s*)fn(\s+[A-Za-z_]\w*\s*[<(])/,
    "$1pub fn$2",
  );
}

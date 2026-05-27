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
  HelperFn,
} from "../ir/schema.js";
import { decodeBase58, rewriteRequireVariantsInCode } from "../parser/project-source.js";

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
  hasResidualUnsupportedBody,
  hasUnsalvageableHelperSignature,
  recognizeCpiWrapperHelper,
} from "./emitter-helpers.js";

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
import { transformHelperCode as transformHelperCodeImpl, rewriteMsgCalls as rewriteMsgCallsImpl, rewriteSelfReferences, collapseModulePaths, rewriteCtxAccountsDestructure } from "./anchor-transforms.js";
import { hasResidualAnchorPatterns, hasResidualUnsalvageablePatterns, hasResidualUnsupportedBody, hasUnsalvageableHelperSignature, recognizeCpiWrapperHelper, rewriteCpiWrapperCallSites } from "./emitter-helpers.js";
import {
  commentOutHelperBlock,
  commentOutUnsalvageableCallSites,
  commentOutResidualAnchorLeaks,
  generateExternalTypeStubs,
  stripTrailingOffsetBump,
  prefixUnusedProphylacticBindings,
  promoteFreeFnVisibility,
  promoteImplFnVisibility,
} from "./emitter-base-utils.js";
import { getParserSync, type SyntaxNode } from "../parser/ts-init.js";
import { MARKER_ANVIL_TODO_PREFIX, MARKER_ANVIL_PREFIX } from "./markers.js";

export const FRAMEWORK_SHADOW_TYPES = new Set([
  "Pubkey", "AccountInfo", "AccountMeta", "Instruction",
  "ProgramError", "ProgramResult",
]);

/**
 * G22 — given a generic-params clause like `<'a, 'info: 'a>` or
 * `<T: Trait + Send, U: Clone + 'static>`, return the bare-param form
 * `<'a, 'info>` / `<T, U>` for type-instantiation use. Empty input → "".
 *
 * Depth-aware split on `,` (angle brackets tracked), then per-param trim
 * everything after the first `:` at depth 0.
 */
function stripGenericBounds(generics: string): string {
  const trimmed = generics.trim();
  if (trimmed.length === 0) return "";
  // Strip leading `<` and trailing `>` so we can split the inside.
  let inside = trimmed;
  if (inside.startsWith("<") && inside.endsWith(">")) {
    inside = inside.slice(1, -1);
  }
  if (inside.length === 0) return generics; // empty inside — preserve
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < inside.length; i++) {
    const c = inside[i];
    if (c === "<") depth++;
    else if (c === ">") depth--;
    else if (c === "," && depth === 0) {
      parts.push(inside.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(inside.slice(start));
  const bareParts = parts.map((p) => {
    const t = p.trim();
    // Cut at first `:` at depth 0.
    let d = 0;
    for (let i = 0; i < t.length; i++) {
      const c = t[i];
      if (c === "<") d++;
      else if (c === ">") d--;
      else if (c === ":" && d === 0) return t.slice(0, i).trim();
    }
    return t;
  });
  return `<${bareParts.join(", ")}>`;
}

// ─── Abstract Emitter Interface ──────────────────────────────────────────────

export abstract class BaseEmitter {
  abstract readonly frameworkName: string;
  protected currentIr: SolanaIR | null = null;
  /** G45 — context shuttled from emitAccountStructsFile/Single down to
   *  emitAccountStruct (which doesn't take IR as a parameter today).
   *  Used by per-target emitInherentImplItems to access knownTopLevelNames
   *  for collapseModulePaths. */
  protected _irForAccountEmit: SolanaIR | undefined = undefined;

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

  // ── Token-2022 extension CPIs (EM2) ──
  // Initialize the NonTransferable mint extension. Single-instruction
  // family — no manage/update CPIs. Must be called before
  // initialize_mint (extension data lives in the same allocated mint
  // buffer ahead of the standard mint header).
  abstract emitT22NonTransferableMintInitialize(
    mint: string,
    tokenProgram: string,
    signerSeeds?: string,
  ): string;

  // Finding #44 — direct initialize_mint2 CPI. STANDALONE form (not the
  // constraint-style init which routes via emitInitAccountPrelude →
  // emitCreateMint). Used by T22 programs that manually compose
  // create_account + extension_init + initialize_mint2 because Anchor
  // 0.32 lacks constraint syntax for some extensions (NonTransferable).
  // tokenProgram is the AccountInfo binding for runtime-dispatch.
  abstract emitT22InitializeMint2(
    mint: string,
    tokenProgram: string,
    decimals: string,
    mintAuthority: string,
    freezeAuthority: string,
    signerSeeds?: string,
  ): string;

  // Initialize the TransferFee mint extension. Sets the fee config
  // authority, withdraw authority, basis points, and per-transfer cap.
  // Must precede initialize_mint (extension data lives ahead of the
  // standard mint header in the allocated mint buffer).
  abstract emitT22TransferFeeInitialize(
    mint: string,
    tokenProgram: string,
    transferFeeConfigAuthority: string,
    withdrawWithheldAuthority: string,
    basisPoints: string,
    maximumFee: string,
    signerSeeds?: string,
  ): string;

  // Update the TransferFee schedule on an existing mint. 2-epoch delay
  // before the new fees take effect.
  abstract emitT22TransferFeeSetFee(
    mint: string,
    tokenProgram: string,
    authority: string,
    basisPoints: string,
    maximumFee: string,
    signerSeeds?: string,
  ): string;

  // Initialize the ImmutableOwner extension on a token account. Single
  // instruction, no manage CPIs. Discriminator 22 (top-level
  // TokenInstruction enum), no payload, accounts = [token_account
  // writable].
  abstract emitT22ImmutableOwnerInitialize(
    tokenAccount: string,
    tokenProgram: string,
    signerSeeds?: string,
  ): string;

  // Initialize the MintCloseAuthority extension on a mint. Single
  // instruction, no manage CPIs (close uses the regular close_account
  // CPI). Discriminator 25; payload = COption<Pubkey>;
  // accounts = [mint writable].
  abstract emitT22MintCloseAuthorityInitialize(
    mint: string,
    tokenProgram: string,
    closeAuthority: string,
    signerSeeds?: string,
  ): string;

  // Initialize the PermanentDelegate extension on a mint. Single
  // instruction (permanent — no manage CPIs). Discriminator 35; payload
  // = Pubkey (32 bytes, REQUIRED); accounts = [mint writable].
  abstract emitT22PermanentDelegateInitialize(
    mint: string,
    tokenProgram: string,
    delegate: string,
    signerSeeds?: string,
  ): string;

  // Initialize the TransferHook extension on a mint. Parent
  // discriminator 36 + sub-discriminator 0; payload = two
  // OptionalNonZeroPubkey (flat 32 bytes each, all-zero = None) =
  // 64 bytes; accounts = [mint writable]. Different byte layout from
  // MintCloseAuthority's COption-tagged form.
  abstract emitT22TransferHookInitialize(
    mint: string,
    tokenProgram: string,
    authority: string,
    transferHookProgramId: string,
    signerSeeds?: string,
  ): string;

  // Update the TransferHook program id on a mint that already has the
  // extension. Parent disc 36 + sub-disc 1; payload = single
  // OptionalNonZeroPubkey (32 bytes); accounts = [mint writable,
  // authority readonly+signer].
  abstract emitT22TransferHookUpdate(
    mint: string,
    tokenProgram: string,
    authority: string,
    transferHookProgramId: string,
    signerSeeds?: string,
  ): string;

  // Initialize the MetadataPointer extension on a mint. Parent disc 39
  // + sub-disc 0; payload = two OptionalNonZeroPubkey (64 bytes total);
  // accounts = [mint writable]. Same wire layout as TransferHook init,
  // different parent discriminator.
  abstract emitT22MetadataPointerInitialize(
    mint: string,
    tokenProgram: string,
    authority: string,
    metadataAddress: string,
    signerSeeds?: string,
  ): string;

  // Update the MetadataPointer pointer address on a mint that already
  // has the extension. Parent disc 39 + sub-disc 1; payload = single
  // OptionalNonZeroPubkey (32 bytes); accounts = [mint writable,
  // authority readonly+signer]. anchor-spl 0.31/0.32 doesn't expose a
  // wrapper, so source uses raw spl_token_2022 — this typed slot
  // routes both targets to a working CPI (Native: spl_token_2022
  // helper; Pinocchio: hand-rolled raw bytes).
  abstract emitT22MetadataPointerUpdate(
    mint: string,
    tokenProgram: string,
    authority: string,
    metadataAddress: string,
    signerSeeds?: string,
  ): string;

  // GroupPointer init/update. Parent disc 40, sub 0/1. Init payload =
  // 2× OptionalNonZeroPubkey; Update payload = 1× OptionalNonZeroPubkey
  // and requires the authority signer.
  abstract emitT22GroupPointerInitialize(
    mint: string,
    tokenProgram: string,
    authority: string,
    groupAddress: string,
    signerSeeds?: string,
  ): string;

  abstract emitT22GroupPointerUpdate(
    mint: string,
    tokenProgram: string,
    authority: string,
    groupAddress: string,
    signerSeeds?: string,
  ): string;

  // GroupMemberPointer init/update. Same shape as GroupPointer, parent
  // disc 41.
  abstract emitT22GroupMemberPointerInitialize(
    mint: string,
    tokenProgram: string,
    authority: string,
    memberAddress: string,
    signerSeeds?: string,
  ): string;

  abstract emitT22GroupMemberPointerUpdate(
    mint: string,
    tokenProgram: string,
    authority: string,
    memberAddress: string,
    signerSeeds?: string,
  ): string;

  // TransferFee variant of transfer_checked. Required when a mint has
  // the TransferFee extension — caller asserts decimals + the
  // expected fee, Token-2022 verifies both.
  abstract emitT22TransferCheckedWithFee(
    source: string,
    mint: string,
    destination: string,
    authority: string,
    tokenProgram: string,
    amount: string,
    decimals: string,
    fee: string,
    signerSeeds?: string,
  ): string;

  // Withdraw fees that have been harvested into the mint to a
  // destination token account. Called by the withdraw_withheld
  // authority configured at TransferFee init.
  abstract emitT22WithdrawWithheldFromMint(
    mint: string,
    destination: string,
    authority: string,
    tokenProgram: string,
    signerSeeds?: string,
  ): string;

  // Sweep fees from a list of source token accounts into the mint's
  // withheld pool. Sources is a runtime-length list (typically
  // ctx.remaining_accounts), so the emit must build the account-meta
  // list dynamically.
  abstract emitT22HarvestWithheldToMint(
    mint: string,
    tokenProgram: string,
    sourcesExpr: string,
    signerSeeds?: string,
  ): string;

  // DefaultAccountState: set the default state (Initialized / Frozen)
  // newly-minted token accounts will start in. Init = no authority,
  // update = freeze_authority signer.
  abstract emitT22DefaultAccountStateInitialize(
    mint: string,
    tokenProgram: string,
    state: string,
    signerSeeds?: string,
  ): string;
  abstract emitT22DefaultAccountStateUpdate(
    mint: string,
    tokenProgram: string,
    freezeAuthority: string,
    state: string,
    signerSeeds?: string,
  ): string;

  // InterestBearingMint: configure / update the interest rate (bps,
  // can be negative) for UI amount display. Init takes Option<Pubkey>
  // rate authority + i16 rate; update_rate takes only i16 + rate auth
  // signer.
  abstract emitT22InterestBearingMintInitialize(
    mint: string,
    tokenProgram: string,
    rateAuthority: string,
    rate: string,
    signerSeeds?: string,
  ): string;
  abstract emitT22InterestBearingMintUpdateRate(
    mint: string,
    tokenProgram: string,
    rateAuthority: string,
    rate: string,
    signerSeeds?: string,
  ): string;

  // TokenMetadata: initialize the metadata for a Token-2022 mint via
  // the spl-token-metadata-interface protocol. Native uses the
  // canonical helper; Pinocchio = TODO commentout (own protocol shim
  // layer required — sha256 disc + Borsh strings).
  abstract emitT22TokenMetadataInitialize(
    metadata: string,
    mint: string,
    mintAuthority: string,
    updateAuthority: string,
    tokenProgram: string,
    name: string,
    symbol: string,
    uri: string,
    signerSeeds?: string,
  ): string;

  // TokenMetadata: update one of the metadata fields (Name | Symbol |
  // Uri | Key(<custom>)). Discriminator sha256("...:updating_field")[..8].
  // Native uses the spl_token_metadata_interface helper; Pinocchio
  // statically maps Field::* literal expressions to byte sequences
  // (TODO commentout fallback for non-literal field expressions).
  abstract emitT22TokenMetadataUpdateField(
    metadata: string,
    updateAuthority: string,
    tokenProgram: string,
    field: string,
    value: string,
    signerSeeds?: string,
  ): string;

  // TokenMetadata: rotate the update_authority. Discriminator
  // sha256("...:update_the_authority")[..8]. Wire payload is
  // OptionalNonZeroPubkey (32 bytes always — zero-filled = None).
  // Native uses the spl_token_metadata_interface helper; Pinocchio
  // recognises `OptionalNonZeroPubkey::try_from(None|Some(...))?`
  // literal patterns + emits the corresponding 32-byte payload.
  abstract emitT22TokenMetadataUpdateAuthority(
    metadata: string,
    currentAuthority: string,
    tokenProgram: string,
    newAuthority: string,
    signerSeeds?: string,
  ): string;

  abstract emitProgramAccountClose(account: string, destination: string): string;
  abstract emitCreateProgramAccount(
    account: string,
    payer: string,
    spaceExpr: string,
    signerSeeds?: string,
  ): string;

  /**
   * Write the 8-byte discriminator to a freshly-init'd state account.
   * Called by emitInitAccountPrelude immediately after the
   * create_program_account CPI when the account type is a user-defined
   * state struct (Account<'info, T>). Mirrors Anchor's #[account] macro
   * which writes the discriminator atomically with init. Targets differ
   * in how they get a &mut [u8] to the account data buffer:
   *   Pinocchio: `unsafe { account.borrow_mut_data_unchecked() }`
   *   Native:    `account.data.borrow_mut()` (RefMut from RefCell)
   */
  abstract emitDiscriminatorWrite(accountName: string, typeName: string, discLen?: number): string;

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

  /**
   * Init an SPL Mint from `init mint::decimals = N, mint::authority = X` plus
   * optional `mint::freeze_authority = Y`. Two CPIs: system::create_account
   * (82 bytes, owner=token_program) + Token::initialize_mint2 (discriminator
   * 20). InitializeMint2 instead of InitializeMint avoids needing the Rent
   * sysvar in the accounts list (Anchor 0.28+ default). When the mint is a
   * fresh keypair the create_account is invoke()'d account-as-signer; for
   * the unusual PDA-mint case the signer seeds are threaded through.
   */
  abstract emitCreateMint(
    account: string,
    payer: string,
    decimals: string,
    mintAuthority: string,
    freezeAuthority: string | null,
    signerSeeds?: string,
    /**
     * Optional snake_case binding name of the runtime token_program sibling
     * in the Accounts struct. When set, the emit reads the program ID from
     * that AccountInfo at runtime instead of hardcoding the legacy SPL
     * Token ID — necessary for `Interface<'info, TokenInterface>` shapes
     * that runtime-dispatch between Token and Token-2022. When unset,
     * falls back to the legacy hardcoded ID.
     */
    tokenProgram?: string,
    mintSpace?: number,
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
  // emit*Get → full let-binding statement (`    let X = path::Sysvar::get()?;`).
  // emit*GetExpr → bare expression form (`path::Sysvar::get()?<.field>`); used by
  //   walker post-processors that substitute `Clock::get()?` / `Rent::get()?` text
  //   inside pass-through bodies.
  // emit*GetExprNoTry → same without the `?` suffix; for the rare source form
  //   that wrote `Clock::get()` (no try) and wants the `Result<Clock>` value.
  abstract emitClockGet(localVar: string, field?: string): string;
  abstract emitRentGet(localVar: string, field?: string): string;
  abstract emitClockGetExpr(field?: string): string;
  abstract emitClockGetExprNoTry(field?: string): string;
  abstract emitRentGetExpr(field?: string): string;
  abstract emitRentGetExprNoTry(field?: string): string;

  // ── Type mapping ──
  abstract rustTypeForFramework(typeName: string): string;

  // ── M2b / N5 — Pyth oracle read (legacy + modern) ──
  // Both targets hand-roll the byte deserialization. Pre-N5b the Native
  // arm tried to re-use the pyth crates (pyth-sdk-solana for legacy,
  // pyth-solana-receiver-sdk for modern) but those crates' borsh-derive
  // proc-macros conflict with Anvil's borsh-1.5 pin — see
  // posts/plan-pyth-m2.md "cargo-compat ceiling". Unifying on
  // hand-rolled bytes drops the pyth dependency entirely. Trade-off:
  // we maintain offsets ourselves; benefit: emit compiles cleanly.
  //
  // Layout is target-portable. Clock sourced via emitClockGetExpr so
  // each subclass's correct sysvar path is used.
  /**
   * task #47 — Switchboard On-Demand PullFeed reader.
   *
   * Anchor source pattern:
   *   let feed = PullFeedAccountData::parse(&ctx.accounts.feed.data.borrow())?;
   *   let price = feed.value().ok_or(...)?;
   *
   * Emit hand-rolls byte deserialization from the documented PullFeed
   * account layout, drops the switchboard-on-demand crate dep, and
   * produces an `f64` bound to `priceBinding`.
   *
   * **OFFSETS PENDING BYTE-EQUAL VERIFICATION.** The layout is sourced
   * from the public switchboard-on-demand 0.x crate's PullFeedAccountData
   * struct. Byte-equal differential gate is deferred until a
   * switchboard-on-demand `.so` fixture lands (per docs/plan-switchboard.md).
   * Until then, the emit produces compilable code that reads the
   * documented offsets — verify against current Switchboard source
   * before deploy. Mirrors the Pyth M2a iterative-offset-validation path.
   *
   * Layout reference (zero_copy struct, offsets from start of account
   * data; subtract 8 bytes if reading from a post-discriminator slice):
   *   0..8         Anchor discriminator
   *   8..40        submitter (Pubkey)
   *   40..48       max_variance (u64)
   *   48..52       min_responses (u32)
   *   52..56       padding
   *   56..88       name ([u8; 32])
   *   88..120      queue (Pubkey)
   *   120..152     feed_hash ([u8; 32])
   *   152..160     initialized_at (i64)
   *   160..168     permissions (u64)
   *   168..176     max_staleness (u64)
   *   176..200     padding (24 bytes)
   *   200..216     result.value (i128, scaled by 10^18)
   *   216..232     result.std_dev
   *   232..248     result.mean
   *   248..264     result.range
   *   264..280     result.min_value
   *   280..296     result.max_value
   *   296..304     result.slot (u64)
   *   ...
   *
   * `feed.value()` returns Option<f64>: None when slot is 0 (no
   * publication yet), Some(value) otherwise. Anchor's source uses
   * `.ok_or(...)?` to propagate; our emit collapses that into a single
   * compile path with `staleErrExpr` controlling the None arm.
   *
   * Both Pinocchio + Native share this implementation — pure byte reads
   * with no target-specific primitive.
   */
  emitSwitchboardReadFeed(
    feedAccount: string,
    priceBinding: string,
    staleErrExpr: string | undefined,
    maxStalenessSlots: string | undefined,
  ): string {
    const errArm = staleErrExpr
      ? `return Err((${staleErrExpr}).into());`
      : `return Err(ProgramError::Custom(0));`;
    // PRECISION = 10^18 for Switchboard On-Demand i128 → f64 conversion.
    // Cast through f64 since pinocchio is no_std and we can't use
    // num-bigint-style arbitrary-precision; the precision loss above
    // 2^52 mantissa is unavoidable and matches the SDK's `as f64` cast.
    const stalenessGate = maxStalenessSlots
      ? [
          `    let __sb_now_slot = ${this.emitClockGetExpr("slot")};`,
          `    if __sb_now_slot.saturating_sub(__sb_slot) > (${maxStalenessSlots}) as u64 {`,
          `        ${errArm}`,
          `    }`,
        ].join("\n")
      : `    if __sb_slot == 0 { ${errArm} }`;
    return [
      `    // task #47 — Switchboard On-Demand PullFeed read (hand-rolled)`,
      `    let __sb_data = ${feedAccount}.try_borrow_data()?;`,
      `    if __sb_data.len() < 304 {`,
      `        return Err(ProgramError::InvalidAccountData);`,
      `    }`,
      `    // result.value (i128 scaled by 10^18) at offset 200`,
      `    let __sb_value_bytes: [u8; 16] = __sb_data[200..216]`,
      `        .try_into().map_err(|_| ProgramError::InvalidAccountData)?;`,
      `    let __sb_value_i128 = i128::from_le_bytes(__sb_value_bytes);`,
      `    // result.slot (u64) at offset 296 — 0 means no publication yet`,
      `    let __sb_slot_bytes: [u8; 8] = __sb_data[296..304]`,
      `        .try_into().map_err(|_| ProgramError::InvalidAccountData)?;`,
      `    let __sb_slot = u64::from_le_bytes(__sb_slot_bytes);`,
      stalenessGate,
      `    // PRECISION = 18 decimal places — divide by 10^18 for f64 result`,
      `    let ${priceBinding}: f64 = (__sb_value_i128 as f64) / 1_000_000_000_000_000_000.0;`,
    ].join("\n");
  }

  emitPythReadPriceLegacy(
    feedAccount: string,
    priceBinding: string,
    _clockExpr: string,
    maxAgeExpr: string,
    staleErrExpr: string | undefined,
  ): string {
    // Documented PriceAccountV2 offsets from pyth-sdk-solana 0.10
    // PriceAccount struct. Magic at 0..4 (0xa1b2c3d4) fails loud on
    // wrong account type; agg block at 208..224.
    //
    // staleErrExpr comes from the source `.ok_or(ErrorCode::Stale)?`
    // arm. The original `?` converted the error type via From; our
    // direct `return Err(...)` won't auto-convert, so append `.into()`
    // when the expression isn't already a ProgramError literal.
    const errArm = staleErrExpr
      ? `return Err((${staleErrExpr}).into());`
      : `return Err(ProgramError::Custom(0xa1b2c3d4));`;
    const clockTs = this.emitClockGetExpr("unix_timestamp");
    return [
      `    let __pyth_data = ${feedAccount}.try_borrow_data()?;`,
      `    if __pyth_data.len() < 240 {`,
      `        return Err(ProgramError::InvalidAccountData);`,
      `    }`,
      `    // PriceAccountV2 magic = 0xa1b2c3d4 ("pyth" LE)`,
      `    if u32::from_le_bytes(__pyth_data[0..4].try_into().map_err(|_| ProgramError::InvalidAccountData)?) != 0xa1b2c3d4 {`,
      `        return Err(ProgramError::InvalidAccountData);`,
      `    }`,
      `    let __pyth_expo = i32::from_le_bytes(__pyth_data[20..24].try_into().map_err(|_| ProgramError::InvalidAccountData)?);`,
      `    let __pyth_publish_time = i64::from_le_bytes(__pyth_data[96..104].try_into().map_err(|_| ProgramError::InvalidAccountData)?);`,
      `    let __pyth_price = i64::from_le_bytes(__pyth_data[208..216].try_into().map_err(|_| ProgramError::InvalidAccountData)?);`,
      `    let __pyth_conf = u64::from_le_bytes(__pyth_data[216..224].try_into().map_err(|_| ProgramError::InvalidAccountData)?);`,
      `    let __pyth_now = ${clockTs};`,
      `    if __pyth_now.saturating_sub(__pyth_publish_time) > (${maxAgeExpr}) as i64 {`,
      `        ${errArm}`,
      `    }`,
      `    pub struct AnvilPythPrice {`,
      `        pub price: i64,`,
      `        pub conf: u64,`,
      `        pub exponent: i32,`,
      `        pub publish_time: i64,`,
      `    }`,
      `    let ${priceBinding} = AnvilPythPrice {`,
      `        price: __pyth_price,`,
      `        conf: __pyth_conf,`,
      `        exponent: __pyth_expo,`,
      `        publish_time: __pyth_publish_time,`,
      `    };`,
    ].join("\n");
  }

  emitPythReadPriceModern(
    priceUpdateAccount: string,
    priceBinding: string,
    _clockExpr: string,
    maxAgeExpr: string,
    feedIdExpr: string,
  ): string {
    // PriceUpdateV2 layout (pyth-solana-receiver-sdk 0.6):
    //   0..8     Anchor discriminator
    //   8..40    write_authority (Pubkey)
    //   40       verification_level Borsh tag (0=Partial+u8, 1=Full)
    //   41       num_signatures (Partial only)
    //   ...      84B PriceFeedMessage (32B feed_id + i64+u64+i32+i64+i64+i64+u64)
    //   ...      8B posted_slot
    // verification_level > 1 fails loud — catches silent layout
    // version bumps (silent wrong-price = money loss).
    const clockTs = this.emitClockGetExpr("unix_timestamp");
    const feedIdRaw = feedIdExpr.replace(/^&/, "").trim();
    return [
      `    let __pyth_data = ${priceUpdateAccount}.try_borrow_data()?;`,
      `    if __pyth_data.len() < 50 {`,
      `        return Err(ProgramError::InvalidAccountData);`,
      `    }`,
      `    let __pyth_vl_tag = __pyth_data[40];`,
      `    if __pyth_vl_tag > 1u8 {`,
      `        return Err(ProgramError::Custom(0xa1b2c3e0));`,
      `    }`,
      `    let __pyth_msg_off: usize = if __pyth_vl_tag == 0u8 { 42 } else { 41 };`,
      `    if __pyth_data.len() < __pyth_msg_off + 84 {`,
      `        return Err(ProgramError::InvalidAccountData);`,
      `    }`,
      `    let __pyth_feed_id = &__pyth_data[__pyth_msg_off..__pyth_msg_off + 32];`,
      `    if __pyth_feed_id != &${feedIdRaw}[..] {`,
      `        return Err(ProgramError::Custom(0xfeed1d));`,
      `    }`,
      `    let __pyth_price = i64::from_le_bytes(__pyth_data[__pyth_msg_off + 32..__pyth_msg_off + 40].try_into().map_err(|_| ProgramError::InvalidAccountData)?);`,
      `    let __pyth_conf = u64::from_le_bytes(__pyth_data[__pyth_msg_off + 40..__pyth_msg_off + 48].try_into().map_err(|_| ProgramError::InvalidAccountData)?);`,
      `    let __pyth_expo = i32::from_le_bytes(__pyth_data[__pyth_msg_off + 48..__pyth_msg_off + 52].try_into().map_err(|_| ProgramError::InvalidAccountData)?);`,
      `    let __pyth_publish_time = i64::from_le_bytes(__pyth_data[__pyth_msg_off + 52..__pyth_msg_off + 60].try_into().map_err(|_| ProgramError::InvalidAccountData)?);`,
      `    let __pyth_now = ${clockTs};`,
      `    if __pyth_now.saturating_sub(__pyth_publish_time) > (${maxAgeExpr}) as i64 {`,
      `        return Err(ProgramError::Custom(0xa1b2c3d4));`,
      `    }`,
      `    pub struct AnvilPythPrice {`,
      `        pub price: i64,`,
      `        pub conf: u64,`,
      `        pub exponent: i32,`,
      `        pub publish_time: i64,`,
      `    }`,
      `    let ${priceBinding} = AnvilPythPrice {`,
      `        price: __pyth_price,`,
      `        conf: __pyth_conf,`,
      `        exponent: __pyth_expo,`,
      `        publish_time: __pyth_publish_time,`,
      `    };`,
    ].join("\n");
  }

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
    instr: Instruction,
    ir: SolanaIR,
  ): string {
    const knownDefs = new Set(ir.accounts.map((a) => a.name));
    let out = rewriteTryIntoUnwrap(bodyCode);
    out = rewriteRentSysvarMethods(out);
    out = rewriteSiblingCpiCalls(out);
    out = commentOutSiblingStateAccesses(out, instr.accounts, knownDefs);
    return out;
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
    // G55b — user-defined type names. Used by the `fixed::types::*` shadow
    // filter below to only strip imports that would collide with a
    // carried struct/account of the same name (openbook-v2's
    // `pub struct I80F48`). Without this gate the filter over-fires and
    // drops legitimate imports like `use fixed::types::I64F64;` from
    // program-examples/token-swap, cascading 24x E0433 unresolved-crate
    // errors on every body reference.
    const userTypeNamesForFixed = new Set<string>([
      ...(ir.types ?? []).map((t) => t.name),
      ...(ir.accounts ?? []).map((a) => a.name),
    ]);
    // First pass: extract `solana_program::X` segments from block-imports
    // so they survive the `anchor_lang::*` blanket filter. squads-mpl/roles'
    // `use anchor_lang::{prelude::*, solana_program::borsh::get_instance_packed_len};`
    // would otherwise drop the get_instance_packed_len side effect.
    const extracted: string[] = [];
    for (const statement of ir.imports ?? []) {
      const blockMatch = statement.match(/^use\s+anchor_lang\s*::\s*\{([^}]+)\}/);
      if (!blockMatch) continue;
      const inner = blockMatch[1] ?? "";
      // Find `solana_program::X` segments. These re-exports survive on
      // native (which ships solana-program); pinocchio's later filter
      // drops them.
      for (const m of inner.matchAll(/\bsolana_program::([\w:]+(?:::\*)?)/g)) {
        if (m[1]) extracted.push(`use solana_program::${m[1]};`);
      }
    }
    return [...extracted, ...(ir.imports ?? [])]
      .map((statement) => {
        const trimmed = statement.trim().replace(/;$/, "");
        // Recognize all `pub`/`pub(crate)`/`pub(super)`/`pub(in ...)` forms
        // followed by `use ...` as already-prefixed. Without this, the
        // fallback `use ${trimmed};` branch produces malformed output
        // like `use pub(crate) use for_named_field;` (caught by kamino-
        // klend's macro re-exports).
        const isAlreadyUse =
          trimmed.startsWith("use ") ||
          /^pub(?:\s*\(\s*[\w:]+\s*\))?\s+use\s/.test(trimmed);
        const normalized = isAlreadyUse ? `${trimmed};` : `use ${trimmed};`;
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
        if (/^use\s+solana_program::clock::(Slot|UnixTimestamp|Epoch|BlockHeight)\s*;?$/.test(rewritten.trim())) return "";
        // G22c — drop user-carried imports that duplicate prelude items.
        // Pinocchio's prelude has `use borsh::{BorshDeserialize,
        // BorshSerialize};` and `use core::convert::TryInto;`. Native has
        // its own equivalents. User source often re-imports these from
        // `std::convert::TryInto` or `borsh::BorshSerialize` — cargo
        // errors with E0252 "defined multiple times". Strip them.
        const t = rewritten.trim();
        if (/^use\s+borsh::Borsh(?:Serialize|Deserialize)\s*;?$/.test(t)) return "";
        if (/^use\s+(?:std|core)::convert::TryInto\s*;?$/.test(t)) return "";
        if (/^use\s+(?:std|core)::convert::TryFrom\s*;?$/.test(t)) return "";
        if (/^use\s+(?:std|core)::convert::From\s*;?$/.test(t)) return "";
        // G27d — std<->core type duplicates: source code often has both
        // `use core::slice::Iter;` and `use std::slice::Iter;` (one
        // selected via #[cfg] gates the source uses; after cfg-strip
        // both can survive). Prefer the core form (no_std-compatible
        // for SBF targets) and drop the std form.
        if (/^use\s+std::slice::Iter\s*;?$/.test(t)) return "";
        if (/^use\s+std::slice::IterMut\s*;?$/.test(t)) return "";
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
        if (statement.startsWith("use prelude::")) return false;
        if (statement.startsWith("pub use ")) return false;
        // anchor_spl always filtered: the CPI transformer rewrites the actual
        // call sites (e.g., `anchor_spl::token::transfer(...)`) into native
        // SPL helpers, so the import isn't needed in any target.
        if (statement.startsWith("use anchor_spl::")) return false;
        if (/^use\s*\{[\s\S]*\banchor_spl::/.test(statement)) return false;
        if (/\banchor_spl\b/.test(statement)) return false;
        // Sibling Anchor program imports — `use <crate>::cpi::*`,
        // `<crate>::accounts::*`, `<crate>::program::*`, `<crate>::state::*`,
        // `<crate>::errors::*` are Anchor's auto-generated cross-program-
        // invocation surface for a sibling program in the same workspace.
        // The standalone Anvil emit doesn't ship those crates, and the
        // corresponding CPI call sites in the body are commented out as
        // TODO stubs by commentOutSiblingCpiCalls. Drop the imports so the
        // file compiles. Affects fixtures like cpi-hand → cpi-lever and
        // squads-mpl/roles → squads-mpl.
        if (/^use\s+\w+::(?:cpi|accounts|program|state|errors|error)(?:::|;)/.test(statement)) return false;
        // Block-import form: `use <crate>::{state::..., errors::..., program::...};`
        // Detect by looking for `<crate>::` followed by a submodule name we
        // recognize as Anchor-program-internal. Excludes known external
        // ecosystem crates that legitimately export those submodule names
        // (e.g. mpl_token_metadata::state, anchor_lang::error).
        const siblingBlockMatch = statement.match(/^use\s+(\w+)\s*::\s*\{/);
        if (siblingBlockMatch) {
          const crate = siblingBlockMatch[1] ?? "";
          const isKnownExternal =
            crate === "anchor_lang" ||
            crate === "anchor_spl" ||
            crate === "solana_program" ||
            crate.startsWith("spl_") ||
            crate.startsWith("mpl_") ||
            crate.startsWith("pyth_") ||
            crate.startsWith("switchboard_") ||
            crate === "borsh" ||
            crate === "bytemuck" ||
            crate === "thiserror" ||
            crate === "num_derive" ||
            crate === "num_traits" ||
            crate === "fixed";
          if (!isKnownExternal && /\b(?:cpi|accounts|state|errors|error|program)\b/.test(statement)) {
            return false;
          }
        }
        // solana_program imports are valid on native (which deps it) but
        // not on pinocchio (which uses its own crate). Drop on
        // non-native. The anchor_lang::solana_program rewrite above means
        // a source `use anchor_lang::solana_program::X;` lands here as
        // `use solana_program::X;` and gets correctly stripped on those
        // targets while surviving on native.
        if (!isNative && /^use\s+solana_program(?:::|;)/.test(statement)) return false;
        // Proc-macro / compile-time-only crates: these provide #[derive] or
        // macro_rules! used by the Anchor source but Anvil doesn't preserve
        // those attributes in the emit. Strip on both targets.
        if (/\benum_dispatch\b/.test(statement)) return false;
        if (/\bfixed_macro\b/.test(statement)) return false;
        if (/\bstatic_assertions\b/.test(statement)) return false;
        if (/\bcfg_if\b/.test(statement)) return false;
        // External crates: native carries them through (project-scaffold adds
        // matching deps to Cargo.toml). Pinocchio filters them out
        // because there's no compatible dep in their Cargo.toml.
        if (!isNative) {
          // num_derive / num_traits kept on Pinocchio (2026-05-20): the
          // crates are no_std-compatible and now in PINOCCHIO_CARGO_TOML.
          // Carried-source `#[derive(FromPrimitive)]` on enums needs the
          // derive macro to resolve at expansion time.
          if (/\bmpl_core\b/.test(statement)) return false;
          if (/\bmpl_token_metadata\b/.test(statement)) return false;
          if (/\bswitchboard_on_demand\b/.test(statement)) return false;
          if (/\bsolana_keccak_hasher\b/.test(statement)) return false;
          if (/\bsolana_sha256_hasher\b/.test(statement)) return false;
          if (/\bsolana_security_txt\b/.test(statement)) return false;
          // sha2_const_stable kept on Pinocchio (2026-05-20): the crate is
          // no_std-compatible and now in PINOCCHIO_CARGO_TOML. Carried
          // helpers (e.g. merkle-tree-incremental's `const fn
          // make_zero_hashes` using ConstSha256) need the import to
          // resolve.
          // task #49 — `use spl_token_2022::extension::confidential_*` in
          // source. The Pinocchio target doesn't pull in spl-token-2022
          // (it has its own pinocchio-token + hand-rolled extension paths).
          // The visitor handles the Confidential T22 init IR kinds by
          // emitting a typed helper-fn call; the original `use` line is
          // dead-code on this target.
          if (/\bspl_token_2022\b/.test(statement)) return false;
          if (/\bsolana_program::program\b/.test(statement)) return false;
        }
        // mpl_token_metadata::instruction:: dropped on both targets —
        // Anvil emits its own MPL CPI helpers via invoke/invoke_signed,
        // and the instruction module was reorganized between versions.
        if (/\bmpl_token_metadata::instruction\b/.test(statement)) return false;
        // Pyth crates dropped on BOTH targets — N5b unified the emit
        // on hand-rolled bytes, so neither pyth_sdk_solana nor
        // pyth_solana_receiver_sdk is referenced at emit time. Keeping
        // the source `use pyth_*::*` lines would still pull the crates
        // into Cargo.toml (and re-introduce the borsh-derive proc-macro
        // interop issue that locked the M2/N5 ceiling pre-N5b).
        if (/\bpyth_sdk_solana\b/.test(statement)) return false;
        if (/\bpyth_solana_receiver_sdk\b/.test(statement)) return false;
        // mpl_core dropped on BOTH targets — task #48 S1 hand-rolls the
        // bytes via mpl_core_create_v2 helper. Same borsh-derive interop
        // issue as Pyth: mpl-core 0.10 pulls solana-address → borsh 1.6
        // while the program crate uses borsh 1.5, surfacing as wave of
        // "Pubkey: BorshSerialize not satisfied" across PluginRegistryV1.
        if (/\bmpl_core\b/.test(statement)) return false;
        // switchboard_on_demand dropped on BOTH targets — the crate
        // transitively depends on borsh 0.10 (vs our 1.6), and pulls
        // solana_program::address_lookup_table (absent in 2.2). Same
        // borsh-derive interop problem as Pyth/mpl-core. Body usages
        // referencing switchboard types (RandomnessAccountData etc.)
        // would still need separate handling but at least the import
        // line doesn't cascade unresolvable-module errors. Caught by
        // arjun-merkle-tree (Native).
        if (/\bswitchboard_on_demand\b/.test(statement)) return false;
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
        // spl_token_metadata_interface is a Native-target dep
        // (auto-added by project-scaffold when typed TokenMetadata IR
        // kinds are present). Pinocchio doesn't ship it — the typed
        // emit hand-rolls the discriminator+payload using literal
        // Field::* / OptionalNonZeroPubkey::try_from(...) mapping at
        // emit time, so the import is unnecessary on the Pinocchio
        // side and would E0432 if left in.
        if (!isNative && /\bspl_token_metadata_interface\b/.test(statement)) return false;
        // spl_pod isn't in any scaffold — neither Pinocchio nor Native
        // ship it. Drop on both targets.
        if (/\bspl_pod\b/.test(statement)) return false;
        // Test/dev-only crates that real-world Anchor programs (Raydium
        // CLMM, Marinade, MarginFi) sometimes import at file top-level
        // without #[cfg(test)] gating. Those imports compile in dev
        // profile (where the crate IS a dependency) but break Anvil's
        // emit because we don't ship test deps. Always drop these — the
        // surrounding code that uses them has been stripped by the
        // cfg(test)-block strip pass anyway, so the imports are dead.
        if (/\bproptest\b/.test(statement)) return false;
        if (/\bquickcheck\b/.test(statement)) return false;
        // arrayref kept on both targets (2026-05-20): the crate is in
        // NATIVE_OPTIONAL_DEPS + PINOCCHIO_OPTIONAL_DEPS + the static
        // /build templates now. Runtime usages like raydium-clmm's
        // `array_ref![data, 0, 8]` macro need the import to resolve.
        if (/\buint::construct_uint\b/.test(statement)) return false;
        if (/^use\s+rand(?:::|;)/.test(statement)) return false;
        // solana_security_txt is a dev-time annotation macro that emits a
        // static byte array embedded in the program for tooling to scrape.
        // The macro invocation lives at module scope and Anvil's parser
        // drops it; the import line needs explicit filtering. Neither
        // Pinocchio nor Native scaffold ships the crate, so this is a
        // universal filter (futarchy/mint_governor surfaced it).
        if (/\bsolana_security_txt\b/.test(statement)) return false;
        // G27d — drop additional drift-specific external crate imports.
        // These are crates drift uses but Anvil's Pinocchio/Native scaffold
        // doesn't ship. Body references get commented out separately;
        // dropping the import lines prevents cascade of E0432 errors.
        if (/\bopenbook_v2_light\b/.test(statement)) return false;
        if (/\bbyteorder\b/.test(statement)) return false;
        if (/\bdrift_macros\b/.test(statement)) return false;
        if (/\benumflags2\b/.test(statement)) return false;
        if (/\bpyth_lazer\b/.test(statement)) return false;
        // G29 — openbook-v2 external oracle/math crates. derivative
        // (derive macro helper), pyth_sdk_solana, and the switchboard
        // devnet/mainnet adapters aren't shipped in Anvil's Pin/Native
        // scaffold. Body references get the unsalvageable-helper
        // commentout downstream (G29 body gate).
        // G53 — `fixed` IS in both NATIVE_OPTIONAL_DEPS and
        // PINOCCHIO_OPTIONAL_DEPS (added later). The original G29 filter
        // for `fixed::` is obsolete and was blocking
        // `use fixed::traits::{FromFixed, ToFixed};` etc. in kamino.
        // G55 — but `use fixed::types::I80F48` (without alias) clashes
        // with openbook-v2's user-defined `pub struct I80F48` in the
        // flattened lib.rs. Filter ONLY the bare types::TYPE-named
        // imports to prevent name shadowing — keep traits and the full
        // `use fixed::types::*;` wildcards.
        // G55b — collision-aware: only drop when the imported name
        // would shadow a user-defined struct/account. Otherwise keep
        // the import (e.g. program-examples/token-swap legitimately
        // uses `use fixed::types::I64F64;` with no shadow risk).
        const fixedTypeMatch = statement.trim().match(/^use\s+fixed::types::(I\d+F\d+|U\d+F\d+)\s*;?$/);
        if (fixedTypeMatch?.[1] && userTypeNamesForFixed.has(fixedTypeMatch[1])) return false;
        if (/\bderivative::/.test(statement) || /^use\s+derivative(?:::|;)/.test(statement)) return false;
        if (/\bpyth_sdk_solana::/.test(statement) || /^use\s+pyth_sdk_solana(?:::|;)/.test(statement)) return false;
        if (/\bswitchboard_v1_devnet_oracle::/.test(statement) || /^use\s+switchboard_v1_devnet_oracle(?:::|;)/.test(statement)) return false;
        if (/\bswitchboard_v2_mainnet_oracle::/.test(statement) || /^use\s+switchboard_v2_mainnet_oracle(?:::|;)/.test(statement)) return false;
        // G81 attempt: filter bare `use switchboard::*`, `use prelude::*`,
        // `use perp_lp_pool_settlement::*` reverted. The wildcard re-
        // exports become unresolved everywhere they're referenced. Same
        // explosion G30's commentary predicted. 4 imports vs ~1156 errors —
        // accept the 4-import surface.
        // G30 — drift long-tail. serum_dex is a DEX integration crate
        // drift no longer ships; num_integer is an extra math crate.
        // Filter only these two — NOT local sub-modules like prelude /
        // perp_lp_pool_settlement, which are wildcard-imported and
        // their re-exports become unresolved everywhere if the use line
        // is stripped (drift exploded 19 -> 1242 in trial).
        if (/\bserum_dex::/.test(statement) || /^use\s+serum_dex(?:::|;)/.test(statement)) return false;
        if (/^use\s+num_integer(?:::|;)/.test(statement)) return false;
        // G39 — openbook-v2 long-tail external crates not in either scaffold.
        // default_env (CI build-time env helper), itertools (iterator
        // extensions), switchboard_program / switchboard_solana (Switchboard
        // SDK variants), market_seeds (openbook-internal macro_rules! re-
        // export). All surface as E0432 in openbook-v2's flattened lib.rs.
        if (/\bdefault_env::/.test(statement) || /^use\s+default_env(?:::|;)/.test(statement)) return false;
        if (/\bitertools::/.test(statement) || /^use\s+itertools(?:::|;)/.test(statement)) return false;
        if (/\bswitchboard_program::/.test(statement) || /^use\s+switchboard_program(?:::|;)/.test(statement)) return false;
        if (/\bswitchboard_solana::/.test(statement) || /^use\s+switchboard_solana(?:::|;)/.test(statement)) return false;
        // market_seeds is openbook-v2's `macro_rules! market_seeds!` exposed
        // via `pub(crate) use market_seeds;` at the crate root. After the
        // macro_rules! pass comments out the definition body, the
        // `pub(crate) use` re-export points at nothing — drop it explicitly.
        if (/^pub(?:\(\s*\w+(?:::\w+)*\s*\))?\s+use\s+market_seeds\s*;?$/.test(statement.trim())) return false;
        if (/^use\s+market_seeds(?:::|;)/.test(statement)) return false;
        // Same shape for openbook's `for_named_field` / `ctx_event_emitter`
        // helper-macro re-exports. They're brought in via macro_rules! in
        // the source tree; macro_rules! pass removes the definition, the
        // `pub(crate) use` lines remain orphaned.
        if (/^pub(?:\(\s*\w+(?:::\w+)*\s*\))?\s+use\s+for_named_field\s*;?$/.test(statement.trim())) return false;
        if (/^pub(?:\(\s*\w+(?:::\w+)*\s*\))?\s+use\s+ctx_event_emitter\s*;?$/.test(statement.trim())) return false;
        // num_enum is in NATIVE_OPTIONAL_DEPS but NOT PINOCCHIO_OPTIONAL_DEPS.
        // On Native, keep the import — scaffold's extractUsedCrates picks
        // num_enum from the textual `num_enum::` reference and adds the
        // matching Cargo.toml entry. On Pinocchio the crate isn't available;
        // the import would be dropped here anyway as E0432. We leave it in
        // both targets to surface the gap explicitly — derives like
        // TryFromPrimitive remain unresolved on Pinocchio (separate fix).
        // kamino-klend long-tail: strum (string-enum derives) and the bare
        // bitflags re-export. Neither is in scaffold. Body usages already
        // commented by the unsalvageable-helper passthrough pass.
        if (/^use\s+strum(?:::|;)/.test(statement)) return false;
        if (/^use\s+bitflags(?:::|;)/.test(statement)) return false;
        // G40 — `borsh::BorshSchema` is borsh's schema-derive trait, used
        // for IDL generation (Anchor's `#[derive(BorshSchema)]`). The
        // borsh crate ships it only with the `schema` feature, which we
        // don't enable — drop the import. Body usages have already been
        // stripped via stripFilteredDeriveIdentifiers if present.
        if (/^use\s+borsh::BorshSchema\s*;?$/.test(statement.trim())) return false;
        // G40 — `solana_program::native_token::LAMPORTS_PER_SOL` is a u64
        // constant (1_000_000_000). Pinocchio doesn't ship native_token,
        // so when carried code references the bare constant, rewrite at
        // emit time. The reference rewrite happens inline in
        // body-emit; here we just keep the source `use` line live where
        // applicable (Native: scaffold has solana-program; Pinocchio: drop).
        if (!isNative && /^use\s+solana_program::native_token(?:::|;)/.test(statement)) return false;
        // G34 — marginfi-v2 / mango-v4 external sibling-crate mocks
        // (kamino_mocks/drift_mocks/juplend_mocks: test-only mock CPIs)
        // and pyth_solana_receiver_sdk. Body refs get the unsalvageable-
        // helper commentout downstream. NOT filtering marginfi_type_crate
        // because it wildcard-imports type definitions used cohort-wide;
        // filter cascade pushed marginfi 406 -> 640.
        if (/^use\s+(?:crate::)?(?:kamino_mocks|drift_mocks|juplend_mocks)(?:::|;)/.test(statement)) return false;
        if (/\bpyth_solana_receiver_sdk::/.test(statement) || /^use\s+pyth_solana_receiver_sdk(?:::|;)/.test(statement)) return false;
        // G47 attempted to filter drift's local-module hoisted use lines
        // (perp_lp_pool_settlement, prelude, switchboard). Cascade still
        // happens: drift 6 → 1171 errors. The 6 baseline was a syntactic
        // E0432 shadow that stopped cargo from analyzing ~1100 downstream
        // body refs to types that the wildcards were exposing. Better to
        // leave the unresolved-import errors visible — they're the
        // honest representation. Revert.
        // static_assertions is a no_std-compatible dev macro crate.
        // Anvil's scaffold doesn't ship it. Body usages (e.g. compile-time
        // size assertions) are stripped at carry-source level by the
        // unsalvageable-helper pass.
        if (/\bstatic_assertions\b/.test(statement)) return false;
        return true;
      });
  }

  protected rustTypeForCustomType(typeName: string): string {
    if (typeName === "String" || typeName === "Vec<u8>") return typeName;
    // G4 — Strip Anchor wrapper types that don't exist on Pin/Native.
    // Source struct fields use `Signer<'info>`, `Account<'info, T>`,
    // `Box<Account<'info, T>>`, etc. With anchor_lang filtered out, these
    // references fail with "cannot find type `Signer`". Rewrite to
    // type-agnostic AccountInfo equivalents — target-aware because Pin's
    // AccountInfo has no lifetime parameter while Native's takes one.
    const rewritten = stripAnchorWrapperTypes(typeName, this.frameworkName === "Pinocchio" ? "pin" : "native");
    if (rewritten !== typeName) return rewritten;
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
    this.computeCpiWrapperCallSiteRewrites(ir);

    const files: EmitterFile[] = [];

    // ── lib.rs ──
    const libContentRaw = this.emitLibFile(ir);
    // G33 — post-emit brace balance pass. Marginfi/mango/squads emit
    // an extra unmatched `}` (likely an impl-block closer surviving
    // after the impl was stripped by source rewrites). Drop the first
    // depth-negative `}` outside strings/chars/comments — preserves
    // every legitimate brace, only removes the stray.
    let libContent = balanceLibBraces(libContentRaw);
    // G97 — same 'info-lifetime patch (G96) applied to lib.rs. drift's
    // PerpMarketMap::load / SpotMarketMap::load contain `let X: AccountInfo<'info> = ...`
    // bindings while the enclosing method's generics omit 'info. The
    // helper is guarded via enclosingImplDeclaresInfo, so methods inside
    // already-'info-declaring impls are not patched (would E0496 shadow).
    if (this.frameworkName === "Native") {
      libContent = addInfoLifetimeIfReferenced(libContent);
    }
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
      let errorsContent = this.emitErrorsFile(ir);
      // G99 — dedupe `impl From<ErrName> for ProgramError`. Real-world
      // programs (openbook) carry a user-defined `impl From<OpenBookError>
      // for ProgramError` in their lib.rs that converts via the user's
      // Error wrapper. The scaffold also emits an unconditional From impl
      // (ProgramError::Custom). E0119 conflicting impl results. The carried
      // version is semantically richer (preserves user Error chain), so
      // strip the scaffold's when lib.rs already has one for the same enum.
      const carriedFromEnums = collectCarriedFromImpls(libContent);
      if (carriedFromEnums.size > 0) {
        errorsContent = stripScaffoldFromImpls(errorsContent, carriedFromEnums);
      }
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
    const constants = (ir.constants ?? []).map((c) => this.postProcessTopLevelConst(c));
    const types = (ir.types ?? []).filter((t) => !FRAMEWORK_SHADOW_TYPES.has(t.name));
    const hasHelperModule = this.hasHelperModule(ir);
    sections.push(this.fileHeader(ir.name));
    sections.push(this.emitUseStatements(ir));
    // G17: emit ZeroCopy / Owner / Discriminator trait stubs when any
    // account/typeDef is `#[account(zero_copy)]` or bare `#[zero_copy]`.
    // User-defined wrappers like raydium-clmm's `AccountLoad<'info, T:
    // ZeroCopy + Owner>` carry the bounds verbatim into helpers.rs; the
    // bounds need a resolvable trait somewhere in scope. Anchor's stock
    // traits live in `anchor_lang`, which we strip — these stubs fill
    // that gap with the minimal shape needed for cargo to type-check.
    const zeroCopyTraits = this.emitZeroCopyTraits(ir);
    if (zeroCopyTraits) {
      sections.push(zeroCopyTraits);
    }
    // G19: emit `pub const ID: Pubkey = ...` + `pub fn id() -> Pubkey { ID }`
    // at crate root when the IR has a programId. Anchor auto-generates
    // these from `declare_id!("...")` — Anvil's emit previously skipped
    // them, so carried code referencing `crate::id()` or `crate::ID`
    // failed at cargo with E0425/E0433. Raydium-clmm hit 6× crate::id().
    const programIdConst = this.emitProgramIdConst(ir);
    if (programIdConst) {
      sections.push(programIdConst);
    }
    // G27a: stub anchor_lang::solana_program::sysvar::instructions::SysInstructions
    // when carried code references it. Common in lending / margin programs that
    // verify the instruction-sysvar account against SysInstructions::id().
    // Returns the well-known sysvar pubkey verbatim.
    // G38 — skip on Native since the native emitter auto-imports
    // `solana_program::sysvar::instructions::Instructions as SysInstructions`.
    if (this.shouldEmitSysInstructionsStub(ir) && this.frameworkName !== "Native") {
      sections.push(this.emitSysInstructionsStub());
    }
    // G27e: stub solana_program::clock::Slot when referenced. Slot is a
    // u64 type alias in solana_program. Carried code uses it as parameter
    // / field type — kamino's `pub fn new(slot: Slot)`. Drop a
    // `pub type Slot = u64;` so references resolve.
    // G38 — skip on Native since the native emitter auto-imports
    // `solana_program::clock::Slot`.
    if (this.shouldEmitSlotAlias(ir) && this.frameworkName !== "Native") {
      sections.push("// G27e — solana_program::clock::Slot is a u64 alias\npub type Slot = u64;");
    }
    // G40 — stub `LAMPORTS_PER_SOL` constant on Pinocchio. The constant
    // lives in `solana_program::native_token::LAMPORTS_PER_SOL = 10^9`;
    // pinocchio doesn't ship `solana_program`, but the value is universal.
    // Carried bodies reference it bare (e.g. marinade's `5 * LAMPORTS_PER_SOL`).
    if (this.frameworkName !== "Native" && this.referencesLamportsPerSol(ir)) {
      sections.push("// G40 — solana_program::native_token::LAMPORTS_PER_SOL\npub const LAMPORTS_PER_SOL: u64 = 1_000_000_000;");
    }
    // G43 — Anchor's Result<T> alias (= std::Result<T, anchor_lang::Error>)
    // SHOULD be stubbed when carried code references `Result<T>` (1 arg)
    // after we strip anchor_lang prelude. Tried emitting
    // `pub type Result<T> = core::result::Result<T, ProgramError>;` but it
    // conflicts with user code that already passes 2 args (`Result<T, E>`)
    // since the alias takes exactly 1. Per-callsite text rewrite of
    // `Result<T>` (no comma at depth 0) is feasible but risks user-defined
    // type aliases (MarginfiResult, DriftResult, …) that already alias
    // single-arg Result correctly. Left as TODO for future scope-aware fix.
    // G44 — emit `token_interface::accessor::amount(&ai)` stub when
    // referenced. anchor_spl's `token_interface::accessor` namespace
    // exposes `amount(&AccountInfo) -> Result<u64>` for reading
    // SPL TokenAccount.amount without unpacking. We strip anchor_spl,
    // so the call site is unresolved. Stub the module to read the
    // u64 at byte offset 64 (Token / Token-2022's TokenAccount layout).
    if (this.referencesTokenInterfaceAccessor(ir)) {
      sections.push(this.emitTokenInterfaceAccessorStub());
    }
    // G48 — stub `pub enum ErrorCode` with anchor_lang's built-in error
    // variants when carried code references them. anchor_lang::error::
    // ErrorCode is a fixed-shape enum with discriminants 1000-3xxx;
    // common variants used by Anchor-runtime checks are referenced from
    // user impl/helper bodies (openbook-v2's KeyedAccountReader trait
    // hits 3 sites). All variants → ProgramError::Custom(code).
    // GATE: skip when the user's error enum is named ErrorCode (coral-
    // multisig pattern) — emitting both produces E0659 "ambiguous"
    // AND the body refs to user variants like `ErrorCode::AlreadyExecuted`
    // would now resolve to our stub which doesn't have those variants
    // (E0599). Detect by checking sourceErrorEnumName.
    if (this.referencesAnchorErrorCode(ir) && this.sourceErrorEnumName(ir) !== "ErrorCode") {
      sections.push(this.emitAnchorErrorCodeStub());
    }
    // G75 attempted Event trait stub. Even the trait alone caused
    // openbook +165 regression (carried code casts events via `T::
    // DISCRIMINATOR` where T isn't bound by Event in the strip-mode
    // emit). Reverted; the helper-bound errors are net-better than the
    // cascade.
    // G93 attempt re-emit Event trait + per-event impl reverted: openbook
    // /pin regressed +158. The trait + per-struct impl is correct in
    // isolation, but downstream errors that were previously SUPPRESSED
    // by the unresolved trait now cascade. Net negative.
    // G65 — stub anchor_lang::accounts::account_loader::AccountLoader<T>
    // when referenced. Carried helpers (openbook's process_out_event)
    // and impl items use `AccountLoader::try_from(acc)?` to wrap an
    // AccountInfo for zero-copy access. Real semantics need type-aware
    // mapping; here we provide a minimal compile-clean stub.
    if (this.referencesAnchorAccountLoader(ir)) {
      sections.push(this.emitAnchorAccountLoaderStub());
    }
    // Finding #26 (REVERTED — same cascade as G75/G93/G98) — attempted
    // to emit the Event trait stub + per-event `impl Event for E` impls
    // together. Reverted because openbook cascaded +443 errors (1 → 215
    // pin, 1 → 230 native). The trait+impl pair was supposed to avoid
    // the orphan-trait issue but something in carried-text symbol
    // resolution still depends on anchor_lang's real Event trait shape
    // that our minimal stub doesn't reproduce. Multi-day arc — needs
    // typed event IR refactor with full trait surface (set_inner-style
    // expansion of emit!() macro at parse time, not at emit time).
    // G79 — stub other anchor_lang trait references (Discriminator,
    // AccountDeserialize, AccountSerialize, Owner). Real-world Anchor
    // programs (marinade) implement these via macros on every state
    // account. The user-written impl blocks survive Anvil's flatten but
    // the trait definitions don't (we strip anchor_lang imports). Bare
    // trait stubs are compile-clean.
    sections.push(this.emitAnchorMiscTraitStubs(ir));
    // G66 attempted CpiContext stub; regressed cohort (+22 errors net)
    // because `alloc::vec::Vec` requires `extern crate alloc;` which
    // isn't always in scope, AND because the stub's typed fluent
    // surface conflicts with Anchor's actual CpiContext shape some
    // bodies expect. Reverted; would need narrower stub + correct
    // alloc/std handling per target.
    // G27f: stub spl_token_2022::extension::ExtensionType enum with all known
    // variants. Kamino-klend uses ExtensionType variants in a const slice
    // for supported-extension validation. Each program may use a subset;
    // emit the union of known variants and let cargo type-check.
    // G38 — skip on Native target since the upstream Cargo.toml ships
    // spl_token_2022 and the native emitter auto-imports
    // `spl_token_2022::extension::ExtensionType`. Emitting both an `use`
    // line and a local stub triggers E0255 (drift / kamino / raydium).
    if (this.shouldEmitExtensionTypeStub(ir) && this.frameworkName !== "Native") {
      sections.push(this.emitExtensionTypeStub());
    }
    // G19b: stub anchor_lang::Error type when carried code references it.
    // Anchor's Error is a struct with chainable builder methods
    // (.with_pubkeys, .with_source, .with_account_name, .with_values, etc).
    // Anvil strips anchor_lang imports — carried code references the type
    // directly and breaks. Stub with no-op builders that return self.
    // Detection: only emit when at least one helper-fn body or impl item
    // references `Error::` or `: Error,` as a type. Conservative — fires
    // for the raydium AccountLoad helper pattern.
    if (this.shouldEmitErrorStub(ir)) {
      sections.push(this.emitErrorStub());
    }
    // Hoist const-fn helpers referenced by top-level constants. Rust's
    // const-evaluator requires the called fn to be visible at the const
    // decl's scope; without this lift, a source `pub const ZERO_HASHES =
    // make_zero_hashes()` whose `make_zero_hashes` lives in helpers.rs
    // fails at cargo with "cannot find function `make_zero_hashes` in
    // this scope". Caught by arjun-merkle-tree-incremental.
    const hoistedHelpers = this.helpersReferencedByConsts(ir, constants);
    if (hoistedHelpers.length > 0) {
      sections.push(hoistedHelpers.map((h) => h.rawCode).join("\n\n"));
    }
    // G22c — emit `pub type X = Y;` aliases at lib.rs scope. They're
    // visible to all submodules via `use super::*;` / `use crate::*;`.
    const typeAliases = ir.typeAliases ?? [];
    if (typeAliases.length > 0) {
      sections.push(`// User type aliases preserved verbatim from source\n${typeAliases.join("\n")}`);
    }
    // G27g — emit user-defined traits at lib.rs scope. Openbook's
    // KeyedAccountReader / AccountReader patterns.
    // G43 — also push through stripAnchorLangPrefixes + stripAnchorWrappersInCode
    // so `Result<T>` aliases, AnchorSerialize/Deserialize trait refs, and
    // anchor_lang::* prefixes get the same rewrites applied to body-level
    // helpers. Openbook's `pub trait LoadZeroCopy { fn load() -> Result<&T>; }`
    // hits this — without it the trait declarations cargo-fail at E0107.
    const userTraits = (ir as any).userTraits ?? [];
    if (userTraits.length > 0) {
      const target = this.frameworkName === "Pinocchio" ? "pin" : "native";
      const processed = userTraits.map((ut: string) =>
        stripAnchorWrappersInCode(stripAnchorLangPrefixes(ut), target),
      );
      sections.push(`// User-defined traits preserved verbatim from source\n${processed.join("\n\n")}`);
    }
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
    // G49 — re-export events at crate root so bodies in lib.rs (carried
    // helper fns, impl items inlined into the #[program] mod) can
    // reference event types by bare name. Openbook-v2's `emit_stack(
    // TotalOrderFillEvent { ... })` invocations otherwise fail E0422
    // "cannot find struct" because mod events; declares the events module
    // but doesn't re-export its contents at the parent scope.
    if ((ir.events ?? []).length > 0) {
      sections.push("pub use events::*;");
    }
    // #42 — re-export the error enum at the crate root so bodies that
    // reference `crate::FundraiserError::X` (a common shape when the
    // source has `pub use error::*;` in its lib.rs and references stay
    // un-aliased) resolve. The instruction-file `use crate::errors::*;`
    // already handles `FundraiserError::X` without the crate:: prefix.
    if (ir.errors.length > 0) {
      sections.push("pub use errors::*;");
    }
    // G14: bring state + helpers symbols into lib.rs scope so impl
    // blocks / functions that survive at lib.rs can reference them
    // (raydium-clmm's `impl SwapState { fn new(pool_state: &PoolState
    // …) }` stays in lib.rs and needs PoolState + tick_spacing_index
    // _from_tick visible). Previously gated on userTraitImpls being
    // non-empty, which raydium doesn't have.
    if (ir.accounts.length > 0) sections.push("use state::*;");
    if (hasHelperModule) sections.push("use helpers::*;");
    // User trait impls land AFTER the use lines so account-struct types
    // emitted into state.rs resolve when referenced (coral-multisig:
    // `impl From<&Transaction> for Instruction { … }`).
    const userTraitImpls = this.emitUserTraitImpls(ir);
    if (userTraitImpls) {
      sections.push(userTraitImpls);
    }
    // Finding #67 — splat top-level free `mod X { ... }` blocks verbatim at
    // lib.rs scope. The parser captures these (non-`#[program]`, non-cfg(test))
    // because they may host types referenced by Accounts structs (e.g.
    // `InterfaceAccount<'info, interface::ExpectedAccount>` requires the
    // `mod interface { pub struct ExpectedAccount }` to land here). Push
    // through stripAnchorLangPrefixes + stripAnchorWrappersInCode so any
    // `anchor_lang::*` trait references inside the mod (AccountDeserialize,
    // Owners, etc.) get the same wrapper-strip treatment as userTraits.
    // Filter out bare `mod X;` declarations — these are leftover from the
    // source's module structure after buildProjectSource flattened the files.
    // The content was already inlined; the declaration without a body would
    // cause E0583 "file not found" under build-sbf.
    const userModules = ((ir as any).userModules ?? []).filter(
      (um: string) => !/^(?:pub\s+)?mod\s+\w+\s*;$/.test(um.trim()),
    );
    if (userModules.length > 0) {
      const target = this.frameworkName === "Pinocchio" ? "pin" : "native";
      const processed = userModules.map((um: string) => {
        let code = stripAnchorWrappersInCode(stripAnchorLangPrefixes(um), target);
        code = code.replace(/declare_id!\s*\(\s*"([^"]+)"\s*\)\s*;?/g, "// declare_id removed (Anvil)");
        code = rewriteMsgCallsImpl(code, (m: string) => this.emitMsg(m));
        return code;
      });
      // Dedup modules with the same name: merge bodies when two `pub mod X { ... }` collide
      // (common after workspace crate flattening — both program and sibling define `mod utils`).
      const deduped: string[] = [];
      const seenModNames = new Map<string, number>();
      for (const code of processed) {
        const modMatch = code.match(/^(?:pub\s+)?mod\s+(\w+)\s*\{/);
        if (modMatch?.[1] && seenModNames.has(modMatch[1])) {
          const existingIdx = seenModNames.get(modMatch[1])!;
          const bodyMatch = code.match(/^(?:pub\s+)?mod\s+\w+\s*\{([\s\S]*)\}\s*$/);
          if (bodyMatch?.[1]) {
            deduped[existingIdx] = deduped[existingIdx]!.replace(/\}\s*$/, `\n${bodyMatch[1].trim()}\n}`);
          }
        } else {
          if (modMatch?.[1]) seenModNames.set(modMatch[1], deduped.length);
          deduped.push(code);
        }
      }
      // Inject scope-prelude into each user inline module so that types from
      // parent scope + sibling modules (state, errors) resolve inside the mod.
      // Without this, build-sbf compiles dead-code bodies and hits E0412/E0433
      // for every cross-module type reference.
      const prelude: string[] = ["use super::*;"];
      if (ir.accounts.length > 0) prelude.push("use crate::state::*;");
      if (ir.errors.length > 0) prelude.push("use crate::errors::*;");
      const preludeBlock = prelude.map(l => `    ${l}`).join("\n");
      const withPrelude = deduped.map((code) => {
        return code.replace(
          /^((?:pub\s+)?mod\s+\w+\s*\{)\s*\n?/,
          `$1\n${preludeBlock}\n`,
        );
      });
      sections.push(`// User-defined modules preserved verbatim from source\n${withPrelude.join("\n\n")}`);
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
      this._irForAccountEmit = ir;
      sections.push(this.emitAccountStruct(acc));
      this._irForAccountEmit = undefined;
    }
    let combined = sections.join("\n\n");
    // G74 — also comment out unsalvageable-helper call sites in state.rs.
    // emitInstructionFile and emit-combined already run this pass; state.rs
    // (account impl methods) was the gap — openbook's oracle.rs helper is
    // commented out as Anchor-only, but its callers in state.rs's
    // `oracle_price_from_a*` impl methods survived and failed E0425.
    if (this.unsalvageableHelpers.size > 0) {
      combined = commentOutUnsalvageableCallSites(combined, this.unsalvageableHelpers);
    }
    combined = commentOutResidualAnchorLeaks(combined);
    // G96 — extend G80's 'info-lifetime patch to state.rs impl methods.
    // drift's `impl Foo { pub fn validate_fuel_overflow(&self, x: &Option<AccountInfo<'info>>) }`
    // needs `<'info>` on the method itself when the surrounding impl is
    // bare `impl Foo`. The patch internally guards via enclosingImplDeclaresInfo
    // so `impl<'info> X { pub fn foo(&self, ...) }` is left alone (E0496 shadow).
    if (this.frameworkName === "Native") {
      combined = addInfoLifetimeIfReferenced(combined);
    }
    return combined;
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
    // Pull in user-defined types from lib.rs so event fields whose type
    // is a custom enum/struct (perp-funding's SignedAmount in
    // PositionClosed.price_pnl / funding_pnl) resolve cleanly. Without
    // this, cargo errors with E0412 "cannot find type X" — events.rs
    // is a sibling module of lib.rs at src/, so super::* brings every
    // top-level type into scope. Same import that instructions/*.rs
    // get via `use crate::*;` in instructions/mod.rs.
    sections.push(`use super::*;`);

    for (const ev of (ir.events ?? [])) {
      const fieldDecls = ev.fields
        .map((f) => `    pub ${snakeCase(f.name)}: ${this.rustTypeForCustomType(f.type)},`)
        .join("\n");
      const { len: discLen, expr: discExpr } = this.eventDiscInfo(ev);
      sections.push(
        `#[derive(BorshSerialize, BorshDeserialize, Debug)]\npub struct ${ev.name} {\n${fieldDecls}\n}\n\nimpl ${ev.name} {\n    pub const DISCRIMINATOR: [u8; ${discLen}] = ${discExpr};\n}`,
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
    // G25 — apply Anchor-macro rewrites to pass-through bodies (require_*!
    // / msg! that survived into for-loop / if-block bodies because the body
    // classifier only handles top-level statements). Idempotent on already-
    // rewritten code (the patterns no longer match after first pass).
    const rawBody = this.emitInstructionFunction(instr, ir);
    const accountNames = new Set(instr.accounts.map((a) => snakeCase(a.name)));
    const knownNames = this.collectKnownTopLevelNames(ir);
    let body = collapseModulePaths(
      rewriteSelfReferences(
        rewriteCtxAccountsDestructure(
          rewriteRequireVariantsInCode(
            rewriteMsgCallsImpl(rawBody, (m: string) => this.emitMsg(m)),
          ),
          accountNames,
        ),
        accountNames,
      ),
      knownNames,
    );
    // G112 — un-prefix prophylactic `_` on account bindings that became
    // referenced AFTER rewriteSelfReferences ran.
    body = body.replace(
      /^(\s*let\s+)_([a-zA-Z]\w*)(\s*=\s*&accounts\[\d+\]\s*;)/gm,
      (full, prefix: string, name: string, after: string) => {
        const re = new RegExp(`\\b${name}\\b`, "g");
        const count = (body.match(re) ?? []).length;
        return count > 0 ? `${prefix}${name}${after}` : full;
      },
    );
    // G105 — when rewriteSelfReferences leaves `__anvil_unported_self__`
    // markers in the body, inject a placeholder binding at the top of the
    // fn body so cargo gets E0599/E0308 (which usually live behind some
    // other failure anyway) instead of E0425 "cannot find value". The
    // binding panics at runtime so any path that hits it surfaces clearly.
    // unimplemented!() returns `!` which coerces to any expected type, so
    // the call-site arg type works regardless of what the lost-self
    // method's first parameter expects.
    if (/\b__anvil_unported_self__\b/.test(body)) {
      body = body.replace(
        /(pub\s+fn\s+\w+\s*\([^)]*\)\s*->\s*ProgramResult\s*\{)/,
        `$1\n    #[allow(unreachable_code, unused_variables)]\n    let __anvil_unported_self__ = unimplemented!("Anvil: lost-self placeholder — manual port required");`,
      );
    }
    // G106 reverted — orphan `self.X(...)` rewrite broke emit for every
    // fixture (helper method undefined + regex appends `; let _ = (` which
    // leaks broken syntax everywhere). Lost-impl-receiver self.X is the
    // marinade self.X arc that needs ctx-aware AST rewriting, not a
    // textual regex pass. Defer until typed IR or AST visitor.
    // Per-instruction body-level imports for symbols that lib.rs-only
    // `use` statements don't reach. `use super::*;` resolves to
    // instructions/mod.rs's scope (which has `use crate::*;`), and
    // `use crate::*;` only re-exports items declared at the crate
    // root — not `use`-imported types/fns. Anchor sources commonly
    // `use anchor_lang::solana_program::program::{invoke, invoke_signed};`
    // and call bare; emit re-routes the import to `solana_program::...`
    // for Native, but the rewrite lands in lib.rs only, so the bare
    // call inside instructions/X.rs goes unresolved. Detect references
    // in the body and add the corresponding use here.
    const bodyImports: string[] = [];
    if (this.frameworkName === "Native") {
      // G109 — T22 TokenMetadata typed IR emits `Field::Name` / `Field::Key(...)`
      // and `OptionalNonZeroPubkey::try_from(...)`. The crate-level use
      // statements live in lib.rs only; the per-instruction file doesn't see
      // them. Add a body-level use when the rendered body references either.
      if (/\bField::(?:Name|Symbol|Uri|Key\b)/.test(body)) {
        bodyImports.push("use spl_token_metadata_interface::state::Field;");
      }
      if (/\bOptionalNonZeroPubkey\b/.test(body)) {
        // spl_pod is a transitive dep of spl-token-metadata-interface (which
        // we already inject when t22 metadata CPIs are present). Direct path
        // avoids requiring anchor_spl, which Native scaffold doesn't pull.
        bodyImports.push("use spl_pod::optional_keys::OptionalNonZeroPubkey;");
      }
      const refsInvoke = /\binvoke\s*\(/.test(body);
      const refsInvokeSigned = /\binvoke_signed\s*\(/.test(body);
      if (refsInvoke && refsInvokeSigned) {
        bodyImports.push("use solana_program::program::{invoke, invoke_signed};");
      } else if (refsInvoke) {
        bodyImports.push("use solana_program::program::invoke;");
      } else if (refsInvokeSigned) {
        bodyImports.push("use solana_program::program::invoke_signed;");
      }
    }
    const bodyImportBlock = bodyImports.length > 0 ? bodyImports.join("\n") + "\n" : "";
    let raw = `use super::*;\n${errorImport}${bodyImportBlock}\n${body}`;
    if (this.unsalvageableHelpers.size > 0) {
      raw = commentOutUnsalvageableCallSites(raw, this.unsalvageableHelpers);
    }
    raw = commentOutResidualAnchorLeaks(raw);
    // Rewrite call sites for recognized CPI-wrapper helpers (strip & from
    // AccountInfo args). Mirrors emit-combined; instruction file is also
    // a place these calls live.
    raw = this.applyCpiWrapperCallSiteRewrites(raw);
    return raw;
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
    // Instruction context struct names (PascalCase). These Anchor types
    // don't exist in Pinocchio/native emit; helpers whose signatures
    // reference them can't compile regardless of body transforms.
    const instrCtxRe = ir.instructions
      .map((instr) => toPascalCase(instr.name))
      .filter((n) => n.length > 2)
      .map((n) => new RegExp(`\\b${n}(?:Accounts|Args|Base|Bumps)?\\b`));
    for (const helper of ir.helperFns ?? []) {
      // Known CPI-wrapper helpers (escrow2025's transfer_tokens /
      // close_token_account) carry InterfaceAccount in their signature but
      // we emit a target-typed replacement body — they are salvageable.
      if (recognizeCpiWrapperHelper(helper.name, helper.signature, helper.body, this.frameworkName)) {
        continue;
      }
      if (hasUnsalvageableHelperSignature(helper.signature)) {
        out.add(helper.name);
        continue;
      }
      // Signature references an Anchor instruction context struct — type
      // doesn't exist in target, so the helper is unsalvageable.
      if (instrCtxRe.some((re) => re.test(helper.signature))) {
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

  /** CPI-wrapper helpers whose call sites need the leading `&` stripped from
   *  AccountInfo args (call site is `&vault` where vault is already
   *  `&AccountInfo`). Populated alongside unsalvageableHelpers; consumed
   *  by the pass_through post-process. */
  protected cpiWrapperCallSiteRewrites: Array<{ name: string; accountInfoArgIndices: number[] }> = [];

  protected computeCpiWrapperCallSiteRewrites(ir: SolanaIR): void {
    this.cpiWrapperCallSiteRewrites = [];
    for (const helper of ir.helperFns ?? []) {
      const r = recognizeCpiWrapperHelper(helper.name, helper.signature, helper.body, this.frameworkName);
      if (r) {
        this.cpiWrapperCallSiteRewrites.push({
          name: helper.name,
          accountInfoArgIndices: r.accountInfoArgIndices,
        });
      }
    }
  }

  protected applyCpiWrapperCallSiteRewrites(code: string): string {
    let out = code;
    for (const r of this.cpiWrapperCallSiteRewrites) {
      out = rewriteCpiWrapperCallSites(out, r.name, r.accountInfoArgIndices);
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
    // Helpers hoisted into lib.rs (because top-level consts reference
    // them and Rust's const-eval requires same-scope visibility) get
    // skipped here to avoid duplicate definitions.
    const constantsForHoist = (ir.constants ?? []).map((c) => this.postProcessTopLevelConst(c));
    const hoistedNames = new Set(this.helpersReferencedByConsts(ir, constantsForHoist).map((h) => h.name));
    const instrContextNames = new Set(ir.instructions.map((instr) => toPascalCase(instr.name)));

    // Dead code elimination: build the set of helpers reachable from live
    // instruction bodies. Unreferenced helpers are skipped entirely — they
    // would fail cargo build-sbf with missing Anchor types.
    const allHelperNames = new Set((ir.helperFns ?? []).map((h) => h.name));
    const helperBodies = new Map((ir.helperFns ?? []).map((h) => [h.name, h.body ?? h.rawCode ?? ""]));
    // Seed: everything referenced from instruction bodies or constants.
    // Scan ALL text-carrying fields from body statements — not just `code`.
    // state_field_assign has `value`, require has `condition`, emit has `fields`, etc.
    const liveCode = [
      ...ir.instructions.flatMap((ix) => ix.body.map((s) => {
        const a = s as any;
        return [a.code, a.value, a.condition, a.fields, a.from, a.to, a.authority, a.amount, a.event].filter(Boolean).join(" ");
      })),
      ...constantsForHoist,
      ...((ir as any).userModules ?? []) as string[],
    ].join("\n");
    const reachable = new Set<string>();
    const queue: string[] = [];
    for (const name of allHelperNames) {
      if (hoistedNames.has(name) || new RegExp(`\\b${name}\\s*[(<]`).test(liveCode) || new RegExp(`\\b${name}\\b`).test(liveCode)) {
        reachable.add(name);
        queue.push(name);
      }
    }
    // Transitive closure: helpers called by reachable helpers
    while (queue.length > 0) {
      const current = queue.pop()!;
      const body = helperBodies.get(current) ?? "";
      for (const name of allHelperNames) {
        if (!reachable.has(name) && new RegExp(`\\b${name}\\b`).test(body)) {
          reachable.add(name);
          queue.push(name);
        }
      }
    }

    for (const helper of ir.helperFns) {
      if (hoistedNames.has(helper.name)) continue;
      // Skip unreferenced helpers — dead code elimination
      if (!reachable.has(helper.name)) continue;
      // Known CPI-wrapper helpers — emit target-typed replacement body
      // instead of the source. Call sites in user code get rewritten
      // (& stripped from AccountInfo args) via applyCpiWrapperCallSiteRewrites.
      const wrapper = recognizeCpiWrapperHelper(helper.name, helper.signature, helper.body, this.frameworkName);
      if (wrapper) {
        sections.push(`// CPI-wrapper helper — target-typed replacement for source's \`${helper.name}\`\n${wrapper.signature} ${wrapper.body}`);
        continue;
      }
      if (this.unsalvageableHelpers.has(helper.name)) {
        sections.push(commentOutHelperBlock(helper.rawCode, helper.name, this.frameworkName));
        continue;
      }
      const carried = this.carriedFunctionBlock(helper.rawCode, ir);
      const refsInstrContext = [...instrContextNames].some((n) => new RegExp(`\\b${n}(?:Accounts|Args|Base|Bumps)?\\b`).test(carried));
      if (hasResidualUnsupportedBody(carried) || hasResidualUnsalvageablePatterns(carried) || refsInstrContext) {
        const stubbed = carried
          .replace(/^\/\/ Carried from source \([^)]*\)/, "// Carried from source (body stubbed — unsupported patterns)")
          .replace(/\{[\s\S]*$/, `{\n    unimplemented!("Anvil: carried helper with unsupported body")\n}`);
        sections.push(stubbed);
      } else {
        sections.push(carried);
      }
    }

    if (sections.length === 1) return "";
    let joined = sections.join("\n\n");
    // G80 — add `<'info>` generic to helper fns whose signatures reference
    // 'info but don't declare it (Native target only — Pinocchio's
    // AccountInfo is lifetime-free).
    if (this.frameworkName === "Native") {
      joined = addInfoLifetimeIfReferenced(joined);
    }
    // G90 attempt: apply commentOutUnsalvageableCallSites to helpers.rs.
    // Reverted because the brace-balance walker doesn't account for
    // commented-out helper bodies (which are pure text), and the call-site
    // range expansion swallowed `}` of unrelated sibling helpers. Caused
    // global "unexpected closing delimiter `}`" — all 6 large fixtures
    // collapsed to a single brace-balance error. Defer until the walker
    // can skip already-commented spans.
    joined = commentOutResidualAnchorLeaks(joined);
    return `//! Helper functions for ${toPascalCase(ir.name)}\n\n` + joined;
  }

  /**
   * Top-level const decls in lib.rs can call `const fn` helpers; Rust
   * requires those helpers to be visible at the const's scope. When the
   * helpers live in helpers.rs (their default home), the const-call is
   * unresolved. Returns the helpers referenced by any top-level const
   * so the lib.rs emit can hoist their bodies inline. The helpers.rs
   * emit then skips these to avoid duplicate definitions.
   *
   * Detection is text-based: for each helper, check if its identifier
   * appears as a call expression (`name(`) in any const decl. Skips
   * helpers that are CPI-wrapper templates or unsalvageable — only
   * carried-source helpers can be hoisted byte-for-byte.
   */
  protected helpersReferencedByConsts(ir: SolanaIR, processedConsts: string[]): HelperFn[] {
    if (processedConsts.length === 0) return [];
    const out: HelperFn[] = [];
    for (const helper of ir.helperFns ?? []) {
      if (this.unsalvageableHelpers.has(helper.name)) continue;
      const callRe = new RegExp(`\\b${helper.name}\\s*\\(`);
      if (processedConsts.some((c) => callRe.test(c))) {
        out.push(helper);
      }
    }
    return out;
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

  /**
   * G17 — emit ZeroCopy / Owner / Discriminator trait STUBS at lib.rs
   * scope so user-defined wrappers like raydium-clmm's
   *   pub struct AccountLoad<'info, T: ZeroCopy + Owner> { … }
   * resolve their trait bounds. Anchor's actual traits live in
   * `anchor_lang::ZeroCopy + Owner + Discriminator`; Anvil strips
   * anchor_lang imports, so any user code carrying these bounds
   * verbatim breaks at cargo with "cannot find trait ZeroCopy".
   *
   * Trait shapes mirror Anchor's surface:
   *   - Discriminator: `const DISCRIMINATOR: [u8; 8]`
   *   - Owner: `fn owner() -> Pubkey`
   *   - ZeroCopy: marker, super-trait of Discriminator + Owner
   *
   * Fires when at least one AccountDef OR TypeDef has isZeroCopy = true.
   * Skipped otherwise so non-zero-copy programs don't see stub noise.
   *
   * The corresponding `impl Discriminator/Owner/ZeroCopy for X` blocks
   * are emitted per-account in each target emitter's emitAccountStruct.
   */
  protected emitZeroCopyTraits(ir: SolanaIR): string {
    const hasZcAcc = ir.accounts.some((a) => a.isZeroCopy);
    const hasZcType = (ir.types ?? []).some((t) => t.isZeroCopy);
    if (!hasZcAcc && !hasZcType) return "";
    return `// ⚠️ Anvil: ZeroCopy / Owner / Discriminator trait stubs for user-defined
// generic wrappers (e.g. AccountLoad<'info, T: ZeroCopy + Owner>). Anchor
// supplies these traits via anchor_lang; Anvil strips anchor_lang imports,
// so the bounds need somewhere to resolve. Shapes mirror Anchor's surface
// to satisfy cargo type-check. Runtime semantics for owner() default to
// the zero-Pubkey — user code that compares ownership against T::owner()
// will need to hand-port if real validation is required.
pub trait Discriminator {
    const DISCRIMINATOR: [u8; 8];
}
pub trait Owner {
    fn owner() -> Pubkey;
}
pub trait ZeroCopy: Discriminator + Owner {}`;
  }

  /**
   * G22 helper — given a generic-params clause like `<'a, 'info: 'a>` or
   * `<T: Trait + Send, U: Clone>`, return the bare-param form `<'a, 'info>`
   * or `<T, U>` suitable for type instantiation. Empty input → empty out.
   *
   * Depth-aware split on `,` (parens/brackets/angles tracked), then per-
   * param trim everything after the first `:` at depth 0.
   */
  /**
   * G27a — detect references to anchor_lang's SysInstructions sysvar.
   */
  /** G66 — detect references to anchor_lang's CpiContext<T>. */
  protected referencesAnchorCpiContext(ir: SolanaIR): boolean {
    const RE = /\bCpiContext\b/;
    for (const h of ir.helperFns ?? []) {
      if (RE.test(h.rawCode ?? "") || RE.test(h.body ?? "")) return true;
    }
    for (const acc of ir.accounts) {
      for (const item of acc.implItems ?? []) if (RE.test(item)) return true;
    }
    for (const t of ir.types ?? []) {
      for (const item of t.implItems ?? []) if (RE.test(item)) return true;
    }
    for (const ut of ir.userTraits ?? []) if (RE.test(ut)) return true;
    for (const uti of ir.userTraitImpls ?? []) if (RE.test(uti)) return true;
    for (const instr of ir.instructions ?? []) {
      for (const stmt of instr.body ?? []) {
        if ("code" in stmt && stmt.code && RE.test(stmt.code)) return true;
        if ("rawCode" in stmt && stmt.rawCode && RE.test(stmt.rawCode)) return true;
      }
    }
    return false;
  }

  /** G66 — stub CpiContext<T>. Just the fluent surface for type-resolution. */
  protected emitAnchorCpiContextStub(): string {
    return `// G66 — anchor_lang::context::CpiContext<T> stub. Fluent builder
// surface for typed Anchor CPIs (\`CpiContext::new(...)\`,
// \`CpiContext::new_with_signer(...)\`, \`.with_signer(...)\`,
// \`.with_remaining_accounts(...)\`). Real CPI execution lives in
// per-CPI typed IR — call sites that pass this to anchor_spl::token::*
// fns won't compile since those are stripped. The TYPE resolves so
// downstream code parses.
pub struct CpiContext<'a, 'b, 'c, 'info, T> {
    pub accounts: T,
    pub remaining_accounts: alloc::vec::Vec<&'info AccountInfo>,
    pub program: &'a AccountInfo,
    pub signer_seeds: &'b [&'c [&'c [u8]]],
}
impl<'a, 'b, 'c, 'info, T> CpiContext<'a, 'b, 'c, 'info, T> {
    pub fn new(program: &'a AccountInfo, accounts: T) -> Self {
        Self { accounts, remaining_accounts: alloc::vec::Vec::new(), program, signer_seeds: &[] }
    }
    pub fn new_with_signer(
        program: &'a AccountInfo,
        accounts: T,
        signer_seeds: &'b [&'c [&'c [u8]]],
    ) -> Self {
        Self { accounts, remaining_accounts: alloc::vec::Vec::new(), program, signer_seeds }
    }
    pub fn with_signer(mut self, signer_seeds: &'b [&'c [&'c [u8]]]) -> Self {
        self.signer_seeds = signer_seeds;
        self
    }
    pub fn with_remaining_accounts(
        mut self,
        ras: alloc::vec::Vec<&'info AccountInfo>,
    ) -> Self {
        self.remaining_accounts = ras;
        self
    }
}`;
  }

  /** G65 — detect references to anchor_lang's AccountLoader<T>. */
  protected referencesAnchorAccountLoader(ir: SolanaIR): boolean {
    const RE = /\bAccountLoader\b/;
    for (const h of ir.helperFns ?? []) {
      if (RE.test(h.rawCode ?? "") || RE.test(h.body ?? "")) return true;
    }
    for (const acc of ir.accounts) {
      for (const item of acc.implItems ?? []) if (RE.test(item)) return true;
    }
    for (const t of ir.types ?? []) {
      for (const item of t.implItems ?? []) if (RE.test(item)) return true;
    }
    for (const ut of ir.userTraits ?? []) if (RE.test(ut)) return true;
    for (const uti of ir.userTraitImpls ?? []) if (RE.test(uti)) return true;
    return false;
  }

  /** G79 — emit per-trait stubs for anchor_lang traits referenced by carried
   * code. Each trait gates emit on whether its name appears in any user-
   * written impl/helper body — we don't add unused stubs. */
  protected emitAnchorMiscTraitStubs(ir: SolanaIR): string {
    const allCarried: string[] = [];
    for (const h of ir.helperFns ?? []) {
      if (h.rawCode) allCarried.push(h.rawCode);
      if (h.body) allCarried.push(h.body);
    }
    for (const acc of ir.accounts) for (const item of acc.implItems ?? []) allCarried.push(item);
    for (const t of ir.types ?? []) for (const item of t.implItems ?? []) allCarried.push(item);
    for (const ut of ir.userTraits ?? []) allCarried.push(ut);
    for (const uti of ir.userTraitImpls ?? []) allCarried.push(uti);
    const all = allCarried.join("\n");
    // G79b — skip stub when user code already defines the trait with the
    // same name. Openbook-v2 has `pub trait Owner` in its source; our stub
    // would E0428 "the name `Owner` is defined multiple times".
    // G79c — also skip Discriminator + Owner when the ZeroCopy stub will
    // emit them (gated on hasZcAcc/hasZcType — see emitZeroCopyTraitStubs).
    const hasZeroCopyStub = ir.accounts.some((a) => a.isZeroCopy) ||
      (ir.types ?? []).some((t) => t.isZeroCopy);
    const userDefinesTrait = (name: string) =>
      new RegExp(`\\bpub\\s+trait\\s+${name}\\b`).test(all) ||
      (hasZeroCopyStub && (name === "Discriminator" || name === "Owner"));
    const stubs: string[] = [];
    if (/\bDiscriminator\b/.test(all) && !userDefinesTrait("Discriminator")) {
      stubs.push(`pub trait Discriminator { const DISCRIMINATOR: [u8; 8]; }`);
    }
    if (/\bAccountDeserialize\b/.test(all) && !userDefinesTrait("AccountDeserialize")) {
      stubs.push(`pub trait AccountDeserialize: Sized {\n    fn try_deserialize(buf: &mut &[u8]) -> Result<Self, ProgramError>;\n    fn try_deserialize_unchecked(buf: &mut &[u8]) -> Result<Self, ProgramError>;\n}`);
    }
    if (/\bAccountSerialize\b/.test(all) && !userDefinesTrait("AccountSerialize")) {
      stubs.push(`pub trait AccountSerialize {\n    fn try_serialize<W: borsh::io::Write>(&self, writer: &mut W) -> Result<(), ProgramError> { Ok(()) }\n}`);
    }
    if (/\bOwner\b(?!\s*\()/.test(all) && !/\bcollection_authority\.Owner\b/.test(all) && !userDefinesTrait("Owner")) {
      stubs.push(`pub trait Owner {\n    fn owner() -> Pubkey;\n}`);
    }
    // G95 — Key trait (anchor_lang::Key) used as a bound on T. Real-world
    // Anchor programs (openbook NonZeroKey, marinade ToAccountInfo) carry
    // `where T: Key` impls that need the trait def.
    if (/:\s*Key\b|<\s*Key\b|\bT:\s*Key\b|where\s+\w+:\s*Key\b/.test(all) && !userDefinesTrait("Key")) {
      stubs.push(`pub trait Key {\n    fn key(&self) -> Pubkey;\n}`);
    }
    if (this.referencesAnchorEventTrait(ir) && !userDefinesTrait("Event")) {
      stubs.push(this.emitAnchorEventTraitStub());
    }
    // G100 reverted — `pub trait ToAccountInfo<'info>` with explicit
    // lifetime cascaded marinade +175 (carried impls without matching
    // <'info> generic become invalid). Lifetime-free shape would
    // conflict differently; defer until we can map carried impl arity.
    // G95 — AnchorError struct stub. Openbook's Contextable impl wraps
    // ProgramError into a user Error enum with Box<AnchorError> variant;
    // the AnchorError struct itself comes from anchor_lang. Minimal shape
    // gives the wrap call sites a constructable type.
    const userDefinesStruct = (name: string) =>
      new RegExp(`\\bpub\\s+struct\\s+${name}\\b`).test(all);
    if (/\bAnchorError\b/.test(all) && !userDefinesStruct("AnchorError")) {
      stubs.push(`pub struct AnchorError {\n    pub error_msg: String,\n    pub error_code_number: u32,\n}`);
    }
    if (stubs.length === 0) return "";
    return `// G79 — anchor_lang trait stubs. Carried impl blocks ($Anchor's\n// #[account]/#[zero_copy] macros expand to impl Owner/Discriminator/\n// Account[De]Serialize) reference these traits; we strip the anchor_lang\n// import but the impl blocks survive. Minimal compile-clean shape; real\n// semantics need the wire-format/owner data Anvil already emits separately.\n${stubs.join("\n\n")}`;
  }

  /** G65 — stub AccountLoader<T> as an opaque wrapper. Minimal compile-
   *  clean shape; real zero-copy semantics need type-aware mapping. */
  protected emitAnchorAccountLoaderStub(): string {
    // G92 — AccountInfo carries an explicit lifetime on Native
    // (solana_program::account_info::AccountInfo<'a>) but is unparameterized
    // on Pinocchio. Reference the right shape so the field-type compiles.
    const aiRef = this.frameworkName === "Native"
      ? "&'info AccountInfo<'info>"
      : "&'info AccountInfo";
    return `// G65 — anchor_lang::accounts::account_loader::AccountLoader<T> stub.
// Wraps an AccountInfo; \`try_from\` is a placeholder that returns
// the AccountInfo's pubkey context as the stored value. Real
// load()/load_mut() semantics need type-aware bytemuck casts —
// the helper bodies that use these methods will surface as cargo
// errors at call sites, but the TYPE resolves so downstream
// code compiles.
pub struct AccountLoader<'info, T> {
    pub ai: ${aiRef},
    _phantom: core::marker::PhantomData<T>,
}
impl<'info, T> AccountLoader<'info, T> {
    pub fn try_from(ai: ${aiRef}) -> Result<Self, ProgramError> {
        Ok(Self { ai, _phantom: core::marker::PhantomData })
    }
    pub fn try_from_unchecked(_program_id: &Pubkey, ai: ${aiRef}) -> Result<Self, ProgramError> {
        Ok(Self { ai, _phantom: core::marker::PhantomData })
    }
}
// G89 — load/load_mut/load_init stubs on AccountLoader. Real-world Anchor
// programs (raydium, kamino) call \`reserve.load()?\` / \`reserve.load_mut()?\`
// on AccountLoader-wrapped zero-copy state. Stubs return unimplemented!()
// so the load() call resolves to a never-type — type inference at the
// call site accepts any expected Ref<T>/RefMut<T>. Real semantics need
// type-aware bytemuck casts behind a RefCell-shaped wrapper; deferred.
impl<'info, T> AccountLoader<'info, T> {
    pub fn load(&self) -> Result<core::cell::Ref<'_, T>, ProgramError> {
        unimplemented!("anvil: AccountLoader::load stub — real impl needs RefCell + bytemuck::from_bytes")
    }
    pub fn load_mut(&self) -> Result<core::cell::RefMut<'_, T>, ProgramError> {
        unimplemented!("anvil: AccountLoader::load_mut stub")
    }
    pub fn load_init(&self) -> Result<core::cell::RefMut<'_, T>, ProgramError> {
        unimplemented!("anvil: AccountLoader::load_init stub")
    }
}`;
  }

  /** G52 — detect references to anchor_lang's Event trait. */
  protected referencesAnchorEventTrait(ir: SolanaIR): boolean {
    // Match `T: Event` trait bound or `dyn Event` or `impl Event` shapes.
    const RE = /:\s*Event\b|<\s*Event\b|\bdyn\s+Event\b|\bimpl\s+Event\b/;
    for (const h of ir.helperFns ?? []) {
      if (RE.test(h.rawCode ?? "") || RE.test(h.body ?? "")) return true;
    }
    for (const acc of ir.accounts) {
      for (const item of acc.implItems ?? []) if (RE.test(item)) return true;
    }
    for (const t of ir.types ?? []) {
      for (const item of t.implItems ?? []) if (RE.test(item)) return true;
    }
    for (const ut of ir.userTraits ?? []) if (RE.test(ut)) return true;
    for (const uti of ir.userTraitImpls ?? []) if (RE.test(uti)) return true;
    return false;
  }

  /** G52 — emit a stub `pub trait Event` mirroring anchor_lang's. */
  protected emitAnchorEventTraitStub(): string {
    return `// G52 — anchor_lang::Event trait stub. Carried helpers use the
// trait bound to gate functions on Borsh-serializable types with an
// 8-byte discriminator. Matches anchor_lang's public shape.
pub trait Event: BorshSerialize + BorshDeserialize {
    const DISCRIMINATOR: [u8; 8];
}`;
  }

  /**
   * Finding #26 — emit the Event trait stub TOGETHER with `impl Event for E`
   * per event struct. The bundling is what closes the G75/G93/G98 cascade:
   * the trait def alone is orphan (T: Event bound unresolves on inherent
   * impl blocks); paired with impls, the trait + impls form a closed loop
   * the rest of the carried code resolves against.
   */
  protected emitAnchorEventTraitWithImpls(ir: SolanaIR): string {
    const parts: string[] = [this.emitAnchorEventTraitStub()];
    for (const ev of (ir.events ?? [])) {
      const { len: discLen, expr: discExpr } = this.eventDiscInfo(ev);
      parts.push(
        `impl Event for ${ev.name} {\n    const DISCRIMINATOR: [u8; ${discLen}] = ${discExpr};\n}`,
      );
    }
    return parts.join("\n\n");
  }

  /** G48 — detect references to anchor_lang's built-in ErrorCode enum. */
  protected referencesAnchorErrorCode(ir: SolanaIR): boolean {
    const RE = /\bErrorCode\s*::/;
    for (const h of ir.helperFns ?? []) {
      if (RE.test(h.rawCode ?? "") || RE.test(h.body ?? "")) return true;
    }
    for (const acc of ir.accounts) {
      for (const item of acc.implItems ?? []) if (RE.test(item)) return true;
    }
    for (const t of ir.types ?? []) {
      for (const item of t.implItems ?? []) if (RE.test(item)) return true;
    }
    for (const ut of ir.userTraits ?? []) if (RE.test(ut)) return true;
    for (const uti of ir.userTraitImpls ?? []) if (RE.test(uti)) return true;
    for (const instr of ir.instructions ?? []) {
      for (const stmt of instr.body ?? []) {
        if ("code" in stmt && stmt.code && RE.test(stmt.code)) return true;
        if ("rawCode" in stmt && stmt.rawCode && RE.test(stmt.rawCode)) return true;
      }
    }
    return false;
  }

  /** G48 — emit a stub `pub enum ErrorCode` mirroring anchor_lang::error::
   *  ErrorCode's variant list. All variants map to `ProgramError::Custom`
   *  with anchor_lang's canonical numeric codes. */
  protected emitAnchorErrorCodeStub(): string {
    return `// G48 — anchor_lang::error::ErrorCode stub. Carried code uses
// these variants for runtime checks (account ownership/discriminator
// validation in particular). Map each to a unique custom code so
// callers can match by discriminant.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u32)]
pub enum ErrorCode {
    InstructionMissing = 100,
    InstructionFallbackNotFound = 101,
    InstructionDidNotDeserialize = 102,
    InstructionDidNotSerialize = 103,
    IdlInstructionStub = 1000,
    IdlInstructionInvalidProgram = 1001,
    ConstraintMut = 2000,
    ConstraintHasOne = 2001,
    ConstraintSigner = 2002,
    ConstraintRaw = 2003,
    ConstraintOwner = 2004,
    ConstraintRentExempt = 2005,
    ConstraintSeeds = 2006,
    ConstraintExecutable = 2007,
    ConstraintState = 2008,
    ConstraintAssociated = 2009,
    ConstraintAssociatedInit = 2010,
    ConstraintClose = 2011,
    ConstraintAddress = 2012,
    ConstraintZero = 2013,
    ConstraintTokenMint = 2014,
    ConstraintTokenOwner = 2015,
    ConstraintMintMintAuthority = 2016,
    ConstraintMintFreezeAuthority = 2017,
    ConstraintMintDecimals = 2018,
    ConstraintSpace = 2019,
    RequireViolated = 2500,
    RequireEqViolated = 2501,
    RequireKeysEqViolated = 2502,
    RequireNeqViolated = 2503,
    RequireKeysNeqViolated = 2504,
    RequireGtViolated = 2505,
    RequireGteViolated = 2506,
    AccountDiscriminatorAlreadySet = 3000,
    AccountDiscriminatorNotFound = 3001,
    AccountDiscriminatorMismatch = 3002,
    AccountDidNotDeserialize = 3003,
    AccountDidNotSerialize = 3004,
    AccountNotEnoughKeys = 3005,
    AccountNotMutable = 3006,
    AccountOwnedByWrongProgram = 3007,
    InvalidProgramId = 3008,
    InvalidProgramExecutable = 3009,
    AccountNotSigner = 3010,
    AccountNotSystemOwned = 3011,
    AccountNotInitialized = 3012,
    AccountNotProgramData = 3013,
    AccountNotAssociatedTokenAccount = 3014,
    AccountSysvarMismatch = 3015,
    AccountReallocExceedsLimit = 3016,
    AccountDuplicateReallocs = 3017,
    StateInvalidAddress = 4000,
    Deprecated = 5000,
}
impl From<ErrorCode> for ProgramError {
    fn from(e: ErrorCode) -> Self { ProgramError::Custom(e as u32) }
}`;
  }

  /** G44 — detect `token_interface::accessor::amount(...)` references. */
  protected referencesTokenInterfaceAccessor(ir: SolanaIR): boolean {
    const RE = /\btoken_interface\s*::\s*accessor\s*::\s*amount\s*\(/;
    for (const h of ir.helperFns ?? []) {
      if (RE.test(h.rawCode ?? "") || RE.test(h.body ?? "")) return true;
    }
    for (const acc of ir.accounts) {
      for (const item of acc.implItems ?? []) if (RE.test(item)) return true;
    }
    for (const t of ir.types ?? []) {
      for (const item of t.implItems ?? []) if (RE.test(item)) return true;
    }
    for (const instr of ir.instructions ?? []) {
      for (const stmt of instr.body ?? []) {
        if ("code" in stmt && stmt.code && RE.test(stmt.code)) return true;
        if ("rawCode" in stmt && stmt.rawCode && RE.test(stmt.rawCode)) return true;
      }
    }
    return false;
  }

  /** G44 — emit a stub `token_interface::accessor::amount` reading bytes
   *  at offset 64 of an SPL TokenAccount. Common on both Token and Token-2022.
   */
  protected emitTokenInterfaceAccessorStub(): string {
    return `// G44 — anchor_spl::token_interface::accessor stub. Reads
// TokenAccount.amount (u64 at offset 64) from the raw account data.
// Works for both spl-token and spl-token-2022 token accounts since
// the canonical 165-byte base layout is identical.
pub mod token_interface {
    pub mod accessor {
        use super::super::*;
        pub fn amount(ai: &AccountInfo) -> Result<u64, ProgramError> {
            let data = ai.try_borrow_data().map_err(|_| ProgramError::AccountBorrowFailed)?;
            if data.len() < 72 {
                return Err(ProgramError::InvalidAccountData);
            }
            let mut bytes = [0u8; 8];
            bytes.copy_from_slice(&data[64..72]);
            Ok(u64::from_le_bytes(bytes))
        }
    }
}`;
  }

  /** G43 — detect bare `Result<T>` references in carried code that would
   *  resolve to std::Result (2-arg) instead of Anchor's 1-arg alias. */
  protected referencesBareResultAlias(ir: SolanaIR): boolean {
    // Match `Result<T>` where T is a single type parameter (no `,` at
    // depth 0). Skip `::Result<...>` (already-qualified) and `Result<,>`.
    const RE = /(?<![:\w])\bResult\s*<\s*[^,<>]+\s*>/;
    // Also match Result<&T> / Result<RefMut<T>> via inner-balanced check —
    // the simple "no comma at top" version above already covers these.
    for (const ut of ir.userTraits ?? []) if (RE.test(ut)) return true;
    for (const uti of ir.userTraitImpls ?? []) if (RE.test(uti)) return true;
    for (const h of ir.helperFns ?? []) {
      if (RE.test(h.rawCode ?? "") || RE.test(h.body ?? "")) return true;
    }
    for (const acc of ir.accounts) {
      for (const item of acc.implItems ?? []) if (RE.test(item)) return true;
    }
    for (const t of ir.types ?? []) {
      for (const item of t.implItems ?? []) if (RE.test(item)) return true;
    }
    return false;
  }

  /** G40 — detect references to LAMPORTS_PER_SOL (sun, sol, lamport math). */
  protected referencesLamportsPerSol(ir: SolanaIR): boolean {
    const RE = /\bLAMPORTS_PER_SOL\b/;
    for (const h of ir.helperFns ?? []) {
      if (RE.test(h.rawCode ?? "") || RE.test(h.body ?? "")) return true;
    }
    for (const acc of ir.accounts) {
      for (const item of acc.implItems ?? []) if (RE.test(item)) return true;
    }
    for (const t of ir.types ?? []) {
      for (const item of t.implItems ?? []) if (RE.test(item)) return true;
    }
    for (const c of ir.constants ?? []) if (RE.test(c)) return true;
    for (const instr of ir.instructions ?? []) {
      for (const stmt of instr.body ?? []) {
        if ("code" in stmt && stmt.code && RE.test(stmt.code)) return true;
        if ("rawCode" in stmt && stmt.rawCode && RE.test(stmt.rawCode)) return true;
      }
    }
    return false;
  }

  /** G27f — detect references to spl_token_2022::extension::ExtensionType. */
  protected shouldEmitExtensionTypeStub(ir: SolanaIR): boolean {
    const RE = /\bExtensionType\b/;
    for (const h of ir.helperFns ?? []) {
      if (RE.test(h.rawCode ?? "") || RE.test(h.body ?? "")) return true;
    }
    for (const acc of ir.accounts) {
      for (const item of acc.implItems ?? []) if (RE.test(item)) return true;
    }
    for (const t of ir.types ?? []) {
      for (const item of t.implItems ?? []) if (RE.test(item)) return true;
    }
    for (const c of ir.constants ?? []) if (RE.test(c)) return true;
    return false;
  }

  /** Emit ExtensionType stub enum with all known Token-2022 extension variants. */
  protected emitExtensionTypeStub(): string {
    return `// G27f — spl_token_2022::extension::ExtensionType stub. Stripped at
// import time (no anchor_spl on target); carried code uses variants
// directly. Emit the union of known SPL Token-2022 extension types.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u16)]
pub enum ExtensionType {
    Uninitialized = 0,
    TransferFeeConfig = 1,
    TransferFeeAmount = 2,
    MintCloseAuthority = 3,
    ConfidentialTransferMint = 4,
    ConfidentialTransferAccount = 5,
    DefaultAccountState = 6,
    ImmutableOwner = 7,
    MemoTransfer = 8,
    NonTransferable = 9,
    InterestBearingConfig = 10,
    CpiGuard = 11,
    PermanentDelegate = 12,
    NonTransferableAccount = 13,
    TransferHook = 14,
    TransferHookAccount = 15,
    ConfidentialTransferFeeConfig = 16,
    ConfidentialTransferFeeAmount = 17,
    MetadataPointer = 18,
    TokenMetadata = 19,
    GroupPointer = 20,
    TokenGroup = 21,
    GroupMemberPointer = 22,
    TokenGroupMember = 23,
    ScaledUiAmount = 24,
    Pausable = 25,
    PausableAccount = 26,
    ScaledUiAmountConfig = 27,
    PausableConfig = 28,
}`;
  }

  /** G27e — detect references to solana_program::clock::Slot (a u64 alias). */
  protected shouldEmitSlotAlias(ir: SolanaIR): boolean {
    // Match `Slot` as a TYPE position (parameter, field, return). Skip
    // `crate::Slot`, `something::Slot`, `Slot::method()` etc.
    const RE = /(?:^|[\s,:(<&])Slot(?:[\s,)>;=]|$)/;
    for (const h of ir.helperFns ?? []) {
      if (RE.test(h.rawCode ?? "") || RE.test(h.body ?? "")) return true;
    }
    for (const acc of ir.accounts) {
      for (const item of acc.implItems ?? []) if (RE.test(item)) return true;
    }
    for (const t of ir.types ?? []) {
      for (const item of t.implItems ?? []) if (RE.test(item)) return true;
    }
    return false;
  }

  protected shouldEmitSysInstructionsStub(ir: SolanaIR): boolean {
    const RE = /\bSysInstructions\b/;
    for (const h of ir.helperFns ?? []) {
      if (RE.test(h.rawCode ?? "") || RE.test(h.body ?? "")) return true;
    }
    for (const acc of ir.accounts) {
      for (const item of acc.implItems ?? []) if (RE.test(item)) return true;
    }
    for (const t of ir.types ?? []) {
      for (const item of t.implItems ?? []) if (RE.test(item)) return true;
    }
    for (const ix of ir.instructions ?? []) {
      for (const stmt of ix.body ?? []) {
        const code = (stmt as any).code;
        if (typeof code === "string" && RE.test(code)) return true;
      }
      // Instruction account constraints — e.g. `address = SysInstructions::id()`
      for (const a of (ix as any).accounts ?? []) {
        for (const c of a.constraints ?? []) {
          if (typeof c.value === "string" && RE.test(c.value)) return true;
        }
      }
    }
    return false;
  }

  /**
   * G27a — emit a SysInstructions stub.
   * Sysvar pubkey: Sysvar1nstructions1111111111111111111111111
   * Bytes: [6, 167, 213, 23, 25, 47, 10, 175, 198, 242, 101, 227, 251, 119, 204,
   *         122, 218, 130, 197, 41, 208, 190, 59, 19, 110, 45, 0, 85, 32, 0, 0, 0]
   */
  protected emitSysInstructionsStub(): string {
    return `// G27a — anchor_lang sysvar stub. Carried code uses SysInstructions::id()
// for instruction-sysvar account verification (kamino's deposit_reserve_liquidity,
// socialize_loss patterns). Returns the well-known sysvar pubkey verbatim.
pub struct SysInstructions;
impl SysInstructions {
    pub fn id() -> Pubkey { ${this.programIdConstExpr("6, 167, 213, 23, 25, 47, 10, 175, 198, 242, 101, 227, 251, 119, 204, 122, 218, 130, 197, 41, 208, 190, 59, 19, 110, 45, 0, 85, 32, 0, 0, 0")} }
}`;
  }

  /**
   * G19b — detect whether carried helper code references the anchor_lang
   * `Error` type. Scan helper-fn body text AND impl items (raw code) for
   * `Error::` (constructor / static call) or `: Error,` (field/param type)
   * or `-> Error` (return type) or `<Error>` (generic arg) shapes.
   *
   * Conservative: only fires when a real reference exists. Programs that
   * don't carry such code see no change.
   */
  protected shouldEmitErrorStub(ir: SolanaIR): boolean {
    const RE = /\bError(?:::|\s*[,>;)])/;
    for (const h of ir.helperFns ?? []) {
      if (RE.test(h.rawCode ?? "") || RE.test(h.body ?? "")) return true;
    }
    for (const acc of ir.accounts) {
      for (const item of acc.implItems ?? []) {
        if (RE.test(item)) return true;
      }
    }
    for (const t of ir.types ?? []) {
      for (const item of t.implItems ?? []) {
        if (RE.test(item)) return true;
      }
    }
    return false;
  }

  /**
   * G19b — emit a builder-pattern stub for anchor_lang::Error. Wraps
   * ProgramError; chainable methods return self verbatim (no runtime
   * effect). Lets cargo type-check `Error::from(X).with_pubkeys(...)`
   * shapes without runtime semantics.
   */
  protected emitErrorStub(): string {
    return `// G19b — Anchor's anchor_lang::Error type stub. Carried code uses
// Error::from(X).with_pubkeys(...).with_source(...) chains; Anvil strips
// anchor_lang, so we provide a builder shape that satisfies cargo
// type-check. Runtime semantics: the builder no-ops; the inner
// ProgramError is what surfaces.
pub struct Error(pub ProgramError);
impl Error {
    pub fn from<E: Into<ProgramError>>(e: E) -> Self { Self(e.into()) }
    pub fn with_pubkeys<T>(self, _arg: T) -> Self { self }
    pub fn with_source<T>(self, _arg: T) -> Self { self }
    pub fn with_account_name<T>(self, _arg: T) -> Self { self }
    pub fn with_values<T>(self, _arg: T) -> Self { self }
}
impl From<Error> for ProgramError {
    fn from(e: Error) -> Self { e.0 }
}`;
  }

  /**
   * G19 — emit `pub const ID: Pubkey = …;` + `pub fn id() -> Pubkey { ID }`
   * at the crate root. Anchor's `declare_id!("...")` expands to these
   * two items, both publicly accessible from carried code as `crate::ID`
   * and `crate::id()`. Anvil's emit previously skipped them — programs
   * with helper bodies that reference these (raydium-clmm:
   *   pub fn unpack_owner(info: &AccountInfo) -> Result<Pubkey> {
   *       if info.owner != &crate::id() { ... }
   *   }
   * ) failed with E0425/E0433. Idempotent on programs without ir.programId.
   *
   * Pubkey representation differs per-target ([u8;32] for Pinocchio,
   * solana_program::Pubkey for Native) — `defaultPubkeyValue` is the
   * "constructor" wrapper. For the const, we emit the byte array
   * directly since Pubkey::new_from_array is const-stable on both.
   */
  protected emitProgramIdConst(ir: SolanaIR): string {
    const programId = ir.programId;
    if (!programId) return "";
    const bytes = decodeBase58(programId);
    if (!bytes || bytes.length !== 32) return "";
    const byteList = bytes.join(", ");
    return `// G19 — Anchor's declare_id!() expands to these two items at crate root.
// Carried code may reference \`crate::ID\` or \`crate::id()\` for ownership
// checks and PDA derivations — stub them so emit stays compilable.
pub const ID: Pubkey = ${this.programIdConstExpr(byteList)};
pub fn id() -> Pubkey { ID }`;
  }

  /**
   * Target-specific Pubkey construction for the program ID const.
   * Pinocchio: bare `[u8; 32]` literal (Pubkey IS the array).
   * Native: `solana_program::pubkey::Pubkey::new_from_array([...])`.
   */
  protected programIdConstExpr(byteList: string): string {
    return `[${byteList}]`;
  }

  /**
   * G17 — emit `impl Discriminator + Owner + ZeroCopy for X { … }` block
   * for a zero-copy account. Called by per-target emitAccountStruct.
   *
   * Discriminator delegates to the inherent const `Self::DISCRIMINATOR`
   * already emitted on the account struct. Owner returns a target-typed
   * zero-Pubkey stub.
   */
  protected emitZeroCopyTraitImpls(accName: string, discLen: number = 8): string {
    // #60 — The user-facing `Discriminator` trait stub declares `[u8; 8]`;
    // a zero-copy account with `#[account(discriminator = ...)]` overriding
    // to a different length would fail this impl. The combination is rare
    // (zero-copy + custom-disc) and the override path doesn't surface here
    // unless the caller forwards a non-8 discLen — in which case we skip
    // the trait impls, since the trait shape itself isn't variable.
    if (discLen !== 8) {
      return `impl Owner for ${accName} { fn owner() -> Pubkey { ${this.defaultPubkeyValue()} } }`;
    }
    return `impl Discriminator for ${accName} { const DISCRIMINATOR: [u8; 8] = Self::DISCRIMINATOR; }
impl Owner for ${accName} { fn owner() -> Pubkey { ${this.defaultPubkeyValue()} } }
impl ZeroCopy for ${accName} {}`;
  }

  // ── Combined single-file output ──

  protected emitSingleFile(ir: SolanaIR): string {
    const sections: string[] = [];
    const constants = (ir.constants ?? []).map((c) => this.postProcessTopLevelConst(c));
    const types = (ir.types ?? []).filter((t) => !FRAMEWORK_SHADOW_TYPES.has(t.name));

    sections.push(this.fileHeader(ir.name));
    sections.push(this.emitUseStatements(ir));
    const zeroCopyTraits = this.emitZeroCopyTraits(ir);
    if (zeroCopyTraits) sections.push(zeroCopyTraits);
    if (constants.length > 0) sections.push(constants.join("\n\n"));
    if (types.length > 0) sections.push(this.emitCustomTypes({ ...ir, types }));
    const userTraitImplsSingle = this.emitUserTraitImpls(ir);
    if (userTraitImplsSingle) sections.push(userTraitImplsSingle);
    // Finding #67 — same userModules splat as emitLibFile, applied here so
    // singleFile builds also preserve top-level free `mod X { ... }` blocks
    // (e.g. interface-account's `mod interface { pub struct ExpectedAccount }`).
    const userModulesSingle = (ir as any).userModules ?? [];
    if (userModulesSingle.length > 0) {
      const target = this.frameworkName === "Pinocchio" ? "pin" : "native";
      const processed = userModulesSingle.map((um: string) => {
        let code = stripAnchorWrappersInCode(stripAnchorLangPrefixes(um), target);
        code = rewriteMsgCallsImpl(code, (m: string) => this.emitMsg(m));
        return code;
      });
      sections.push(`// User-defined modules preserved verbatim from source\n${processed.join("\n\n")}`);
    }
    // Inline event struct definitions when the source has #[event] structs.
    // Multi-file emit puts these in events.rs; for single-file builds they
    // need to live alongside the rest. emit!() lowering references the
    // typename + ::DISCRIMINATOR const, so the definitions must be in scope.
    if ((ir.events ?? []).length > 0) {
      // Strip `//!` inner-doc comments (only valid at file-top), the
      // `use borsh::...` line (already emitted by emitUseStatements when
      // events are present, so the inlined re-import would cause E0252),
      // and `use super::*;` (only valid in events.rs as a sub-module
      // pulling from lib.rs; in single-file mode the code already lives
      // at lib.rs top-level so super has nothing to reach).
      const eventsContent = this.emitEventsFile(ir)
        .split("\n")
        .filter((line) =>
          !line.startsWith("//!")
          && !/^use borsh::/.test(line.trim())
          && line.trim() !== "use super::*;"
        )
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
      this._irForAccountEmit = ir;
      sections.push(this.emitAccountStruct(acc));
      this._irForAccountEmit = undefined;
    }

    const helpers = this.emitHelperFunctions(ir);
    if (helpers.trim()) sections.push(helpers);

    // Carry over helper functions from source. Same unsalvageable check as
    // multi-file emit — these helpers can't compile against the target's
    // type system, so emit a comment-out block with a TODO marker instead.
    for (const helper of ir.helperFns) {
      const wrapper = recognizeCpiWrapperHelper(helper.name, helper.signature, helper.body, this.frameworkName);
      if (wrapper) {
        sections.push(`// CPI-wrapper helper — target-typed replacement for source's \`${helper.name}\`\n${wrapper.signature} ${wrapper.body}`);
        continue;
      }
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
    combined = commentOutResidualAnchorLeaks(combined);
    combined = this.applyCpiWrapperCallSiteRewrites(combined);
    return combined;
  }

  // ─── Generic instruction function emitter ──────────────────────────────────

  protected emitInstructionFunction(instr: Instruction, ir: SolanaIR): string {
    // Defect B fix: instructions containing `cpi_custom` (bare `invoke()`
    // calls in source) can't be auto-ported. They typically have a
    // companion `let ix = system_instruction::transfer(...)` pass_through
    // binding that fails to compile on Pinocchio (no `system_instruction`
    // crate) AND a Native over-deref of `.key` (which is a struct field
    // not a method). Emit a stub body instead so the scaffold compiles;
    // the user gets a clear `unimplemented!()` marker with the original
    // source preserved as a comment to manually port.
    const cpiCustomStatements = instr.body.filter((s) => s.kind === "cpi_custom");
    if (cpiCustomStatements.length > 0) {
      return this.emitCpiCustomStubFunction(instr, ir, cpiCustomStatements as Array<{ kind: "cpi_custom"; rawCode: string; programAccount: string }>);
    }
    // #66 — Option<T>-wrapped accounts aren't propagated through the
    // emit surface yet. Stubbing the entire body keeps the scaffold
    // compiling vs. the ~20+ cargo errors a partial emit would yield.
    // The /parse warning (optional_accounts_unsupported) tells the user.
    const optionalAccounts = instr.accounts.filter((a) => a.isOptional);
    if (optionalAccounts.length > 0) {
      return this.emitOptionalAccountsStubFunction(instr, optionalAccounts);
    }
    // #70 — Non-unit Result<T> return types can't change Anvil's uniform
    // router dispatch signature. Stubbing the body avoids E0282 / E0308 at
    // cargo (pass_through carries `Ok(value)` verbatim against our
    // hardcoded -> ProgramResult). User gets unimplemented!() marker with
    // raw source preserved to port manually (e.g. set_return_data per
    // Anchor's macro-expanded pattern).
    const returnType = (instr as any).returnType as string | undefined;
    // Accept "()", "Result<()>", and "anchor_lang::Result<()>" as unit-typed.
    // Anything else (Result<u64>, Result<StructReturn>, Result<Vec<u8>>) is
    // non-unit and can't fit Anvil's uniform router dispatch signature.
    const isUnitResult = !returnType
      || /^\s*\(\s*\)\s*$/.test(returnType)
      || /^\s*(?:anchor_lang::)?Result\s*<\s*\(\s*\)\s*>\s*$/.test(returnType)
      || /^\s*(?:anchor_lang::solana_program::entrypoint::)?ProgramResult\s*$/.test(returnType);
    if (!isUnitResult) {
      return this.emitTypedResultStubFunction(instr, returnType!);
    }
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
    const isInlineMintInit = (a: Instruction["accounts"][number]) =>
      a.constraints.some((c) => c.kind === "mint::decimals" && c.value) &&
      a.constraints.some((c) => c.kind === "mint::authority" && c.value);
    const isInlineAccountInit = (a: Instruction["accounts"][number]) =>
      isInlineAtaInit(a) || isInlineTokenInit(a) || isInlineMintInit(a);
    const initAccountsWithBumps = instr.accounts
      .filter((a) => a.isInit && a.isPda && a.pdaSeeds?.length && (isCustomState(a.accountType) || (a.isPda && a.pdaSeeds?.length)));
    const initPreludes = instr.accounts
      .filter((a) => a.isInit && (isCustomState(a.accountType) || (a.isPda && a.pdaSeeds?.length) || isInlineAccountInit(a)))
      .map((a) => this.emitInitAccountPrelude(a, instr, ir))
      .filter(Boolean)
      .join("\n");
    // task #43 — `#[account(zero)]` constraint. Anchor's macro writes
    // T::DISCRIMINATOR to the first 8 bytes of a zero-initialized account
    // on first access; subsequent `Account::try_accounts` reads only
    // succeed when the disc matches. Without writing it, Anvil's emit
    // produces an .so where the FIRST instruction works (no disc check
    // anywhere) but every SUBSEQUENT instruction that re-reads the
    // account fails with InvalidAccountData (8 zeros ≠ T::DISCRIMINATOR).
    // Surfaced by diff-arc Phase C 2026-05-19 on Anchor's composite example.
    // The write is gated: only fire when the existing 8 bytes are zero,
    // matching Anchor's `#[account(zero)]` precondition that the caller
    // pre-allocates a zero-init buffer.
    // Defect D fix: skip the zero-disc prelude when the body already
    // has a zero_copy_load_init for the same account. The visitor's
    // load_init emits its own borrow + disc write, AND it requires
    // the buffer to be all-zero. If we write the disc as a prelude
    // FIRST, the load_init's zero-check then fires AccountAlreadyInitialized.
    // The prelude was added for non-zero-copy `#[account(zero)]` paths
    // (like Anchor's composite example) where the body uses Account<T>
    // directly without load_init — there the disc write is needed.
    const zeroCopyLoadInitAccounts = new Set<string>();
    for (const stmt of instr.body) {
      if (stmt.kind === "zero_copy_load_init" && stmt.account) {
        zeroCopyLoadInitAccounts.add(stmt.account);
      }
    }
    const zeroPreludes = instr.accounts
      .filter((a) =>
        a.constraints.some((c) => c.kind === "zero")
        && isCustomState(a.accountType)
        && !zeroCopyLoadInitAccounts.has(a.name),
      )
      .map((a) => this.emitZeroAccountPrelude(a, ir))
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
    //
    // Finding #61 — when the body deserializes the same account (via
    // state_read), the realloc must run AFTER the deserialize. On the
    // shrink path the realloc truncates the buffer, and a subsequent
    // T::read against the now-too-small buffer bails with InvalidAccountData.
    // Anchor's lifecycle is: deserialize → realloc → handler-mutates the
    // in-memory struct → re-serialize. We mirror it: prelude-emit only for
    // realloc'd accounts that the body does NOT state_read (e.g. openbook
    // CloseOpenOrdersAccount with realloc::payer = sol_destination but no
    // body read). For the rest, the realloc block is injected AFTER the
    // read line, using the `${name}_account` AccountInfo alias the walker
    // emits at state_read time (the bare `${name}` is shadowed by the
    // deserialized struct at that point).
    // The walker materializes the state_read lazily — sometimes from an
    // explicit `state_read` IR statement, sometimes triggered by
    // `state_field_assign` (Anchor `ctx.accounts.X.field = …` shapes) or by
    // pass_through code that touches `<acc>.<field>`. Detect all three so
    // the deferred-realloc fix covers every shape that ends up emitting the
    // `let mut X = T::read(...)?;` line.
    const stateReadAccountNames = new Set<string>();
    for (const s of instr.body) {
      if (s.kind === "state_read" && s.account) {
        stateReadAccountNames.add(snakeCase(s.account));
      } else if (s.kind === "state_field_assign" && s.account) {
        stateReadAccountNames.add(snakeCase(s.account));
      }
    }
    const reallocAccountsDeferred = new Set<string>();
    const reallocPreludes = instr.accounts
      .map((a) => {
        const hasRealloc = a.constraints.some((c) => c.kind === "realloc");
        if (hasRealloc && stateReadAccountNames.has(snakeCase(a.name))) {
          reallocAccountsDeferred.add(snakeCase(a.name));
          return "";
        }
        return this.emitReallocPrelude(a, instr);
      })
      .filter(Boolean)
      .join("\n");

    // Body emission — the main event
    let rawBodyCode = this.emitBodyStatements(instr.body, instr, ir, preEmittedBumps);
    // Inject deferred realloc blocks AFTER the `T::read(...)` line for each
    // affected account, targeting the `${name}_account` AccountInfo alias.
    if (reallocAccountsDeferred.size > 0) {
      for (const accName of reallocAccountsDeferred) {
        const accountRef = instr.accounts.find((a) => snakeCase(a.name) === accName);
        if (!accountRef) continue;
        const reallocBlock = this.emitReallocPrelude(accountRef, instr, `${accName}_account`);
        if (!reallocBlock) continue;
        // The walker emits the read line as e.g.:
        //   `    let mut message_account = Message::read(&message_account_account.data.borrow())?;`
        // Inject the realloc block immediately after that line. Match any
        // T::read(...)?; suffix and the var name (snake_case) we expect.
        const readLineRe = new RegExp(
          `(^[ \\t]*let (?:mut )?${accName} = [A-Za-z_][A-Za-z0-9_]*::read\\(&${accName}_account\\.data\\.borrow\\(\\)\\)\\?;)`,
          "m",
        );
        if (readLineRe.test(rawBodyCode)) {
          rawBodyCode = rawBodyCode.replace(readLineRe, `$1\n${reallocBlock}`);
        } else {
          // Fallback — read line shape didn't match (e.g. emitStateReadOrInit
          // for init_if_needed). Keep the pre-body emit so behavior is at
          // least no-worse than before the fix.
          this.warnings.push(
            `Instruction '${instr.name}': could not locate the deserialize line for ` +
              `account '${accName}' to inject the realloc block after; falling back to ` +
              `pre-body emit. The shrink path may corrupt deserialization (finding #61).`,
          );
          rawBodyCode = `${this.emitReallocPrelude(accountRef, instr)}\n${rawBodyCode}`;
        }
      }
    }
    // Hook: lets target emitters post-process the assembled body. Preludes
    // (init create_program_account, realloc CPI) are concatenated INTO the
    // string we hand to the post-process so target-specific commentout
    // passes (e.g. Pinocchio's T22 extension call-site commentout) can also
    // strip unresolvable references inside size expressions like
    // `space = ExtraAccountMetaList::size_of(...)`. Without this, prelude-
    // emitted lines bypassed the commentout pass and surfaced cargo errors.
    const preBodyContent = [initPreludes, zeroPreludes, reallocPreludes, rawBodyCode]
      .filter((s) => s && s.length > 0)
      .join("\n");
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
    // postProcessInstructionBody (sibling-state stub path) can append
    // Ok(()) directly into bodyCode after commenting out the user-code
    // section. The IR-level checks above don't see that, so check the
    // rendered text too — avoids the double-Ok(()) parse fail.
    // Match the unit Ok shape `Ok(())` at the trailing edge.
    const renderedHasOkTail = /\bOk\s*\(\s*\(\s*\)\s*\)\s*;?\s*$/.test(bodyCode.trimEnd());
    const needsOkReturn = !bodyHasReturnOk && !bodyHasOkPassThrough && !renderedHasOkTail;

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

  /** Defect B helper — emit a stub function body for instructions containing
   *  cpi_custom statements. Pinocchio doesn't have `system_instruction` or
   *  `invoke()`; Native has them but over-derefs `.key` on AccountInfo.
   *  Both targets get a clean `unimplemented!()` stub so the scaffold
   *  compiles, with the original Anchor source preserved as a comment. */
  private emitCpiCustomStubFunction(
    instr: Instruction,
    _ir: SolanaIR,
    cpiStatements: Array<{ kind: "cpi_custom"; rawCode: string; programAccount: string }>,
  ): string {
    const programs = [...new Set(cpiStatements.map((s) => s.programAccount))].join(", ");
    this.warnings.push(
      `Instruction '${instr.name}' contains cpi_custom CPI(s) to '${programs}' — stubbed as unimplemented!(). Manual port required for ${this.frameworkName}.`,
    );
    const originalLines = cpiStatements
      .map((s) => s.rawCode.split("\n").map((l) => `    // ${l}`).join("\n"))
      .join("\n    //\n");
    return `pub fn ${snakeCase(instr.name)}(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    data: &[u8],
) -> ProgramResult {
    // ${MARKER_ANVIL_PREFIX}: cpi_custom CPI(s) to '${programs}' — manual port required.
    // Anvil can't auto-port bare \`invoke()\` / \`invoke_signed()\` calls:
    //   - Pinocchio uses pinocchio::cpi::* with different ownership semantics
    //   - Native uses solana_program::program::invoke and \`.key\` as a struct field
    // Original (raw) source preserved below for manual reference:
${originalLines}
    let _ = (program_id, accounts, data);
    unimplemented!("Anvil: cpi_custom to '${programs}' in '${instr.name}' — manual port required for ${this.frameworkName}");
}`;
  }

  /**
   * #66 — stub body for instructions with Option<T>-wrapped account
   * fields. The full propagation through CPI helpers, seeds emit, init
   * preludes, .key()/.lamports()/.data_len() call sites, and has_one
   * checks is a multi-day arc; meanwhile the scaffold must still
   * compile. Mirrors emitCpiCustomStubFunction's shape.
   */
  private emitOptionalAccountsStubFunction(
    instr: Instruction,
    optionalAccounts: Instruction["accounts"],
  ): string {
    const fieldList = optionalAccounts.map((a) => a.name).join(", ");
    this.warnings.push(
      `Instruction '${instr.name}' has Option<T>-wrapped account field(s) [${fieldList}] — stubbed as unimplemented!(). Manual port required for ${this.frameworkName}.`,
    );
    const originalLines = (instr.rawBody ?? "")
      .split("\n")
      .map((l) => `    // ${l}`)
      .join("\n");
    return `pub fn ${snakeCase(instr.name)}(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    data: &[u8],
) -> ProgramResult {
    // ${MARKER_ANVIL_PREFIX}: Option<T> optional account field(s) [${fieldList}] — manual port required.
    // Anvil does not yet propagate Option-wrapping through the emit surface
    // (CPI helpers, seeds, init preludes, .key()/.lamports()/.data_len(),
    // has_one). Surfaced as ParserWarning \`optional_accounts_unsupported\`.
    // Original (raw) source preserved below for manual reference:
${originalLines}
    let _ = (program_id, accounts, data);
    unimplemented!("Anvil: Option<T> account field(s) [${fieldList}] in '${instr.name}' — manual port required for ${this.frameworkName}");
}`;
  }

  /**
   * #70 — Emit an unimplemented!() stub for handlers whose source signature
   * is non-unit `Result<T>` (e.g. `Result<u64>`, `Result<StructReturn>`).
   * Anvil's router dispatch uses a uniform `-> ProgramResult` signature so
   * we can't change the handler return type per-instruction. The pass_through
   * body would carry `Ok(value)` verbatim and fail cargo (E0282 type
   * annotations needed / E0308 mismatched types). Stub it instead.
   */
  private emitTypedResultStubFunction(
    instr: Instruction,
    returnType: string,
  ): string {
    this.warnings.push(
      `Instruction '${instr.name}' has non-unit return type 'Result<${returnType}>' — stubbed as unimplemented!(). Anchor expands this to set_return_data + Ok(()); manual port required for ${this.frameworkName}.`,
    );
    const originalLines = (instr.rawBody ?? "")
      .split("\n")
      .map((l) => `    // ${l}`)
      .join("\n");
    return `pub fn ${snakeCase(instr.name)}(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    data: &[u8],
) -> ProgramResult {
    // ${MARKER_ANVIL_PREFIX}: non-unit Result<${returnType}> — manual port required.
    // Anvil's router uses a uniform -> ProgramResult signature; we can't
    // change the return type per-instruction. Anchor's macro expands
    // \`Ok(value)\` to \`set_return_data(&borsh::to_vec(&value)?); Ok(())\`
    // — port that pattern by hand if you need the return data.
    // Original (raw) source preserved below:
${originalLines}
    let _ = (program_id, accounts, data);
    unimplemented!("Anvil: non-unit Result<${returnType}> in '${instr.name}' — port set_return_data pattern manually for ${this.frameworkName}");
}`;
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
      case "f32": case "f64":
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
          // G73 — after the BorshDeserialize binding, also destructure the
          // type's named fields into bare locals. Real-world Anchor
          // instructions (marinade `pub fn process(InitializeData {
          // admin_authority, rewards_fee, .. })`) inline a struct-pattern
          // argument and the carried body then references those bindings
          // bare. Without this destructure, those references fail E0425.
          const accountNames = new Set((this.currentIr?.instructions ?? []).flatMap(ix => ix.accounts.map(a => snakeCase(a.name))));
          const namedFields = (typeDef.fields ?? [])
            .map((f) => snakeCase(f.name))
            .filter((n) => /^[a-z_]\w*$/.test(n));
          if (namedFields.length > 0) {
            // Rename fields that shadow account bindings to avoid [u8; 32]
            // overwriting the AccountInfo variable in scope.
            const fieldEntries = namedFields.map((n) =>
              accountNames.has(n) ? `${n}: __arg_${n}` : n
            );
            const fieldList = fieldEntries.join(", ");
            return `    let ${name}: ${arg.type} = BorshDeserialize::deserialize(&mut remaining)
        .map_err(|_| ProgramError::InvalidInstructionData)?;
    #[allow(unused_variables)]
    let ${arg.type} { ${fieldList}, .. } = ${name}.clone();`;
          }
          return `    let ${name}: ${arg.type} = BorshDeserialize::deserialize(&mut remaining)
        .map_err(|_| ProgramError::InvalidInstructionData)?;`;
        }
        // Loud marker — ⚠️ Anvil TODO is detected by output-validator's
        // checkUnsafeMarkers as an error. The pre-P0.1 emit `// TODO: parse`
        // was stripped by stripLineComments before ERROR_PATTERNS scanned,
        // so the gap was silently shipping a missing arg-deserialization.
        return `    // ${MARKER_ANVIL_TODO_PREFIX} parse ${name}: ${arg.type} — custom-type Borsh deserialization not yet implemented for this arg. Hand-port the deserializer or simplify the arg type.`;
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
    // Escape regex metacharacters in variant names before interpolation —
    // production programs (MarginFi v2 has 416 variants) may include names
    // that don't fit the [A-Za-z_][A-Za-z0-9_]* shape after parser quirks
    // (e.g. duplicate-stripped names, nested types). Without this, a single
    // weird variant crashes the whole emit with "Invalid regular expression".
    const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const recordPrefixes = (text: string | undefined): void => {
      if (!text) return;
      for (const variant of variantNames) {
        // Skip variants that aren't valid Rust identifiers — they can't
        // appear as `Prefix::Variant` in source anyway, so the lookup is
        // a no-op. Catches edge cases the regex would otherwise mishandle.
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(variant)) continue;
        const matches = [...text.matchAll(new RegExp(`\\b([A-Za-z_][A-Za-z0-9_]*)::${escapeRe(variant)}\\b`, "g"))];
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
    // Also scan helper fn bodies — programs commonly factor error returns
    // into helpers like `fn not_burned(check: &Check) -> Result<()> {
    //   if check.burned { return err!(ErrorCode::AlreadyBurned); } }`
    // which the prior code missed, causing the prefix detection to fall
    // back to `${PascalCase(name)}Error` and produce a mismatch between
    // the emitted enum name and the helper's preserved references.
    // Surfaced by cashiers-check (2026-05-12).
    for (const helper of ir.helperFns ?? []) {
      recordPrefixes(helper.rawCode);
      recordPrefixes(helper.body);
    }
    // Scan user trait impl bodies too — same factoring pattern via
    // `impl From<X> for ProgramError` chains uses ErrorCode::Y inline.
    for (const impl of ir.userTraitImpls ?? []) {
      recordPrefixes(impl);
    }
    // Account impl items — programs frequently put validation methods
    // like `impl Game { fn start() { require!(... ErrorCode::X); } }`
    // directly on state structs. After my source-level
    // rewriteAnchorRequireMacros desugars `require!` outside
    // `#[program]` mod, the `ErrorCode::X` reference lives in the
    // accountDef.implItems raw text. Without this scan, the detection
    // falls back to `${PascalCase(ir.name)}Error` and the emit's
    // renamed enum (e.g. AnchorTicTacToeError) won't match the
    // helper-rewritten code's reference (TicTacToeError → undeclared).
    // Caught by arjun-tic-tac-toe.
    for (const account of ir.accounts ?? []) {
      for (const item of account.implItems ?? []) {
        recordPrefixes(item);
      }
    }
    // Custom type impl items — same shape on user-defined enums /
    // structs that carry validation methods.
    for (const typeDef of ir.types ?? []) {
      for (const item of typeDef.implItems ?? []) {
        recordPrefixes(item);
      }
    }

    const ranked = [...prefixes.entries()].sort((a, b) => b[1] - a[1]);
    return ranked[0]?.[0] ?? `${toPascalCase(ir.name)}Error`;
  }

  protected resolveTypeSize(
    typeName: string,
    maxLen?: number[],
    visited = new Set<string>(),
  ): number {
    const fixedArray = parseFixedArrayType(typeName);
    if (fixedArray) {
      const elementSize = this.resolveTypeSize(fixedArray.elementType, undefined, visited);
      const len = resolveConstExprValue(fixedArray.lenExpr, this.currentIr?.constants ?? []);
      if (elementSize > 0 && len !== null) {
        return elementSize * len;
      }
    }

    if (visited.has(typeName)) return 0;
    const typeDef = this.customTypeDef(typeName);
    if (!typeDef) {
      return typeSize(typeName, maxLen);
    }

    if (typeDef.kind === "enum") return 1;
    if (!typeDef.fields) return typeSize(typeName, maxLen);

    visited.add(typeName);
    const size = typeDef.fields.reduce(
      (sum, field) => sum + this.resolveTypeSize(field.type, field.maxLen, visited),
      0,
    );
    visited.delete(typeName);
    return size;
  }

  /**
   * Finding #55 — minimum on-disk size for an account struct. Used by the
   * emitted read()/write() guards when the struct has any String or Vec
   * fields whose actual serialized size depends on content length. The
   * legacy `TOTAL_LEN` constant assumes fixed-size — incorrect for
   * Anchor sources that allocate `required_space(input.len())` at init.
   *
   * MIN_LEN = 8 (discriminator) + sum-over-fields of:
   *   - String / Vec — 4 bytes (just the length prefix; content can be 0)
   *   - everything else — full resolveTypeSize value
   *
   * For all-fixed structs MIN_LEN equals TOTAL_LEN. For variable structs
   * it's the lowest data-size that a syntactically valid account can have.
   */
  protected computeMinLen(acc: AccountDef): number {
    const body = acc.fields.reduce((s, f) => {
      if (f.type === "String" || /^Vec</.test(f.type)) return s + 4;
      return s + this.resolveTypeSize(f.type, f.maxLen);
    }, 0);
    // #60 — disc length is variable when source carries
    // `#[account(discriminator = ...)]`. Default 8 bytes (sha256[..8]).
    const discLen = acc.customDiscriminator?.bytes.length ?? 8;
    return discLen + body;
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
    // G94 attempt dropping user `impl From<X> for ProgramError` caused
    // marinade/pin +78 regression — marinade's user impl supplied a
    // From<MarinadeError> -> ProgramError mapping our auto-emit doesn't
    // replicate. Net negative; defer until per-fixture analysis.
    const filtered = impls.filter((raw) => !/^\s*impl\s+Id\s+for\b/.test(raw));
    if (filtered.length === 0) return "";
    const target = this.frameworkName === "Pinocchio" ? "pin" : "native";
    return filtered
      .map((raw) => commentOutSiblingTraitImpl(raw))
      .map((processed) =>
        rewriteMsgCallsImpl(
          stripAnchorWrappersInCode(stripAnchorLangPrefixes(processed), target),
          (m: string) => this.emitMsg(m),
        ),
      )
      .join("\n\n");
  }

  protected emitCustomTypes(ir: SolanaIR): string {
    return ir.types.map((typeDef) => {
      // Complex enums need rawCode-verbatim emit:
      //   - tuple variants  : `Foo(i32, String)`           → `\\w+\\(...\\)`
      //   - struct variants : `Won { winner: Pubkey }`     → `\\w+\\s*\\{...\\}`
      // Without struct-variant detection, the IR's bare `variants: ["Won"]`
      // would emit `Won = N` losing the inner fields, then any later
      // `GameState::Won { winner }` literal fails E0559 "variant has no
      // field named `winner`". Caught by arjun-tic-tac-toe.
      if (typeDef.rawCode && typeDef.kind === "enum" && /\w+\s*[({]/.test(typeDef.rawCode)) {
        // Complex enums with tuple or struct variants need derive macros so
        // they can be used inside structs that derive BorshSerialize /
        // BorshDeserialize.
        const rawCode = typeDef.rawCode.trim();
        // G51 — alreadyHasDerive check must look for `#[derive(...)]` anywhere
        // in the attribute prelude, not just at byte 0. User code commonly
        // puts `#[repr(u8)]` (or other attrs) BEFORE the derive. Anvil's
        // simple `^#\[derive\(/` check missed this case, prepending our own
        // derive list AND keeping the user's → double derives → conflicting
        // impls of PartialEq / Copy / Borsh* (E0119). Surfaced by kamino's
        // `#[repr(u8)]\n#[derive(PartialEq, ...)] pub enum ConditionType {`.
        const alreadyHasDerive = /#\[derive\(/.test(rawCode.split(/\bpub\b|\benum\b|\bstruct\b/)[0] ?? "");
        // Include Copy when every tuple-variant payload is Copy-safe — i.e.
        // primitives + Pubkey only, no String/Vec/Box/HashMap. Without
        // Copy, `let x = compute(); apply(x); emit!(... x ...)` fails E0382
        // because Anvil's emit drops user-source Copy derives by re-stamping
        // its own derive list.
        const hasNonCopyField = /\b(String|Vec|Box|HashMap|BTreeMap|Rc|Arc)\b/.test(rawCode);
        const copyDerive = hasNonCopyField ? "" : "Copy, ";
        let decl: string;
        if (alreadyHasDerive) {
          // Filter Anchor-specific derives that don't exist on the
          // target. Replace AnchorSerialize→BorshSerialize and
          // AnchorDeserialize→BorshDeserialize since the user's intent
          // is just the trait. Keep FromPrimitive / ToPrimitive
          // (num_derive) verbatim since they're target-compatible
          // when num-derive is in scaffold deps.
          {
            const cfgDerives: string[] = [];
            const STRIP_DERIVES = new Set(["arbitrary::Arbitrary"]);
            const stripped = rawCode.replace(/^\s*#\[cfg_attr\([^,]+,\s*derive\(([^)]+)\)\)\]\s*\n?/gm, (_m, d: string) => {
              for (const t of d.split(",")) {
                let name = t.trim().replace(/^AnchorSerialize$/, "BorshSerialize").replace(/^AnchorDeserialize$/, "BorshDeserialize");
                if (name && !STRIP_DERIVES.has(name)) cfgDerives.push(name);
              }
              return "";
            });
            decl = stripped
              .replace(/\bAnchorSerialize\b/g, "BorshSerialize")
              .replace(/\bAnchorDeserialize\b/g, "BorshDeserialize")
              .replace(/,\s*arbitrary::Arbitrary\b/g, "")
              .replace(/\barbitrary::Arbitrary\s*,?\s*/g, "");
            if (cfgDerives.length > 0) {
              const deriveRe = /#\[derive\(([^)]*)\)\]/;
              const dm = decl.match(deriveRe);
              if (dm) {
                const existing = new Set((dm[1] ?? "").split(/\s*,\s*/).map((t: string) => t.trim()).filter(Boolean));
                for (const d of cfgDerives) existing.add(d);
                decl = decl.replace(deriveRe, `#[derive(${[...existing].join(", ")})]`);
              }
            }
          }
          // Augment user-source derive with `Clone, Debug, PartialEq` when
          // any are missing. Anchor implicitly grants these via its own
          // attribute-macro expansion, so user code can `assert_eq!` / `{:?}`
          // a custom enum without listing them. Anvil strips the Anchor
          // macro and keeps only the literal derive list — so missing traits
          // surface as E0277 / E0369 cargo errors. Dedup against existing
          // traits to avoid E0119 double-derives (kamino's
          // `#[repr(u8)]\n#[derive(PartialEq, ...)]` pattern from G51).
          const requiredTraits = ["Clone", "Debug", "PartialEq"];
          const deriveMatch = decl.match(/#\[derive\(([^)]*)\)\]/);
          if (deriveMatch) {
            const present = new Set(
              (deriveMatch[1] ?? "").split(/\s*,\s*/).map((t) => t.trim()).filter(Boolean),
            );
            const missing = requiredTraits.filter((t) => !present.has(t));
            if (missing.length) {
              decl = decl.replace(
                /#\[derive\(([^)]*)\)\]/,
                (_match, inner) => `#[derive(${inner}, ${missing.join(", ")})]`,
              );
            }
          }
          // G47 — strip `Copy` from derive when any variant contains a
          // mutable reference (`&mut T` or `&'a mut T`). Mutable refs aren't
          // Copy in Rust, so `#[derive(Copy)]` on an enum like `NodeRefMut<'a>
          // { Inner(&'a mut InnerNode), Leaf(&'a mut LeafNode) }` fails
          // E0204. `\b&` doesn't work because `(` (preceding `&`) is non-word
          // — use `&\s*(?:'\w+\s+)?mut\b` without leading word-boundary.
          const hasMutRefInVariants = /&\s*(?:'\w+\s+)?mut\b/.test(decl);
          if (hasMutRefInVariants) {
            decl = decl.replace(/(#\[derive\([^)]*?)\bCopy\s*,\s*/g, "$1");
            decl = decl.replace(/(#\[derive\([^)]*?),\s*Copy\b/g, "$1");
            decl = decl.replace(/#\[derive\(\s*Copy\s*\)\]/g, "");
          }
          // G24 — borsh-derive 1.x requires explicit `#[borsh(use_discriminant
          // = true/false)]` on enums with explicit discriminator values when
          // the BorshSerialize/Deserialize derive is present. Inject the attr
          // after the existing derive line when the enum has `= N` variants
          // and no `#[borsh(...)]` attr already present.
          const hasBorshDerive = /\bBorsh(?:Serialize|Deserialize)\b/.test(decl);
          // G27d — discriminator patterns: decimal (= 0), binary (= 0b001),
          // hex (= 0x1A), and underscore-separated literals (1_000). Drift's
          // OrderParamsBitFlag uses `= 0b00000001` shape.
          const hasExplicitDisc = /\b\w+\s*=\s*(?:0b[01_]+|0o[0-7_]+|0x[0-9a-fA-F_]+|[0-9_]+)\b/.test(decl);
          const hasBorshAttr = /#\[\s*borsh\s*\(/.test(decl);
          if (hasBorshDerive && hasExplicitDisc && !hasBorshAttr) {
            // Insert after first `#[derive(...)]` line. The derive attribute
            // spans up through its matching `)]`.
            decl = decl.replace(
              /^(#\[derive\([^\]]*\)\])\s*\n/m,
              `$1\n#[borsh(use_discriminant = true)]\n`,
            );
          }
        } else {
          // G47 — also strip Copy when re-stamping the derive list, if
          // raw enum body has `&mut` references (NodeRefMut pattern).
          const hasMutRef = /&\s*(?:'\w+\s+)?mut\b/.test(rawCode);
          const effectiveCopy = hasMutRef ? "" : copyDerive;
          decl = `#[derive(Clone, ${effectiveCopy}Debug, PartialEq, BorshSerialize, BorshDeserialize)]\n#[borsh(use_discriminant = true)]\n${rawCode}`;
        }
        return `${decl}${this.emitTypeInherentImpl(typeDef)}`;
      }
      if (typeDef.kind === "enum") {
        const variants = (typeDef.variants ?? []).map((variant, index) => `    ${variant} = ${index},`).join("\n");
        const arms = (typeDef.variants ?? []).map((variant, index) => `            ${index} => Ok(Self::${variant}),`).join("\n");
        // Extract user-source derives so target-compatible ones
        // (FromPrimitive, ToPrimitive from num_derive) survive the
        // re-stamp. Drops Anchor-specific derives (AnchorSerialize /
        // AnchorDeserialize) since neither target ships anchor_lang.
        // Caught by arjun-tic-tac-toe: Sign enum needed FromPrimitive
        // for the carried-source `Sign::from_usize(...)` call.
        const userDerives = extractUserDerives(typeDef.rawCode ?? "");
        const extraDerives = userDerives
          .filter((d) => d === "FromPrimitive" || d === "ToPrimitive")
          .join(", ");
        const extraSuffix = extraDerives ? `, ${extraDerives}` : "";
        return `#[derive(Clone, Copy, Debug, PartialEq, BorshDeserialize, BorshSerialize${extraSuffix})]
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
}${this.emitTypeInherentImpl(typeDef)}`;
      }

      const fields = (typeDef.fields ?? [])
        .map((field) => `    pub ${snakeCase(field.name)}: ${this.rustTypeForCustomType(field.type)},`)
        .join("\n");
      const implBlock = this.emitTypeInherentImpl(typeDef);
      // Preserve `<'info>` / generic params on the struct decl so fields
      // that reference them (e.g. `MarketAccounts<'info>`) compile.
      // G46 tried dropUnusedLifetimes here; works for struct decl but
      // doesn't propagate to USERS of the struct (instruction bodies that
      // pass `PerpMarketMap<'a>` arg → E0107 "struct takes 0 lifetime
      // arguments but 1 supplied"). Until we have a body-rewrite for
      // bare-arg site, leave generics untouched.
      const generics = typeDef.generics ?? "";

      // #27 — standalone `#[zero_copy]` struct: emit Pod-shape so the
      // containing account's bytemuck cast doesn't fail with E0204.
      // Mirrors the AccountDef zero-copy branch in pinocchio-emitter +
      // native-emitter. Skip borsh derives (zero-copy never serializes
      // via borsh) and add #[repr(C)] + Copy/Clone + unsafe Pod/Zeroable.
      // Surfaced by real-world zero-copy fixture (anchor/tests/zero-copy:
      // the `Event` struct is `#[zero_copy]` and used as `events:
      // [Event; 25000]` inside EventQ; without this emit, EventQ's
      // derive(Copy) fails because Event isn't Copy.
      if (typeDef.isZeroCopy) {
        // G72 — preserve `Default`/`Debug` from the source derive line. Real-world
        // zero-copy structs (raydium's `Observation`, `TickState`) call `T::default()`
        // in carried bodies — without preserving Default the call fails E0599.
        const userDerivesZC = extractUserDerives(typeDef.rawCode ?? "");
        const extraZC = userDerivesZC.filter((d) => d === "Default" || d === "Debug").join(", ");
        const extraSuffixZC = extraZC ? `, ${extraZC}` : "";
        return `#[repr(C)]
#[derive(Copy, Clone${extraSuffixZC})]
pub struct ${typeDef.name}${generics} {
${fields}
}

unsafe impl bytemuck::Zeroable for ${typeDef.name} {}
unsafe impl bytemuck::Pod for ${typeDef.name} {}${implBlock}`;
      }

      // G67 — when rawCode declares a tuple struct (`pub struct X(...)`)
      // emit it verbatim. parseCustomType doesn't preserve tuple-struct
      // field shape, so without this passthrough we'd emit an EMPTY
      // braced struct `pub struct X { }` and lose the constructor.
      // Raydium's construct_uint stubs (U128, U256, U512, U1024) all
      // hit this — 80+ tuple-construction call sites failed E0423.
      if (typeDef.rawCode && /\bpub\s+struct\s+\w+\s*\(/.test(typeDef.rawCode)) {
        return `${typeDef.rawCode}${implBlock}`;
      }
      // G46 — when generics declares a lifetime that fields don't use,
      // inject `_phantom_X: core::marker::PhantomData<&'X ()>` to make the
      // lifetime "used". Keeps struct arity unchanged at use sites
      // (avoiding the cascade we saw when trying to DROP the lifetime).
      // Drift's PerpMarketMap<'a> (empty body after wrapper-strip) hits
      // this. Pass ONLY the fields text — the implBlock declares `impl<'a>
      // PerpMarketMap<'a> { ... }` and the regex would falsely conclude
      // 'a is "used" via that declaration. Field-only is the right scope.
      const phantomFields = synthesizePhantomLifetimeFields(generics, fields);
      const allFields = phantomFields ? `${fields}\n${phantomFields}` : fields;
      // G72/G78 — preserve `Default`, `Copy`, and `Eq` from the source derive
      // line. Carried bodies calling `T::default()` need Default; structs
      // used as fields of zero-copy parent structs need Copy; HashMap keys etc
      // need Eq. The auto-emitted derive list shadows the source's so without
      // explicit preservation user code that depended on these derives fails.
      const userDerivesStruct = extractUserDerives(typeDef.rawCode ?? "");
      const extras: string[] = [];
      if (userDerivesStruct.includes("Copy")) extras.push("Copy");
      if (userDerivesStruct.includes("Default")) extras.push("Default");
      if (userDerivesStruct.includes("Eq")) extras.push("Eq");
      const extraSuffix = extras.length ? `, ${extras.join(", ")}` : "";
      return `#[derive(Clone, Debug, PartialEq, BorshDeserialize, BorshSerialize${extraSuffix})]
pub struct ${typeDef.name}${generics} {
${allFields}
}${implBlock}`;
    }).join("\n\n");
  }

  /** Append `impl <ThisType> { ...rawItems }` for user-authored helpers like
   * `Ride::new(...)` constructors. Mirrors the AccountDef-side
   * emitInherentImplItems hook in the target emitters.
   *
   * Auto-synthesizes `pub const INIT_SPACE: usize = <bytes>` when the type's
   * fields are all fully-sized primitives + Pubkey + nested fixed structs.
   * Anchor's `#[derive(InitSpace)]` macro generates this constant for the
   * source program (called via `Member::INIT_SPACE` in `Multisig::size(n)` etc.);
   * the emitted code references it without it being defined → E0599. We don't
   * track derive lists in the IR yet, so the heuristic is "if every field
   * resolves to a known fixed size, emit the constant." Dynamic types
   * (Vec<T> without #[max_len], String) yield 0/unknown via resolveTypeSize
   * and we suppress the constant in that case.
   */
  protected emitTypeInherentImpl(typeDef: TypeDef): string {
    const gen = typeDef.generics ?? "";
    const userItems = (typeDef.implItems ?? []).map((s) => `    ${s}`);

    // Skip INIT_SPACE for enum-shaped or empty typedefs, and when generics are
    // present (the size depends on the unbound parameters).
    let initSpaceLine: string | null = null;
    if (typeDef.kind !== "enum" && typeDef.fields && typeDef.fields.length > 0 && !gen) {
      const total = typeDef.fields.reduce((sum, f) => sum + this.resolveTypeSize(f.type, f.maxLen), 0);
      if (total > 0) {
        initSpaceLine = `    pub const INIT_SPACE: usize = ${total};`;
      }
    }

    const items: string[] = [];
    if (initSpaceLine) items.push(initSpaceLine);
    // Stub user impl methods that reference Anchor-only patterns (CpiContext,
    // ctx.accounts/ctx.bumps, require!/require_keys_eq!/require_keys_neq!,
    // anchor_lang prelude items). These methods can't compile in pinocchio/
    // native target — replace the body with a compile-clean TODO stub that
    // returns a generic error. Same fallback shape as the unsalvageable-helper
    // commentout pass but applied at the impl-item level.
    // G68 — collapseModulePaths needs known names; pull from
    // _irForAccountEmit (set in emitAccountStructsFile* paths) or from
    // this.currentIr. emitTypeInherentImpl is also called from type
    // emit paths that may not have set _irForAccountEmit, so fall back
    // to a no-op when neither is available (preserves correctness).
    const irForCollapse = this._irForAccountEmit ?? this.currentIr;
    const knownNamesG68 = irForCollapse ? this.collectKnownTopLevelNames(irForCollapse) : new Set<string>();
    for (const raw of (typeDef.implItems ?? [])) {
      let stubbed = rewriteRequireVariantsInCode(
        rewriteMsgCallsImpl(
          stripAnchorWrappersInCode(
            stripAnchorLangPrefixes(
              rewriteGetInstancePackedLen(rewriteAnchorResultAlias(rewriteTryIntoUnwrap(stubAnchorOnlyImplItem(raw)))),
            ),
            this.frameworkName === "Pinocchio" ? "pin" : "native",
          ),
          (m: string) => this.emitMsg(m),
        ),
      );
      // G68 — collapseModulePaths so refs like `tick_math::MIN_TICK`
      // (where MIN_TICK is a flattened constant at crate root) become
      // bare `MIN_TICK`. Mirrors G45 for account impl items.
      if (knownNamesG68.size > 0) {
        stubbed = collapseModulePaths(stubbed, knownNamesG68);
      }
      items.push(`    ${stubbed}`);
    }
    if (items.length === 0) return "";
    // G22 — for impl block, the impl declaration carries bounds verbatim
    // (`<'a, 'info: 'a>` or `<T: Trait>`), but the type instantiation
    // must use bare param names (`<'a, 'info>` or `<T>`). Openbook-v2's
    //   impl<'a, 'info: 'a> AccountInfoRef<'a, 'info: 'a> { … }
    // bug came from re-using gen on both sides. Strip bounds for the
    // type-side; keep bounds on the impl side.
    const typeGen = stripGenericBounds(gen);
    return `\n\nimpl${gen} ${typeDef.name}${typeGen} {\n${items.join("\n\n")}\n}`;
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

  /**
   * #60 — Per-account discriminator emit info. When the source carried
   * `#[account(discriminator = ...)]` with a resolvable RHS, the parser
   * populates `acc.customDiscriminator.bytes`; here we surface (len, expr)
   * so the read/write/init paths emit `[u8; N] = [N, ...]` and `[..N]`
   * slicing instead of the default sha256 8-byte shape. Absent →
   * legacy 8-byte path unchanged (so existing snapshots stay byte-equal).
   */
  protected accountDiscInfo(acc: { name: string; customDiscriminator?: { bytes: number[] } }): { len: number; expr: string } {
    if (acc.customDiscriminator) {
      const bytes = acc.customDiscriminator.bytes;
      return { len: bytes.length, expr: `[${bytes.join(", ")}]` };
    }
    return { len: 8, expr: this.accountDiscriminatorExpr(acc.name) };
  }

  /** #60 — Per-event discriminator emit info. Same shape as account. */
  protected eventDiscInfo(ev: { name: string; customDiscriminator?: { bytes: number[] } }): { len: number; expr: string } {
    if (ev.customDiscriminator) {
      const bytes = ev.customDiscriminator.bytes;
      return { len: bytes.length, expr: `[${bytes.join(", ")}]` };
    }
    return { len: 8, expr: eventDiscriminator(ev.name) };
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
      return `        let ${fieldName}: ${typeName} = __data_buf[offset..offset + ${size}]
            .try_into().map_err(|_| ProgramError::InvalidAccountData)?;
        offset += ${size};`;
    }
    if (fixedArray || typeDef?.kind === "struct") {
      return `        let mut ${fieldName}_bytes = &__data_buf[offset..offset + ${size}];
        let ${fieldName}: ${typeName} = BorshDeserialize::deserialize(&mut ${fieldName}_bytes)
            .map_err(|_| ProgramError::InvalidAccountData)?;
        offset += ${size};`;
    }
    if (typeDef?.kind === "enum") {
      // Complex enums (tuple OR struct variants) can't be encoded in a
      // single byte — their size depends on which variant is active.
      // For these, fall through to Borsh's variable-length deserialize:
      // it reads the variant discriminator, dispatches to the payload
      // decode, and advances the cursor by exactly the consumed bytes.
      // Caught by arjun-tic-tac-toe: `state: GameState` where GameState
      // has a `Won { winner: Pubkey }` struct variant; the previous
      // try_from(u8) emit failed `the trait bound GameState: TryFrom<u8>`.
      const isComplexEnum = !!typeDef.rawCode && /\w+\s*[({]/.test(typeDef.rawCode);
      if (isComplexEnum) {
        return `        let mut ${fieldName}_bytes = &__data_buf[offset..];
        let ${fieldName}: ${typeName} = BorshDeserialize::deserialize(&mut ${fieldName}_bytes)
            .map_err(|_| ProgramError::InvalidAccountData)?;
        offset = __data_buf.len() - ${fieldName}_bytes.len();`;
      }
      return `        let ${fieldName}: ${typeName} = ${typeName}::try_from(__data_buf[offset])
            .map_err(|_| ProgramError::InvalidAccountData)?;
        offset += 1;`;
    }
    if (typeName === "bool") {
      return `        let ${fieldName}: bool = match __data_buf[offset] {
            0 => false,
            1 => true,
            _ => return Err(ProgramError::InvalidAccountData),
        };
        offset += 1;`;
    }
    if (typeName === "u8") {
      return `        let ${fieldName}: u8 = __data_buf[offset];
        offset += 1;`;
    }
    if (typeName === "i8") {
      return `        let ${fieldName}: i8 = __data_buf[offset] as i8;
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
      return `        let mut ${fieldName}_bytes: &[u8] = &__data_buf[offset..];
        let __${fieldName}_before = ${fieldName}_bytes.len();
        let ${fieldName}: ${typeName} = BorshDeserialize::deserialize(&mut ${fieldName}_bytes)
            .map_err(|_| ProgramError::InvalidAccountData)?;
        offset += __${fieldName}_before - ${fieldName}_bytes.len();`;
    }
    return `        let ${fieldName}: ${typeName} = ${typeName}::from_le_bytes(
            __data_buf[offset..offset + ${size}].try_into().map_err(|_| ProgramError::InvalidAccountData)?
        );
        offset += ${size};`;
  }

  protected buildWriteLine(typeName: string, fieldName: string): string {
    const size = this.resolveTypeSize(typeName);
    const typeDef = this.customTypeDef(typeName);
    const fixedArray = parseFixedArrayType(typeName);

    if (typeName === "Pubkey" || /^\[\s*u8\s*;\s*\d+\s*\]$/.test(typeName)) {
      return `        __data_buf[offset..offset + ${size}].copy_from_slice(&value.${fieldName}${this.emitPubkeyFieldAsRef()});
        offset += ${size};`;
    }
    if (fixedArray || typeDef?.kind === "struct") {
      return `        {
            let mut ${fieldName}_bytes = &mut __data_buf[offset..offset + ${size}];
            BorshSerialize::serialize(&value.${fieldName}, &mut ${fieldName}_bytes)
                .map_err(|_| ProgramError::InvalidAccountData)?;
        }
        offset += ${size};`;
    }
    if (typeDef?.kind === "enum") {
      // Mirror the decode side: complex enums (tuple / struct variants)
      // can't `as u8` cast — Rust rejects with "an `as` expression can
      // be used to convert enum types to numeric types only if the
      // enum type is unit-only or field-less". Borsh-serialize the
      // whole field and advance the cursor by the actual byte count.
      const isComplexEnum = !!typeDef.rawCode && /\w+\s*[({]/.test(typeDef.rawCode);
      if (isComplexEnum) {
        return `        let __${fieldName}_serialized = ::borsh::to_vec(&value.${fieldName})
            .map_err(|_| ProgramError::InvalidAccountData)?;
        __data_buf[offset..offset + __${fieldName}_serialized.len()].copy_from_slice(&__${fieldName}_serialized);
        offset += __${fieldName}_serialized.len();`;
      }
      return `        __data_buf[offset] = value.${fieldName} as u8;
        offset += 1;`;
    }
    if (typeName === "bool") {
      return `        __data_buf[offset] = if value.${fieldName} { 1 } else { 0 };
        offset += 1;`;
    }
    if (typeName === "u8" || typeName === "i8") {
      return `        __data_buf[offset] = value.${fieldName} as u8;
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
        __data_buf[offset..offset + __${fieldName}_serialized.len()].copy_from_slice(&__${fieldName}_serialized);
        offset += __${fieldName}_serialized.len();`;
    }
    return `        __data_buf[offset..offset + ${size}].copy_from_slice(&value.${fieldName}.to_le_bytes());
        offset += ${size};`;
  }

  /**
   * How to deserialize a Pubkey at the current `offset` in a read() body.
   * Pinocchio overrides to return the raw array (since Pubkey IS [u8;32]).
   * Native keeps it as Pubkey::new_from_array(...).
   */
  protected emitPubkeyFieldRead(_size: number): string {
    return `__data_buf[offset..offset + 32].try_into().map_err(|_| ProgramError::InvalidAccountData)?`;
  }

  /**
   * Whether a Pubkey field value needs `.as_ref()` to get &[u8] for copy_from_slice.
   * Returns "" for Pinocchio ([u8;32] IS already a byte array),
   * returns ".as_ref()" for frameworks where Pubkey wraps [u8;32].
   */
  protected emitPubkeyFieldAsRef(): string {
    return "";
  }

  protected emitT22ExtensionInits(
    accountRef: { constraints: Array<{ kind: string; value?: string }> },
    accountName: string,
    tokenProgram?: string,
  ): string {
    const parts: string[] = [];
    const constraints = accountRef.constraints;
    const findVal = (kind: string) => constraints.find((c) => c.kind === kind)?.value;
    const tp = tokenProgram ?? "token_program";
    const resolve = (v: string) => v.includes("::") ? v.trim() : snakeCase(v);

    const closeAuth = findVal("extensions::close_authority::authority");
    if (closeAuth !== undefined) {
      parts.push(this.emitT22MintCloseAuthorityInitialize(accountName, tp, resolve(closeAuth)));
    }
    const permDelegate = findVal("extensions::permanent_delegate::delegate");
    if (permDelegate !== undefined) {
      parts.push(this.emitT22PermanentDelegateInitialize(accountName, tp, resolve(permDelegate)));
    }
    const nonTransferable = constraints.some((c) => c.kind === "extensions::non_transferable");
    if (nonTransferable) {
      parts.push(this.emitT22NonTransferableMintInitialize(
        accountName, tp));
    }
    const defaultState = findVal("extensions::default_account_state::state");
    if (defaultState !== undefined) {
      parts.push(this.emitT22DefaultAccountStateInitialize(
        accountName, tp, defaultState.trim()));
    }
    const interestRate = findVal("extensions::interest_bearing::rate");
    if (interestRate !== undefined) {
      parts.push(this.emitT22InterestBearingMintInitialize(
        accountName, tp, resolve(findVal("extensions::interest_bearing::rate_authority") ?? "payer"), interestRate.trim()));
    }
    const tfcAuth = findVal("extensions::transfer_fee::transfer_fee_config_authority");
    const wwhAuth = findVal("extensions::transfer_fee::withdraw_withheld_authority");
    if (tfcAuth !== undefined && wwhAuth !== undefined) {
      const basisPoints = findVal("extensions::transfer_fee::transfer_fee_basis_points") ?? "0";
      const maxFee = findVal("extensions::transfer_fee::maximum_fee") ?? "0";
      parts.push(this.emitT22TransferFeeInitialize(
        accountName, tp, resolve(tfcAuth), resolve(wwhAuth), basisPoints.trim(), maxFee.trim()));
    }
    const thAuth = findVal("extensions::transfer_hook::authority");
    const thPid = findVal("extensions::transfer_hook::program_id");
    if (thAuth !== undefined) {
      parts.push(this.emitT22TransferHookInitialize(
        accountName, tp, resolve(thAuth), thPid ? resolve(thPid) : accountName));
    }
    const mpAuth = findVal("extensions::metadata_pointer::authority");
    const mpAddr = findVal("extensions::metadata_pointer::metadata_address");
    if (mpAuth !== undefined) {
      parts.push(this.emitT22MetadataPointerInitialize(
        accountName, tp, resolve(mpAuth), mpAddr ? resolve(mpAddr) : accountName));
    }
    const gpAuth = findVal("extensions::group_pointer::authority");
    const gpAddr = findVal("extensions::group_pointer::group_address");
    if (gpAuth !== undefined) {
      parts.push(this.emitT22GroupPointerInitialize(
        accountName, tp, resolve(gpAuth), gpAddr ? resolve(gpAddr) : accountName));
    }
    return parts.length > 0 ? "\n" + parts.join("\n") : "";
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

    // ── `init mint::*` (Mint creation): SystemProgram::CreateAccount
    // (82 bytes, owner=token program) + Token::InitializeMint2. AMM's
    // lp_mint is the canonical fresh-keypair shape; PDA-mints are
    // possible (some governance programs) and routed through the same
    // signer-seeds threading as the TokenAccount branch below.
    const mintDecimalsConstraint = accountRef.constraints.find((c) => c.kind === "mint::decimals" && c.value);
    const mintAuthorityConstraint = accountRef.constraints.find((c) => c.kind === "mint::authority" && c.value);
    const mintFreezeConstraint = accountRef.constraints.find((c) => c.kind === "mint::freeze_authority" && c.value);
    if (mintDecimalsConstraint?.value && mintAuthorityConstraint?.value) {
      const decimals = mintDecimalsConstraint.value.trim();
      // emitCreateMint expects an AccountInfo BINDING name and synthesises
      // `${binding}.key().as_ref()` itself. The source value can be either:
      //   `mint::authority = payer`       → binding name (correct shape)
      //   `mint::authority = payer.key()` → expression yielding a Pubkey
      // Without stripping the trailing `.key()`/`.key`, the emit produces
      // `payer.key().key().as_ref()` and cargo refuses with E0599 (no
      // .key on &[u8; 32]). Strip the suffix so both shapes converge.
      // Surfaced by spl-token-minter (real-world, #33 follow-up, task #34).
      const stripKey = (raw: string): string =>
        snakeCase(raw.trim().replace(/\.\s*key\s*\(\s*\)\s*$/, "").replace(/\.\s*key\s*$/, "").trim());
      const mintAuthority = stripKey(mintAuthorityConstraint.value);
      const freezeAuthority = mintFreezeConstraint?.value ? stripKey(mintFreezeConstraint.value) : null;
      const payer = payerName ?? "payer";

      // Find the runtime token_program sibling in the Accounts struct. When
      // present, the mint init reads the program ID from this AccountInfo
      // instead of hardcoding legacy SPL Token — necessary for source shapes
      // like `Interface<'info, TokenInterface>` where the CALLER chooses
      // Token vs Token-2022 at runtime. Detection: name is `token_program`
      // OR accountType references TokenInterface / Token2022 / Token.
      // Surfaced by program-examples/tokens/token-2022/basics — the source
      // declares `token_program: Interface<'info, TokenInterface>`, and a
      // T22 fixture was failing with "An account required by the
      // instruction is missing" because Anvil hardcoded the legacy ID.
      const tokenProgramSibling = instr.accounts.find((a) => {
        const n = snakeCase(a.name);
        if (n === "token_program") return true;
        const t = a.accountType ?? "";
        return /\b(?:TokenInterface|Token2022|TokenAccount|Token)\b/.test(t) && /^(Interface|Program)\b/.test(t.trim());
      });
      const tokenProgram = tokenProgramSibling ? snakeCase(tokenProgramSibling.name) : undefined;

      const extSpace = computeT22ExtensionSpace(accountRef.constraints);
      const totalSpace = extSpace > 0 ? 82 + 83 + extSpace : undefined;

      if (accountRef.isPda && accountRef.pdaSeeds?.length) {
        const pdaSeeds = accountRef.pdaSeeds.map((seed) => this.normalizeInitSeedExpr(seed));
        const bumpPrelude = this.emitBumpSeed("program_id", pdaSeeds, accountName)
          .replace(/\blet bump =/g, `let bump_${accountName} =`)
          .replace(/\blet\s+\(expected_key,\s*bump\)\s*=/g, `let (expected_key, bump_${accountName}) =`);
        const seedsPrelude = `    let init_${accountName}_seeds: &[&[u8]] = &[
            ${[...pdaSeeds, `&[bump_${accountName}]`].join(",\n            ")},
        ];
    let init_${accountName}_signer_seeds = &[&init_${accountName}_seeds[..]];`;
        const signerSeedsExpr = `init_${accountName}_signer_seeds`;
        const mintCreate = this.emitCreateMint(accountName, payer, decimals, mintAuthority, freezeAuthority, signerSeedsExpr, tokenProgram, totalSpace);
        return `${bumpPrelude}\n${seedsPrelude}\n${mintCreate}`;
      }

      return this.emitCreateMint(accountName, payer, decimals, mintAuthority, freezeAuthority, undefined, tokenProgram, totalSpace);
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
      // task #45 — state-field references inside seeds expressions
      // (e.g. `seeds = [base.base_data.to_le_bytes().as_ref()]`). Without
      // deserializing the account first, `base.base_data` resolves to
      // `<AccountInfo>.base_data` which doesn't exist. Detect each
      // `<state-account>.<field>` reference, emit a state-load preamble,
      // and rewrite the seed expression to use the deserialized local.
      // Mirror of body-walker's normalizeSeedExpr account-field rewrite
      // (which only runs at body-bump time, not at init-prelude time).
      const stateFieldPreloads: string[] = [];
      const loadedStateAccounts = new Set<string>();
      const rawSeeds = accountRef.pdaSeeds ?? [`b"${accountName}"`];
      const rewrittenSeeds = rawSeeds.map((seed) => {
        let s = seed;
        for (const acc of instr.accounts) {
          if (acc.name === accountRef.name) continue;
          const stateTypeDef = ir.accounts.find((a) => a.name === acc.accountType);
          if (!stateTypeDef) continue;
          const accName = snakeCase(acc.name);
          const stateVar = `${accName}_state`;
          const re = new RegExp(`\\b${accName}\\.(\\w+)`, "g");
          const replaced = s.replace(re, (full, field: string) => {
            if (field === "key" || field === "lamports") return full;
            // Only rewrite if the field exists on the state def. Fall
            // through to original text otherwise so emit doesn't grab
            // method calls / nested expressions.
            const hasField = stateTypeDef.fields.some((f: { name: string }) => f.name === field);
            if (!hasField) return full;
            if (!loadedStateAccounts.has(accName)) {
              loadedStateAccounts.add(accName);
              stateFieldPreloads.push(
                `    let ${stateVar} = ${stateTypeDef.name}::from_account_info(${accName})?;`,
              );
            }
            return `${stateVar}.${field}`;
          });
          s = replaced;
        }
        return s;
      });
      const pdaSeeds = rewrittenSeeds.map((seed) => this.normalizeInitSeedExpr(seed));
      if (stateFieldPreloads.length > 0) {
        bumpPrelude = stateFieldPreloads.join("\n") + "\n";
      }
      bumpPrelude += this.emitBumpSeed(
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

    // Anvil's emitted state structs define LEN = body-only (no
    // discriminator) and TOTAL_LEN = 8 + LEN. Anchor sources fall in
    // one of two conventions:
    //   (a) `pub const LEN = 8 + ...; space = Type::LEN`
    //       → source LEN includes disc; `space = Type::LEN` is the full
    //       allocation. Anvil's `Type::LEN` is body-only so it under-
    //       allocates. Rewrite to `Type::TOTAL_LEN`.
    //   (b) `pub const LEN = ...; space = 8 + Type::LEN`  (or `INIT_SPACE`)
    //       → source LEN is body-only, allocation is 8 + LEN. Anvil's
    //       `Type::LEN` matches semantically; leave alone.
    // Heuristic: rewrite only when initSpace is exactly `Type::LEN`
    // (optionally wrapped/cast) with no leading `8 +`. Matches (a),
    // skips (b).
    const rawSpace = (accountRef.initSpace ?? "").trim();
    const initSpaceExpr = (() => {
      // (a) `space = Type::LEN` → rewrite to Type::TOTAL_LEN (8 + body).
      if (/^[A-Z][A-Za-z0-9_]*::LEN$/.test(rawSpace)) {
        return rawSpace.replace(/::LEN$/, "::TOTAL_LEN");
      }
      // (c) `space = Type::INIT_SPACE` (no leading `8 +`) — Anchor 0.30+
      // convention where INIT_SPACE *includes* the discriminator. Anvil's
      // emitted INIT_SPACE const is body-only, so we add the 8 explicitly.
      // Surfaced by close-account (program-examples): source writes
      // `space = UserState::INIT_SPACE`; without this Anvil under-allocates
      // by 8 bytes and create_user reverts with InvalidAccountData.
      if (/^[A-Z][A-Za-z0-9_]*::INIT_SPACE$/.test(rawSpace)) {
        return `8 + ${rawSpace}`;
      }
      // (b) Any explicit form (`8 + Type::INIT_SPACE`, `ANCHOR_DISC + ...`,
      // numeric, etc.) — assume user already accounted for the disc. Leave
      // as-is.
      return rawSpace;
    })();
    const createCall = this.emitCreateProgramAccount(
      accountName,
      payerName,
      initSpaceExpr,
      signerSeedsExpr,
    );

    // Anchor's `#[account]` macro writes an 8-byte discriminator to the
    // freshly-created account immediately after the system::create_account
    // CPI. The discriminator IS the value our emitted `T::DISCRIMINATOR`
    // constant in state.rs. Without writing it here, any later instruction
    // that calls `T::from_account_info(account)` fails with
    // InvalidAccountData (disc mismatch). Surfaced by counter-pe/cpi-lever
    // byte-divergence in Phase 2 v7: init succeeded but the next ix
    // (increment) couldn't deserialize. Only applies when the account
    // type is a user-defined state struct (Account<'info, T>) — Mint /
    // TokenAccount / ATA use SPL layouts and are excluded.
    let discriminatorWrite = "";
    const stateType = ir.accounts.find((a) => a.name === accountRef.accountType);
    if (stateType) {
      const discLen = stateType.customDiscriminator?.bytes.length ?? 8;
      discriminatorWrite = this.emitDiscriminatorWrite(accountName, stateType.name, discLen);
    }

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
      const inner = [seedsPrelude, createCall, discriminatorWrite].filter(Boolean).join("\n");
      // Indent body so the emitted block stays readable.
      const indented = inner.replace(/^/gm, "    ");
      const block = `    // init_if_needed: only allocate when the account is empty.
    if ${accountName}.data_is_empty() {
${indented}
    }`;
      return [bumpPrelude, block].filter(Boolean).join("\n");
    }

    return [bumpPrelude, seedsPrelude, createCall, discriminatorWrite].filter(Boolean).join("\n");
  }

  /**
   * task #43 — emit prelude for `#[account(zero)]`.
   *
   * Anchor's `#[account(zero)]` constraint asserts the caller has
   * pre-allocated an account whose data buffer is currently zero-init.
   * Anchor's macro writes T::DISCRIMINATOR into the first 8 bytes on
   * first access (Account::try_accounts → AccountSerialize::try_serialize).
   * Without writing it, subsequent calls that read the account through
   * `T::from_account_info` fail with InvalidAccountData (the 8-zero
   * prefix doesn't match T::DISCRIMINATOR).
   *
   * Anvil's emit was missing this write — surfaced by diff-arc Phase C
   * 2026-05-19 on Anchor's composite example: initialize() succeeded on
   * both Anchor and Anvil sides but with different post-state bytes
   * (Anchor wrote the disc, Anvil didn't); composite_update then failed
   * on Anvil with "invalid account data". This method closes that gap.
   *
   * Gated: only fires when the existing 8 bytes are all zero, matching
   * the constraint's precondition. If a non-zero disc is already there,
   * the account was previously initialized — leave it alone.
   */
  protected emitZeroAccountPrelude(
    accountRef: Instruction["accounts"][number],
    ir: SolanaIR,
  ): string {
    const accountName = snakeCase(accountRef.name);
    const stateType = ir.accounts.find((a) => a.name === accountRef.accountType);
    if (!stateType) return "";
    const discLen = stateType.customDiscriminator?.bytes.length ?? 8;
    return this.emitZeroAccountDiscriminatorWrite(accountName, stateType.name, discLen);
  }

  /**
   * Framework-specific: write Type::DISCRIMINATOR into the first 8 bytes
   * of `accountName` IF currently zero. Pinocchio uses borrow_mut_data_unchecked;
   * Native uses account.data.borrow_mut(). Re-uses the existing
   * emitDiscriminatorWrite implementation with a wrapping if-zero guard.
   */
  abstract emitZeroAccountDiscriminatorWrite(accountName: string, typeName: string, discLen?: number): string;

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
    /**
     * Override the identifier used to refer to the AccountInfo. The default
     * is `snakeCase(accountRef.name)` — correct when this emits as a pre-body
     * prelude. For the deferred-injection case (finding #61), the bare
     * `${name}` is shadowed by the deserialized struct after state_read; the
     * walker exposes the AccountInfo via `${name}_account`, so callers pass
     * that here.
     */
    accountInfoNameOverride?: string,
  ): string {
    const reallocConstraint = accountRef.constraints.find((c) => c.kind === "realloc");
    if (!reallocConstraint?.value) return "";
    const accountName = accountInfoNameOverride ?? snakeCase(accountRef.name);
    // In the deferred-injection case the body has already deserialized any
    // state account, so `<name>.<field>` expressions resolve directly to the
    // shadowed struct — no need (and incorrect) to predeserialize again. The
    // override flag also signals that the field-pattern check should run
    // against the original account name, not the `${name}_account` alias.
    const isDeferredInjection = accountInfoNameOverride !== undefined;
    const sizeExpr = reallocConstraint.value;

    // Native path — real realloc + rent top-up. Respect the explicit
    // `realloc::payer = <account>` constraint first; fall back to the
    // first mut Signer (Anchor's default).
    // G91 — openbook's CloseOpenOrdersAccount has `realloc::payer =
    // sol_destination` (UncheckedAccount, not Signer); without honoring
    // the explicit constraint we emitted a bare `payer` identifier that
    // failed E0425 at every realloc call site.
    const reallocPayerConstraint = accountRef.constraints.find((c) => c.kind === "realloc::payer");
    let payer: string;
    if (reallocPayerConstraint?.value) {
      payer = snakeCase(reallocPayerConstraint.value.trim());
    } else {
      const payerAcc = instr.accounts.find((a) => a.isSigner && a.isMut);
      payer = payerAcc ? snakeCase(payerAcc.name) : "payer";
    }

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
    if (!isDeferredInjection && referencedStateAccounts.length > 0) {
      const lines: string[] = [];
      for (const { name, type } of referencedStateAccounts) {
        const localVar = `__${name}_for_realloc`;
        lines.push(`        let ${localVar} = ${type}::from_account_info(${name})?;`);
        // Rewrite `<name>.<field>` → `<localVar>.<field>` in the size expr.
        resolvedSizeExpr = resolvedSizeExpr.replace(accountFieldPattern(name), `${localVar}.$1`);
      }
      predeserialize = lines.join("\n") + "\n";
    }

    // Finding #56 — Anchor's `realloc::zero = <bool>` flag controls
    // whether the newly-grown region is zero-filled. Pre-fix Anvil
    // hardcoded `false` regardless of source. Now we read the constraint
    // value; default to `false` matches Anchor's default when omitted.
    const reallocZeroConstraint = accountRef.constraints.find(
      (c) => c.kind === "realloc::zero",
    );
    const reallocZero =
      reallocZeroConstraint?.value?.trim().toLowerCase() === "true";
    const zeroFlag = reallocZero ? "true" : "false";

    if (this.frameworkName === "Native") {
      // Anchor's realloc constraint covers BOTH directions:
      //   grow:   system_program::transfer(payer → account, delta)
      //   shrink: direct lamport mutation (account → payer, delta)
      // The system_program transfer path can't service the shrink direction —
      // system_program won't sign for transfers out of a program-owned
      // account. The post-init account is owned by `program_id`, so direct
      // lamport mutation is the allowed path (idiomatic raw-Solana). Without
      // the shrink branch the account retained the pre-shrink rent balance,
      // breaking byte-equal on lamports (delta = old_rent - new_rent).
      return `    // realloc — resize ${accountName} to ${sizeExpr} (zero=${zeroFlag})
    {
${predeserialize}        let __new_size = (${resolvedSizeExpr}) as usize;
        let __rent = solana_program::sysvar::rent::Rent::get()?;
        let __new_lamports = __rent.minimum_balance(__new_size);
        let __cur_lamports = ${accountName}.lamports();
        if __new_lamports > __cur_lamports {
            let __delta = __new_lamports - __cur_lamports;
            let __ix = solana_program::system_instruction::transfer(
                ${payer}.key,
                ${accountName}.key,
                __delta,
            );
            solana_program::program::invoke(
                &__ix,
                &[${payer}.clone(), ${accountName}.clone()],
            )?;
        } else if __new_lamports < __cur_lamports {
            let __refund = __cur_lamports - __new_lamports;
            **${accountName}.lamports.borrow_mut() = __cur_lamports - __refund;
            **${payer}.lamports.borrow_mut() = ${payer}.lamports() + __refund;
        }
        ${accountName}.realloc(__new_size, ${zeroFlag})?;
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
      //
      // Shrink branch mirrors Native: direct lamport mutation (account →
      // payer, delta). Pinocchio's `try_borrow_mut_lamports()` returns a
      // RefMut<u64>; deref-assign performs the lamport delta.
      return `    // realloc — resize ${accountName} to ${sizeExpr} (zero=${zeroFlag})
    {
${predeserialize}        let __new_size = (${resolvedSizeExpr}) as usize;
        let __rent = pinocchio::sysvars::rent::Rent::get()?;
        let __new_lamports = __rent.minimum_balance(__new_size);
        let __cur_lamports = ${accountName}.lamports();
        if __new_lamports > __cur_lamports {
            let __delta = __new_lamports - __cur_lamports;
            pinocchio_system::instructions::Transfer {
                from: ${payer},
                to: ${accountName},
                lamports: __delta,
            }.invoke()?;
        } else if __new_lamports < __cur_lamports {
            let __refund = __cur_lamports - __new_lamports;
            *${accountName}.try_borrow_mut_lamports()? = __cur_lamports - __refund;
            *${payer}.try_borrow_mut_lamports()? = ${payer}.lamports() + __refund;
        }
        ${accountName}.realloc(__new_size, ${zeroFlag})?;
    }`;
    }

    // Both supported frameworks return above; the fallthrough was historically
    // for Quasar, which has been removed. Surface as an explicit assertion in
    // case a new framework is added later without updating the realloc emit.
    throw new Error(
      `emitReallocPrelude: unhandled frameworkName='${this.frameworkName}'. Add a branch for this target.`,
    );
  }

  /**
   * task #41 — per-target rewrite of top-level user-written const items.
   * The parser preserves them verbatim (just their raw source text);
   * target-specific items (Pubkey::new_from_array, anchor_lang refs)
   * need adapting per emitter. Default impl is a no-op; Pinocchio
   * overrides to strip `Pubkey::new_from_array([...])` since its Pubkey
   * is a `[u8; 32]` alias (no associated constructor).
   */
  protected postProcessTopLevelConst(constText: string): string {
    return constText;
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
      )
      // task #41 — Anchor's `System::id()` (and similar program-id helpers
      // from anchor_lang::system_program) carries through as bare type
      // references the target doesn't have. The system program ID is the
      // 32-byte zero pubkey; emit a 32-byte zero slice literal that works
      // in both `seeds = [System::id().as_ref()]` (needs `&[u8]`) and
      // `seeds::program = System::id()` (needs `&Pubkey`) contexts.
      // pinocchio's Pubkey = [u8; 32] so `&[0u8; 32]` is a valid `&Pubkey`.
      .replace(/\bSystem\s*::\s*id\s*\(\s*\)\s*\.\s*as_ref\s*\(\s*\)/g, "&[0u8; 32][..]")
      .replace(/\bSystem\s*::\s*id\s*\(\s*\)/g, "&[0u8; 32]");
  }

  /**
   * Return the default/zero value for a given Rust type in generated code.
   * Subclasses can override for framework-specific type representations
   * (e.g. Pinocchio uses [0u8; 32] instead of Pubkey::default()).
   *
   * `seen` tracks user-struct names already being inlined to prevent
   * infinite recursion when a struct (transitively) references itself.
   */
  defaultValueForType(typeName: string, seen: Set<string> = new Set()): string {
    const normalized = typeName.trim();
    const typeDef = this.customTypeDef(normalized);
    const fixedArray = parseFixedArrayType(normalized);

    if (normalized === "bool") return "false";
    if (/^(u|i)\d+$/.test(normalized)) return "0";
    if (normalized === "f32" || normalized === "f64") return "0.0";
    if (normalized === "Pubkey") return this.defaultPubkeyValue();
    if (fixedArray) {
      return `[${this.defaultValueForType(fixedArray.elementType, seen)}; ${fixedArray.lenExpr.trim()}]`;
    }
    const arrayMatch = normalized.match(/^\[\s*u8\s*;\s*(\d+)\s*\]$/);
    if (arrayMatch?.[1]) return `[0u8; ${arrayMatch[1]}]`;
    if (normalized === "String") return "String::new()";
    if (normalized === "Vec<u8>") return "Vec::new()";
    if (typeDef?.kind === "enum" && typeDef.variants?.[0]) {
      return `${normalized}::${typeDef.variants[0]}`;
    }
    // User-defined struct: inline a field-by-field struct literal instead
    // of `T::default()`. Anchor auto-implements Default via its derive
    // macros, but Anvil strips those macros + the literal derive list
    // commonly excludes Default (since user code rarely calls T::default()
    // explicitly). The inlined literal compiles regardless. Recursion
    // guarded by `seen` to avoid stack overflow on self-referencing types.
    // Skip for structs with generics (we'd need to know the type args to
    // pick correct field defaults) or empty fields. Caught by
    // coral-anchor-cli-account: `Sub::default()` E0599 because the
    // user-source `#[derive(Clone, AnchorDeserialize, AnchorSerialize)]`
    // didn't include Default, and Sub's `state: State` field (an enum
    // without `#[default]`) blocks auto-derive.
    if (
      typeDef?.kind === "struct" &&
      typeDef.fields &&
      typeDef.fields.length > 0 &&
      !typeDef.generics &&
      !seen.has(normalized)
    ) {
      const nextSeen = new Set(seen);
      nextSeen.add(normalized);
      const inlineFields = typeDef.fields
        .map((f) => `${snakeCase(f.name)}: ${this.defaultValueForType(f.type, nextSeen)}`)
        .join(", ");
      return `${normalized} { ${inlineFields} }`;
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
  /** G31 — per-emit cache of collectKnownTopLevelNames. Without this,
   *  emitInstructionFile builds the set per-instruction, and the set
   *  includes sourceErrorEnumName() output which is O(variants × text)
   *  itself. Drift's 500+ variants × 30 instructions = multi-minute hang. */
  private _knownTopLevelNamesCache: Set<string> | null = null;
  private _knownTopLevelNamesCacheKey: SolanaIR | null = null;

  /** G31 — set of every top-level identifier emitted at crate root, used
   *  by collapseModulePaths to rewrite `mod1::mod2::ident` -> `ident` when
   *  the trailing ident matches a flattened symbol. */
  protected collectKnownTopLevelNames(ir: SolanaIR): Set<string> {
    if (this._knownTopLevelNamesCacheKey === ir && this._knownTopLevelNamesCache) {
      return this._knownTopLevelNamesCache;
    }
    const result = this.computeKnownTopLevelNames(ir);
    this._knownTopLevelNamesCacheKey = ir;
    this._knownTopLevelNamesCache = result;
    return result;
  }

  private computeKnownTopLevelNames(ir: SolanaIR): Set<string> {
    const out = new Set<string>();
    for (const h of ir.helperFns ?? []) out.add(h.name);
    for (const t of ir.types ?? []) out.add(t.name);
    for (const a of ir.accounts ?? []) out.add(a.name);
    for (const e of ir.errors ?? []) out.add(e.name);
    // G31b — instruction names are also at crate root post-flatten. Kamino
    // calls `lending_operations::refresh_reserve(...)` where refresh_reserve
    // shares a name with the instruction handler. Without this, the path
    // doesn't collapse and E0433 fires.
    for (const i of ir.instructions ?? []) out.add(i.name);
    // G31c — source error enum name. ir.errors holds variant names only;
    // the enum name itself is detected dynamically (sourceErrorEnumName).
    // Kamino: `Err(ErrorCode::AccountDiscriminatorNotFound.into())` needs
    // ErrorCode in the known set to survive `mod::ErrorCode::X` collapse.
    out.add(this.sourceErrorEnumName(ir));
    // Constants are raw string declarations; parse out the names.
    for (const c of ir.constants ?? []) {
      const m = c.match(/(?:^|\s)(?:pub\s+)?const\s+(\w+)\s*:/);
      if (m && m[1]) out.add(m[1]);
    }
    // G36 — attempted to add explicit-import names to known set so that
    // `external::types::X` collapses to `X`. Reverted: caused
    // cross-fixture cascading collapses because the imported names
    // (Clock, Pubkey, AccountInfo, etc.) collide with external-crate
    // sysvar/wrapper paths that we don't want to collapse. Marinade
    // +6, kamino +6, raydium +7 in trial. Future fix: scope the
    // import-name addition to specific suspect crates only.
    return out;
  }

  protected carriedFunctionBlock(rawCode: string, ir?: SolanaIR): string {
    let transformed = promoteFreeFnVisibility(this.transformHelperCode(rawCode, ir));
    // G31 — collapse multi-level module paths to bare names for every IR
    // top-level identifier (helpers, types, accounts, constants, errors).
    // Single-level form (`mod::helper(`) was insufficient for kamino, which
    // organizes helpers via `lending_operations::utils::is_allowed_signer(`.
    if (ir) {
      const knownNames = this.collectKnownTopLevelNames(ir);
      transformed = collapseModulePaths(transformed, knownNames);
    }
    // G40 — strip anchor_lang prefixes + rewrite `source!()` → `()` +
    // rewrite AnchorSerialize/AnchorDeserialize → Borsh equivalents in
    // carried helper bodies. Previously only impl-items got this treatment;
    // helpers.rs (which holds the marinade `check_*` helpers chain) needs
    // it too.
    transformed = stripAnchorLangPrefixes(transformed);
    // Strip Anchor error-attribution chains (.with_source, .with_pubkeys, etc.)
    // that survive in helper bodies after source!() → () rewrite. These methods
    // don't exist in pinocchio. Applied only to helpers (not instruction bodies)
    // to avoid collateral damage on complex CPI patterns.
    // Handle up to 2 levels of nested parens — `.with_values((a.foo(), b.bar()))`
    // has nested `(...)` inside the outer call that `[^)]*` can't match.
    transformed = transformed.replace(/\s*\.with_(?:source|pubkeys|account_name|values)\s*\((?:[^()]*|\((?:[^()]*|\([^()]*\))*\))*\)/g, '');
    // Fix unbalanced Err() parens left by the chain strip.
    for (let pass = 0; pass < 3; pass++) {
      transformed = transformed.replace(/\bErr\(([^()]*(?:\([^()]*\))*[^()]*)\)\)/g, 'Err($1)');
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
      `// ║  ${MARKER_ANVIL_PREFIX}: function below was carried from the Anchor source and partially  ║`,
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
 * Stub the body of an `impl X { fn foo() {…} }` method when the body
 * references Anchor-only patterns that don't survive pinocchio/native
 * transpile. Signature is preserved so callers compile; body becomes
 * a compile-clean TODO that returns a generic error.
 *
 * Patterns that trigger stubbing:
 *   - CpiContext::, anchor_lang::, anchor_spl::
 *   - ctx.accounts. / ctx.bumps.
 *   - require!(, require_keys_eq!(, require_keys_neq!(, require_eq!(
 *   - Context<Self> in the signature (Anchor handler shape)
 *
 * Why: the parser preserves user impl methods as raw text. The Pinocchio
 * emitter has no equivalent for these macros / wrapper types, so emitting
 * them verbatim produces uncompilable code. Production Anchor programs
 * (Squads v4, Drift, Marinade) all have impl methods on state structs
 * that reference these patterns. Stubbing them lets the surrounding type
 * compile while flagging the gap for manual port.
 *
 * Exported for unit testing.
 */
const ANCHOR_ONLY_PATTERNS = [
  /\bCpiContext\s*::/,
  /\banchor_lang\s*::/,
  /\banchor_spl\s*::/,
  /\bctx\.accounts\./,
  /\bctx\.bumps\./,
  /\brequire!\s*\(/,
  /\brequire_eq!\s*\(/,
  /\brequire_neq!\s*\(/,
  /\brequire_keys_eq!\s*\(/,
  /\brequire_keys_neq!\s*\(/,
  /Context\s*<\s*Self\s*>/,
  /\bpyth_solana_receiver_sdk\s*::/,
  /\bswitchboard_on_demand\s*::/,
  /\bswitchboard_v2\s*::/,
  /\bdrift_mocks\s*::/,
  /\bkamino_mocks\s*::/,
  /\bjuplend_mocks\s*::/,
  /\bsolend_mocks\s*::/,
  /\bmarginfi_type_crate\s*::/,
  /\bid_crate\s*::/,
];

/**
 * Comment out body lines that access fields/methods on accounts whose
 * type is from a sibling Anchor program (or any other crate Anvil's emit
 * doesn't deserialize). squads-mpl/roles' `multisig: Account<'info, Ms>`
 * — `Ms` lives in `squads_mpl::state`. Anvil treats that as raw
 * AccountInfo since it doesn't have an AccountDef for `Ms`. Body code
 * like `multisig.create_key` and `multisig.is_member(...)` then fails
 * E0609/E0599 because AccountInfo has no such fields.
 *
 * Strategy: identify accounts whose `accountType` isn't in the user's IR
 * and isn't a known SPL/system/sysvar type. For each such account, find
 * `<acct>.<member>` references in body where `<member>` isn't a known
 * AccountInfo method/field. Wrap the enclosing statement in a TODO
 * commentout, mirroring the unsalvageable-helper pattern.
 *
 * Conservative: if the member IS a known AccountInfo accessor (.key,
 * .is_signer, .lamports, etc.), leave the line alone — those are
 * legitimate AccountInfo uses and don't need stubbing.
 */
const ACCOUNT_INFO_MEMBERS = new Set([
  "key", "is_signer", "is_writable", "lamports", "owner", "data",
  "data_len", "data_is_empty", "executable", "rent_epoch",
  "try_borrow_data", "try_borrow_mut_data", "try_borrow_lamports",
  "try_borrow_mut_lamports", "borrow_data_unchecked", "borrow_mut_data_unchecked",
  "to_account_info", "clone", "as_ref", "realloc", "resize",
  "owner_id", "is_owned_by_program",
]);

/** Built-in (non-user, non-sibling) account type names that don't need
 *  AccountDef-side deserialize because the framework owns the layout. */
const FRAMEWORK_ACCOUNT_TYPES = new Set([
  "Signer", "SystemAccount", "UncheckedAccount", "AccountInfo",
  "TokenAccount", "Mint", "Token", "Token2022", "AssociatedToken",
  "TokenInterface", "TokenMetadata",
  "Rent", "Clock", "EpochSchedule", "SlotHashes", "SlotHistory",
  "StakeHistory", "Sysvar",
  "System", "Program",
]);

export function commentOutSiblingStateAccesses(
  body: string,
  accounts: Array<{ name: string; accountType: string }>,
  knownAccountDefNames: Set<string>,
): string {
  // 0-accounts fallback: when the AccountsRef struct parse fails (e.g.
  // `seeds::program = sibling_crate::ID` constraint trips the splitter),
  // accounts comes in empty but the body still has `<X>.key()` references
  // that won't resolve. Stub the whole body to keep the file compile-clean
  // — same TODO contract as the sibling-state path.
  if (accounts.length === 0) {
    // Heuristic: if body has `<ident>.key()` patterns where the ident
    // isn't bound in the body's prelude (let X = &accounts[N]), the body
    // depends on an empty accounts list and is unsalvageable.
    // Match both pinocchio's `<X>.key()` (method) and native's `<X>.key`
    // (field) shapes. The reference is "unbound" when the local var
    // isn't declared as `let <X> = &accounts[N]` earlier in the body.
    const keyRefs: string[] = [];
    for (const m of body.matchAll(/(?<!\w)(\w+)\.key(?:\(\))?/g)) {
      if (m[1]) keyRefs.push(m[1]);
    }
    const declared = new Set<string>();
    for (const m of body.matchAll(/let\s+(\w+)\s*=\s*&?\s*accounts\[/g)) {
      if (m[1]) declared.add(m[1]);
    }
    const hasUnboundKeyRef = keyRefs.some((name) => !declared.has(name));
    if (hasUnboundKeyRef) {
      const argsMarker = body.indexOf("// Args");
      const userSectionStart = argsMarker >= 0 ? argsMarker : 0;
      const prelude = body.slice(0, userSectionStart);
      const userCode = body.slice(userSectionStart);
      const stubbed = userCode
        .split("\n")
        .map((line) => (line.length > 0 ? `// ${line}` : "//"))
        .join("\n");
      // G42 — balance check. Some bodies arrive with the fn-close `}`
      // outside the prelude (so commenting userCode buries it inside
      // comments → unclosed delimiter). Others have it already supplied
      // by the outer wrapper. Count uncommented braces in the assembled
      // output; pad missing closes with synthetic `}`.
      const assembled = `${prelude}// ${MARKER_ANVIL_TODO_PREFIX} AccountsRef struct parse failed (likely seeds::program = sibling::ID constraint or similar) — body references unresolved accounts. Manual port required.
${stubbed}
    Ok(())
`;
      let openCount = 0;
      let closeCount = 0;
      for (const line of assembled.split("\n")) {
        const trimmed = line.trimStart();
        if (trimmed.startsWith("//")) continue;
        for (const ch of line) {
          if (ch === "{") openCount++;
          else if (ch === "}") closeCount++;
        }
      }
      const padCloses = Math.max(0, openCount - closeCount);
      return padCloses > 0 ? `${assembled}${"}\n".repeat(padCloses)}` : assembled;
    }
    return body;
  }

  const siblingAccounts = accounts.filter((a) => {
    if (knownAccountDefNames.has(a.accountType)) return false;
    if (FRAMEWORK_ACCOUNT_TYPES.has(a.accountType)) return false;
    // Skip empty / unparseable types and lifetime-soup (e.g. "Sysvar<'info, Rent>").
    if (!a.accountType || /[<>'\s]/.test(a.accountType)) return false;
    return true;
  });
  if (siblingAccounts.length === 0) return body;

  // Detect any non-AccountInfo access on sibling accounts. If found, the
  // instruction body is structurally dependent on sibling state and can't
  // be transpiled standalone — replace the whole body with a TODO stub.
  // Granular line-by-line commentout cascades into use-after-comment
  // errors (commented `let X = sibling.field` orphans later `X.foo()`)
  // and managing transitive dependencies is more brittle than just
  // surfacing a single clear stub the user must port manually.
  let hasUnsafeAccess = false;
  for (const acc of siblingAccounts) {
    const accName = acc.name.replace(/[^A-Za-z0-9_]/g, "");
    if (!accName) continue;
    const re = new RegExp(`(?<!\\w)${accName}\\s*\\.\\s*(\\w+)`, "g");
    let m: RegExpExecArray | null;
    while ((m = re.exec(body)) !== null) {
      const member = m[1] ?? "";
      if (!ACCOUNT_INFO_MEMBERS.has(member)) {
        hasUnsafeAccess = true;
        break;
      }
    }
    if (hasUnsafeAccess) break;
  }
  if (!hasUnsafeAccess) return body;

  // Split body into prelude (account unpacking + signer checks Anvil
  // emits before any user code) and the user-code section. Comment out
  // user code; preserve prelude so the function signature still
  // accesses every account it declares (avoids unused-binding warnings
  // and keeps account_lens/signer checks intact for runtime safety).
  // Heuristic: prelude ends right before the first source-derived stmt.
  // Conservative anchor: keep everything up to and including the
  // last `let _system_program = …;` / signer check / data check,
  // identified by the comment marker `// Args` Anvil emits before
  // user-facing args parsing.
  const argsMarker = body.indexOf("// Args");
  const userSectionStart = argsMarker >= 0 ? argsMarker : 0;
  const prelude = body.slice(0, userSectionStart);
  const userCode = body.slice(userSectionStart);
  const stubbed = userCode
    .split("\n")
    .map((line) => (line.length > 0 ? `// ${line}` : "//"))
    .join("\n");
  const accountList = siblingAccounts.map((a) => `${a.name}: ${a.accountType}`).join(", ");
  // Append explicit `Ok(())` — the user's original tail (which Anvil
  // would otherwise pass through as the function's tail expression) is
  // now commented out, so without this the function body ends with a
  // bare if-stmt or commented block and rustc can't infer the return
  // type (E0317 if-may-be-missing-an-else).
  return `${prelude}// ${MARKER_ANVIL_TODO_PREFIX} sibling-Anchor-program state access — instruction body depends on opaque sibling-crate types (${accountList}); transpile is structural-only. Manual port required.
${stubbed}
    Ok(())
`;
}

/**
 * `get_instance_packed_len(&value)` is a `solana_program::borsh::*` helper.
 * Pinocchio doesn't ship solana-program; the function is unresolvable.
 * The standard alternative is `borsh::to_vec(&value).map(|v| v.len())` —
 * borsh ships in both target scaffolds, so the rewrite works on both
 * (no-op on native if the import survived; harmless replacement
 * otherwise).
 *
 * Applied to user-carried code (impl methods, helper fns) where the
 * call leaks through verbatim.
 */
export function rewriteGetInstancePackedLen(body: string): string {
  return body.replace(
    /\bget_instance_packed_len\s*\(/g,
    "borsh::to_vec(",
  ).replace(
    // After the rewrite the original `.unwrap_or_default()` still works
    // (Result is unwrapped with default 0). Append `.map(|v| v.len())`
    // before any postfix — search for `borsh::to_vec(EXPR)` and inject.
    /borsh::to_vec\(([^()]*(?:\([^()]*\))?[^()]*)\)/g,
    "borsh::to_vec($1).map(|v| v.len())",
  );
}

/**
 * Anchor's `Sysvar<'info, Rent>` binds the rent sysvar as a typed value
 * with method dispatch (`.minimum_balance(N)` etc.). Anvil's emit binds
 * it as raw `&AccountInfo`, so those method calls fail E0599. Rewrite
 * `<acct>.minimum_balance(...)` → `Rent::get()?.minimum_balance(...)` —
 * both targets auto-import Rent when this method appears in body text
 * (see `needsRent` detection in native/pinocchio emit).
 *
 * Same shape for the other canonical Rent methods. This is a safe
 * universal rewrite because Anvil's emit doesn't otherwise produce these
 * method names — they only come from sysvar-typed bindings in source.
 */
export function rewriteRentSysvarMethods(body: string): string {
  return body.replace(
    /\b\w+\.(minimum_balance|exempt_minimum|burn_percent)\s*\(/g,
    (full, method: string) => `Rent::get()?.${method}(`,
  );
}

/**
 * Replace panic-able `.try_into().unwrap()` with the safe `?` form. Both
 * SBF targets must surface conversion errors as ProgramError::Invalid-
 * AccountData rather than panicking on-chain. Anchor source carries this
 * pattern frequently (squads-mpl, marinade, helium); the rewrite keeps
 * the emit's control flow sound without rewriting the user's source.
 *
 * Targets the exact `.try_into().unwrap()` form. Plain `.unwrap()` after
 * other Result-producing calls is left alone (warning-only); we only
 * automatically rewrite when the upstream `.try_into()` makes the
 * intent unambiguous.
 */
export function rewriteTryIntoUnwrap(body: string): string {
  return body.replace(
    /\.try_into\(\)\.unwrap\(\)/g,
    `.try_into().map_err(|_| ProgramError::InvalidAccountData)?`,
  );
}

/**
 * Anchor source uses `Result<T>` as a one-arg alias for
 * `Result<T, anchor_lang::error::Error>`. Anvil's emit doesn't carry the
 * anchor_lang prelude, so a verbatim `Result<()>` resolves to the std
 * 2-arg Result and fails E0107. Rewrite to the explicit 2-arg form
 * pointing at ProgramError, which both targets ship.
 *
 * Applied to user-carried code (impl methods, helper fns) where the
 * verbatim `Result<...>` shape leaks through. Doesn't touch instruction
 * handler signatures (those go through emitInstructionFunction which
 * already targets the correct return type).
 */
export function rewriteAnchorResultAlias(body: string): string {
  return body.replace(
    /\bResult\s*<\s*([^,<>]+(?:<[^<>]*>)?)\s*>/g,
    (full, inner: string) => {
      // Skip already-2-arg shapes (the regex's alternation doesn't see commas
      // because we capture only the first arg, but a 2-arg Result has a comma
      // INSIDE the angle bracket — the negative class [^,<>] excludes it).
      return `Result<${inner.trim()}, ProgramError>`;
    },
  );
}

/**
 * task #40 — strip `anchor_lang::` and `anchor_lang::prelude::` prefixes
 * from type references in user-carried code (impl methods, helper fns).
 *
 * Anchor's prelude exports many sibling-crate types (Pubkey, Result,
 * AccountInfo, etc.) under `anchor_lang::prelude::*`. Trait impl methods
 * in user source spell them fully qualified (e.g. `anchor_lang::Result
 * <Self>` or `anchor_lang::prelude::Pubkey`). Anvil's targets have these
 * types in scope via different paths (pinocchio::*, solana_program::*),
 * so the qualified path doesn't resolve at cargo time even when the
 * unqualified name would.
 *
 * Strip the prefix so the unqualified identifier (which IS in scope)
 * survives. Two passes:
 *   - `anchor_lang::prelude::<Name>` → `<Name>`
 *   - `anchor_lang::<Name>` → `<Name>` (catches non-prelude exports
 *     like anchor_lang::Result that the prelude re-exports anyway)
 *
 * Surfaced by diff-arc on interface-account 2026-05-19 where user trait
 * impls' bodies were stubbed but the signatures kept the prefix.
 *
 * Trait declaration itself (`impl anchor_lang::Trait for X`) is handled
 * separately — `stubAnchorOnlyImplItem` already comments out the whole
 * item when the body is anchor-only.
 */
/**
 * G30 — drop lifetime parameters that aren't referenced in the body.
 * After `stripAnchorWrapperTypes` removes Pinocchio's wrappers like
 * `Account<'a, T>` → `AccountInfo`, struct decls like
 * `pub struct PerpMarketMap<'a> { markets: BTreeMap<…, AccountLoader<'a, …>> }`
 * → `pub struct PerpMarketMap<'a> { markets: … }` leave `'a` unused → E0392.
 *
 * Walk the generics list, drop each `'lifetime` param that has no
 * occurrence in the body. Type parameters (T, U) and bounded
 * lifetimes (`'a: 'b`) are kept verbatim — only bare lifetime drops.
 * Empty generics → `""`.
 *
 * Exported for unit testing.
 */
/** G46 — generate `_phantom_X: core::marker::PhantomData<&'X ()>,` fields
 *  for each lifetime declared in `generics` that doesn't appear in `body`.
 *  Empty string when all declared lifetimes are used (or none declared).
 *  Empty when generics has type parameters (`<T>`) or bounds — those need
 *  real handling, not phantom injection.
 *
 *  PhantomData implements BorshSerialize/BorshDeserialize as no-ops in
 *  borsh 1.x, so the struct's derive list stays compatible.
 */
export function synthesizePhantomLifetimeFields(generics: string, body: string): string {
  if (!generics) return "";
  const m = generics.match(/^\s*<\s*(.*?)\s*>\s*$/);
  if (!m) return "";
  const inner = m[1];
  if (!inner) return "";
  const params = inner.split(",").map((p) => p.trim()).filter(Boolean);
  // Only fire for the simple case: all-lifetime generics, no bounds, no types.
  const allLifetimesNoBounds = params.every((p) => /^'[a-zA-Z_]\w*$/.test(p));
  if (!allLifetimesNoBounds) return "";
  const phantoms: string[] = [];
  for (const p of params) {
    const lifetime = p; // `'X`
    const ltUseRe = new RegExp(`${lifetime}\\b`);
    // Filter out lifetime use inside the synthesized impl block declaration
    // line itself; we only care about whether FIELDS use it.
    if (!ltUseRe.test(body)) {
      const name = lifetime.slice(1); // strip leading `'`
      phantoms.push(`    pub _phantom_${name}: core::marker::PhantomData<&${lifetime} ()>,`);
    }
  }
  return phantoms.join("\n");
}

export function dropUnusedLifetimes(generics: string, body: string): string {
  if (!generics) return "";
  const m = generics.match(/^\s*<\s*(.*?)\s*>\s*$/);
  if (!m) return generics;
  const inner = m[1];
  if (!inner) return generics;
  const params = inner.split(",").map((p) => p.trim()).filter(Boolean);
  const kept: string[] = [];
  for (const p of params) {
    const lifetimeMatch = p.match(/^'([a-zA-Z_]\w*)\s*$/);
    if (lifetimeMatch) {
      const lt = "'" + lifetimeMatch[1];
      // Look for any non-trivial occurrence of the lifetime in body. The
      // pattern `'\w+` is unique enough that a regex test is reliable.
      const ltUseRe = new RegExp(`${lt}\\b`);
      if (ltUseRe.test(body)) kept.push(p);
      continue;
    }
    kept.push(p);
  }
  if (kept.length === 0) return "";
  return `<${kept.join(", ")}>`;
}

/**
 * G33 — post-emit lib.rs brace balance. When source-rewrite passes strip
 * an `impl X { ... }` block but leave one of its braces behind, the
 * emitted lib.rs has a stray unmatched `}` (marginfi/mango hit this).
 * Walk the content tracking depth, ignoring `{`/`}` inside strings,
 * char literals, line comments, and block comments. If depth goes
 * negative, drop that `}`. Repeat until balanced or no more changes.
 *
 * Conservative: never adds braces (additions risk breaking something
 * meaningful). Only removes the FIRST stray `}` per pass to limit
 * blast radius.
 *
 * Exported for unit testing.
 */
export function balanceLibBraces(content: string): string {
  let out = content;
  for (let attempt = 0; attempt < 5; attempt++) {
    const dropIdx = firstStrayCloseBrace(out);
    if (dropIdx < 0) return out;
    out = out.slice(0, dropIdx) + out.slice(dropIdx + 1);
  }
  return out;
}

function firstStrayCloseBrace(src: string): number {
  let depth = 0;
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === '"') {
      i++;
      while (i < src.length && src[i] !== '"') {
        if (src[i] === '\\') i += 2;
        else i++;
      }
      i++;
      continue;
    }
    if (c === "'") {
      const m = src.slice(i).match(/^'(?:\\.|[^'])'/);
      if (m) { i += m[0].length; continue; }
      i++;
      continue;
    }
    if (c === '/' && src[i + 1] === '/') {
      const nl = src.indexOf('\n', i);
      i = nl < 0 ? src.length : nl + 1;
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2);
      i = end < 0 ? src.length : end + 2;
      continue;
    }
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth < 0) return i;
    }
    i++;
  }
  return -1;
}

export function stripAnchorLangPrefixes(body: string): string {
  // Order matters: handle the more-specific `anchor_lang::prelude::` first
  // so we don't half-strip and leave `prelude::` orphaned.
  let out = body
    .replace(/\banchor_lang\s*::\s*prelude\s*::\s*/g, "")
    .replace(/\banchor_lang\s*::\s*/g, "")
    .replace(/,?\s*arbitrary::Arbitrary\b/g, "")
    .replace(/\barbitrary::Arbitrary\s*,?\s*/g, "");
  // G40 — Anchor's `source!()` macro captures file/line/column for error
  // attribution. Marinade chains it via `.with_source(source!())?`. The
  // G19b Error stub's `with_source<T>(_arg: T)` accepts any value, so just
  // substitute `()` for the macro call. Cargo type-checks; runtime is
  // identical (no error attribution surfaces in the emitted target).
  out = out.replace(/\bsource\s*!\s*\(\s*\)/g, "()");
  // G40 — `AnchorSerialize` / `AnchorDeserialize` are anchor_lang re-
  // exports of Borsh's `BorshSerialize` / `BorshDeserialize`. The trait-
  // position references survive the anchor_lang strip; rewrite them to
  // the underlying Borsh traits which are imported by the file prelude.
  out = out.replace(/\bAnchorSerialize\b/g, "BorshSerialize");
  out = out.replace(/\bAnchorDeserialize\b/g, "BorshDeserialize");
  // G43 — bare `Result<T>` (1 generic arg) is Anchor's `Result<T> =
  // std::Result<T, anchor_lang::Error>` alias. After we strip anchor_lang
  // imports, the alias is gone and `Result<T>` resolves to std::Result
  // (2 args required) — E0107. Rewrite to `Result<T, ProgramError>` when
  // the inner depth-0 content has no comma (so we don't break already-
  // 2-arg uses) and the receiver isn't qualified by `::` or substring
  // of another identifier. Also skips known user-defined aliases like
  // MarginfiResult/DriftResult which match `<crate>Result<T>` (no
  // bare-Result confusion).
  out = rewriteBareResultAlias(out);
  return out;
}

function rewriteBareResultAlias(src: string): string {
  let out = "";
  let i = 0;
  const n = src.length;
  while (i < n) {
    // Find next occurrence of `Result` that isn't part of a longer ident
    // and isn't qualified by `::`.
    const idx = src.indexOf("Result", i);
    if (idx < 0) { out += src.slice(i); break; }
    out += src.slice(i, idx);
    const prevChar = idx > 0 ? src[idx - 1] ?? "" : "";
    const isQualified = src.slice(Math.max(0, idx - 2), idx) === "::";
    const isPartOfIdent = /[\w]/.test(prevChar);
    if (isQualified || isPartOfIdent) {
      out += "Result";
      i = idx + 6;
      continue;
    }
    // Look for `<...>` immediately after (optional whitespace).
    let j = idx + 6;
    while (j < n && /\s/.test(src[j] ?? "")) j++;
    if (src[j] !== "<") {
      out += "Result";
      i = idx + 6;
      continue;
    }
    // Find matching `>` at depth 0, tracking nested `<>` / `()` / `[]`.
    let depth = 1;
    let k = j + 1;
    let topLevelComma = false;
    while (k < n && depth > 0) {
      const ch = src[k] ?? "";
      if (ch === "<") depth++;
      else if (ch === ">") depth--;
      else if (ch === "," && depth === 1) topLevelComma = true;
      else if (ch === "(") {
        let parenDepth = 1;
        k++;
        while (k < n && parenDepth > 0) {
          if (src[k] === "(") parenDepth++;
          else if (src[k] === ")") parenDepth--;
          k++;
        }
        continue;
      }
      k++;
    }
    if (depth !== 0) {
      out += "Result";
      i = idx + 6;
      continue;
    }
    if (topLevelComma) {
      // 2-arg Result — leave alone.
      out += src.slice(idx, k);
      i = k;
      continue;
    }
    // Bare Result<T> → Result<T, ProgramError>.
    out += src.slice(idx, k - 1) + ", ProgramError>";
    i = k;
  }
  return out;
}

/**
 * G23 — strip Anchor wrapper types in arbitrary code (impl items, helper
 * fn signatures + bodies). Operates on the raw text — same regex shapes
 * used in transformHelperCode for fn parameters, plus a few extensions
 * for impl-item shapes (struct field/return-type positions).
 *
 * Closes raydium-clmm's state.rs impl-method signatures like:
 *   amm_config: &Account<AmmConfig>,            -> &AccountInfo
 *   token_mint: &InterfaceAccount<Mint>,        -> &AccountInfo
 *   token_mint_freeze_authority: COption<Pubkey>,  -> Option<Pubkey>
 * Without this, those parameter types reference Account / InterfaceAccount
 * / Mint / COption — all of which Anvil filters out as anchor_lang/
 * anchor_spl re-exports.
 *
 * Conservative: only strips wrappers with explicit generics or explicit
 * Anchor-wrapper shape. Bare `Mint` / `TokenAccount` / `Account` could
 * be user-defined types, so we don't touch them.
 *
 * `target`: "pin" produces `AccountInfo` (no lifetime), "native"
 * produces `AccountInfo<'info>` (matches solana_program shape).
 */
/** G80 — add `<'info>` generic to fn declarations that reference 'info
 * in their signature/body but don't declare it. Anchor source's helpers
 * (drift's `liquidation_liquidate_perp_with_fill(... &AccountInfo<'info> ...)`)
 * inherit the surrounding impl's `<'info>` generic; after Anvil flattens
 * to a free fn, the lifetime is unbound. Native target hits this hard
 * because AccountInfo carries an explicit lifetime; Pinocchio's
 * AccountInfo is lifetime-free so this is a no-op there.
 */
export function addInfoLifetimeIfReferenced(text: string): string {
  if (!text.includes("'info")) return text;
  // Match `pub(...) fn NAME(...)` or `pub fn NAME(...)` or `fn NAME(...)`.
  // Walk every match; for each, find the matching close-paren of args, then
  // check if the fn's sig/body uses 'info and the generic isn't declared.
  let out = "";
  let i = 0;
  const re = /\b(pub(?:\s*\([^)]*\))?\s+|pub\s+|\b)(fn\s+)(\w+)(<[^>]*>)?\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const start = m.index;
    const beforeFn = m[1] ?? "";
    const fnKw = m[2] ?? "";
    const fnName = m[3] ?? "";
    const generics = m[4] ?? "";
    const openParenIdx = m.index + m[0].length - 1;
    // Brace-walk to matching close paren of args.
    let depth = 1;
    let endParen = -1;
    for (let j = openParenIdx + 1; j < text.length; j++) {
      const ch = text[j];
      if (ch === "(") depth++;
      else if (ch === ")") { depth--; if (depth === 0) { endParen = j; break; } }
    }
    if (endParen < 0) continue;
    // Walk forward to the fn body or `;`.
    let bodyEnd = endParen + 1;
    let braceDepth = 0;
    let foundOpen = false;
    for (let j = endParen + 1; j < text.length; j++) {
      const ch = text[j];
      if (ch === "{") { foundOpen = true; braceDepth++; }
      else if (ch === "}") { braceDepth--; if (foundOpen && braceDepth === 0) { bodyEnd = j + 1; break; } }
      else if (ch === ";" && !foundOpen && braceDepth === 0) { bodyEnd = j + 1; break; }
    }
    const fullFn = text.slice(start, bodyEnd);
    if (!/'info\b/.test(fullFn)) {
      out += text.slice(i, bodyEnd);
      i = bodyEnd;
      continue;
    }
    if (generics && /'info\b/.test(generics)) {
      out += text.slice(i, bodyEnd);
      i = bodyEnd;
      continue;
    }
    // G96 guard — if the enclosing impl block already declares 'info, the
    // method inherits it; adding a method-level 'info would shadow with
    // E0496. Look back to the most recent `impl ...` line at lesser indent
    // than this fn; if it declares 'info in its generics, skip.
    if (enclosingImplDeclaresInfo(text, start)) {
      out += text.slice(i, bodyEnd);
      i = bodyEnd;
      continue;
    }
    // Replace the fn declaration to include <'info>.
    const newGenerics = generics
      ? generics.replace(/^</, "<'info, ")
      : "<'info>";
    const newDecl = `${beforeFn}${fnKw}${fnName}${newGenerics}(`;
    out += text.slice(i, start) + newDecl + text.slice(openParenIdx + 1, bodyEnd);
    i = bodyEnd;
  }
  out += text.slice(i);
  return out;
}

/** G99 — find each `impl From<X> for ProgramError` in carried lib.rs and
 * return the set of X names. Used to suppress the scaffold-injected version
 * in errors.rs so we don't get E0119 conflict. */
export function collectCarriedFromImpls(libContent: string): Set<string> {
  const out = new Set<string>();
  const re = /\bimpl\s+From\s*<\s*([A-Za-z_][A-Za-z0-9_]*)\s*>\s+for\s+ProgramError\b/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(libContent)) !== null) {
    if (m[1]) out.add(m[1]);
  }
  return out;
}

/** G99 — strip `impl From<X> for ProgramError { ... }` blocks from errors.rs
 * for every X in `carriedFromEnums`. Brace-balanced removal. */
export function stripScaffoldFromImpls(errorsContent: string, carriedFromEnums: Set<string>): string {
  let out = errorsContent;
  for (const name of carriedFromEnums) {
    const re = new RegExp(`impl\\s+From\\s*<\\s*${name}\\s*>\\s+for\\s+ProgramError\\b`);
    const m = re.exec(out);
    if (!m) continue;
    // Walk to opening `{`
    let i = m.index + m[0].length;
    while (i < out.length && out[i] !== "{") i++;
    if (i >= out.length) continue;
    let depth = 1;
    let j = i + 1;
    while (j < out.length && depth > 0) {
      if (out[j] === "{") depth++;
      else if (out[j] === "}") depth--;
      j++;
    }
    // Strip from m.index to j (inclusive of closing brace).
    // Also trim trailing newline.
    let end = j;
    if (out[end] === "\n") end++;
    out = out.slice(0, m.index) + out.slice(end);
  }
  return out;
}

/** G96 helper — walk backward from `fnStart` line by line, return true when
 * the nearest enclosing `impl ...` line (at lesser indent than the fn's line)
 * declares `'info` in its generics. */
function enclosingImplDeclaresInfo(text: string, fnStart: number): boolean {
  let lineStart = fnStart;
  while (lineStart > 0 && text[lineStart - 1] !== "\n") lineStart--;
  const fnLine = text.slice(lineStart, text.indexOf("\n", lineStart) === -1 ? text.length : text.indexOf("\n", lineStart));
  const fnIndent = (fnLine.match(/^\s*/)?.[0].length) ?? 0;
  // Free fns at column 0 are never inside an impl block (post-Anvil emit
  // always flushes flattened helpers to top-level).
  if (fnIndent === 0) return false;
  let pos = lineStart - 1;
  while (pos > 0) {
    let ls = pos;
    while (ls > 0 && text[ls - 1] !== "\n") ls--;
    const le = text.indexOf("\n", ls);
    const line = text.slice(ls, le === -1 ? text.length : le);
    const indent = (line.match(/^\s*/)?.[0].length) ?? 0;
    const trimmed = line.trim();
    if (trimmed.startsWith("impl") && indent < fnIndent) {
      // E.g., `impl<'info> Foo {`, `impl<'a, 'info, T> Foo<'info> {`,
      // `impl Foo {`. We only need to know if generics include 'info.
      const g = trimmed.match(/^impl(\s*<[^>]*>)?/);
      return !!(g && g[1] && /'info\b/.test(g[1]));
    }
    pos = ls - 1;
  }
  return false;
}

export function stripAnchorWrappersInCode(body: string, target: "pin" | "native"): string {
  const ai = target === "pin" ? "AccountInfo" : "AccountInfo<'info>";
  const aiRef = target === "pin" ? "&AccountInfo" : "&AccountInfo<'info>";
  let out = body;
  // G59 — preserve source-supplied lifetime arg when stripping Anchor
  // wrappers on Native. `AccountLoader<'a, T>` → `AccountInfo<'a>` (not
  // `<'info>`). The replacement-fn variants below capture the lifetime
  // and emit `AccountInfo<'X>`. On Pinocchio, AccountInfo has no
  // lifetime param so we drop entirely (same as before).
  const aiWithLt = (lt: string | undefined): string => {
    if (target === "pin") return "AccountInfo";
    return lt ? `AccountInfo<${lt}>` : "AccountInfo<'info>";
  };
  const aiRefWithLt = (lt: string | undefined): string => {
    if (target === "pin") return "&AccountInfo";
    return lt ? `&AccountInfo<${lt}>` : "&AccountInfo<'info>";
  };
  void ai; void aiRef; void aiWithLt; void aiRefWithLt;
  // Box<Account<'info, T>> → AccountInfo (Box dropped)
  out = out.replace(/Box\s*<\s*Account\s*<\s*(?:'?\w+\s*,\s*)?[\w:]+\s*>\s*>/g, ai);
  out = out.replace(/Box\s*<\s*InterfaceAccount\s*<\s*(?:'?\w+\s*,\s*)?[\w:]+\s*>\s*>/g, ai);
  // &mut Account<'info, T> → &mut AccountInfo (mut markers preserved)
  out = out.replace(/&\s*mut\s+Account\s*<\s*(?:'?\w+\s*,\s*)?[\w:]+\s*>/g, target === "pin" ? "&mut AccountInfo" : "&mut AccountInfo<'info>");
  out = out.replace(/&\s*mut\s+InterfaceAccount\s*<\s*(?:'?\w+\s*,\s*)?[\w:]+\s*>/g, target === "pin" ? "&mut AccountInfo" : "&mut AccountInfo<'info>");
  // &Account<'info, T> → &AccountInfo
  out = out.replace(/&\s*Account\s*<\s*(?:'?\w+\s*,\s*)?[\w:]+\s*>/g, aiRef);
  out = out.replace(/&\s*InterfaceAccount\s*<\s*(?:'?\w+\s*,\s*)?[\w:]+\s*>/g, aiRef);
  // Bare Account<'info, T> in parameter/return-type positions: prefer the
  // referenced shape. Hardest case — `Account` could be the user type, but
  // when followed by `<'lifetime, ...>` it's the Anchor wrapper.
  out = out.replace(/\bAccount\s*<\s*'(?:\w+)\s*,\s*[\w:]+\s*>/g, ai);
  out = out.replace(/\bInterfaceAccount\s*<\s*'(?:\w+)\s*,\s*[\w:]+\s*>/g, ai);
  out = out.replace(/\bAccount\s*<\s*[A-Z]\w*\s*>/g, ai); // Account<Foo> bare, no lifetime
  out = out.replace(/\bInterfaceAccount\s*<\s*[A-Z]\w*\s*>/g, ai);
  // Signer<'info> / SystemAccount<'info> / UncheckedAccount<'info>
  out = out.replace(/&\s*mut\s+Signer\s*<\s*'?\w+\s*>/g, target === "pin" ? "&mut AccountInfo" : "&mut AccountInfo<'info>");
  out = out.replace(/&\s*Signer\s*<\s*'?\w+\s*>/g, aiRef);
  out = out.replace(/\bSigner\s*<\s*'?\w+\s*>/g, ai);
  out = out.replace(/&\s*SystemAccount\s*<\s*'?\w+\s*>/g, aiRef);
  out = out.replace(/\bSystemAccount\s*<\s*'?\w+\s*>/g, ai);
  out = out.replace(/&\s*UncheckedAccount\s*<\s*'?\w+\s*>/g, aiRef);
  out = out.replace(/\bUncheckedAccount\s*<\s*'?\w+\s*>/g, ai);
  out = out.replace(/&\s*Program\s*<\s*(?:'?\w+\s*,\s*)?[\w:]+\s*>/g, aiRef);
  out = out.replace(/\bProgram\s*<\s*(?:'?\w+\s*,\s*)?[\w:]+\s*>/g, ai);
  // G59 — capture lifetime arg so source `AccountLoader<'a, T>` becomes
  // `AccountInfo<'a>` on Native (preserving source-supplied lifetime).
  out = out.replace(/&\s*AccountLoader\s*<\s*(?:('?\w+)\s*,\s*)?[\w:]+\s*>/g, (_full, lt) => aiRefWithLt(lt));
  out = out.replace(/\bAccountLoader\s*<\s*(?:('?\w+)\s*,\s*)?[\w:]+\s*>/g, (_full, lt) => aiWithLt(lt));
  // COption<T> → Option<T> — anchor_lang's C-compatible Option wrapper.
  // Rust's std Option is structurally equivalent for emit purposes.
  out = out.replace(/\bCOption\s*</g, "Option<");
  // G31c — bare `COption::None` / `COption::Some(...)` value references.
  // Kamino: `... .delegate() == COption::None`. Strip the wrapper, emit
  // the std variant directly.
  out = out.replace(/\bCOption::(None|Some)\b/g, "$1");
  // G27h — strip / normalize AccountInfo<'X> lifetime arg. Pinocchio's
  // AccountInfo struct has no lifetime param (Pubkey is a [u8;32]
  // alias); user code with `AccountInfo<'a>` in nested generics like
  // `BTreeMap<Pubkey, AccountInfo<'a>>` (drift's OracleMap) fails E0107
  // "struct takes 0 lifetime arguments but 1 supplied". Native carries
  // a lifetime convention 'info, so normalize user's choice to 'info.
  if (target === "pin") {
    out = out.replace(/\bAccountInfo\s*<\s*'[a-zA-Z_]\w*\s*>/g, "AccountInfo");
  } else {
    // G41 — only normalize to `'info` when the surrounding scope ALSO
    // uses `'info`. If the struct/impl generic is `<'a>` (drift's
    // OracleMap), forcing `'info` into the field type triggers E0261
    // "use of undeclared lifetime name". Preserve whatever lifetime the
    // source carries; the surrounding generic param will match.
    // Only normalize bare/unscoped lifetimes (e.g. `AccountInfo<'_>`) to
    // a plain `'info` so anvil-internal emit (which uses 'info by
    // convention) still resolves.
    out = out.replace(/\bAccountInfo\s*<\s*'_\s*>/g, "AccountInfo<'info>");
  }
  // G37 — Pinocchio's `pinocchio::instruction::AccountMeta<'a>` carries
  // `pub pubkey: &'a Pubkey` (a reference), whereas solana_program's
  // `AccountMeta` has `pub pubkey: Pubkey` directly. User code carried
  // through unchanged (e.g. `impl From<&AccountMeta> for TransactionAccount`)
  // reads `account_meta.pubkey` expecting a value; the field assignment
  // `pubkey: account_meta.pubkey` then fails E0308 mismatched types
  // (`&[u8; 32]` vs `[u8; 32]`). Scan parameter signatures for bindings
  // typed `&AccountMeta` and prepend a deref to their `.pubkey` reads.
  // Coral-multisig hit this; same shape will appear anywhere user code
  // converts between AccountMeta and a custom struct.
  if (target === "pin") {
    const accountMetaParamRe = /\b(\w+)\s*:\s*&\s*(?:'\w+\s+)?AccountMeta\b/g;
    const idents = new Set<string>();
    let m: RegExpExecArray | null;
    while ((m = accountMetaParamRe.exec(out)) !== null) {
      if (m[1]) idents.add(m[1]);
    }
    for (const ident of idents) {
      // Rewrite `<ident>.pubkey` → `*<ident>.pubkey` only when the access
      // is a plain field read (not already deref'd, not the LHS of an `=`,
      // not the receiver of a `.method()` chain).
      const re = new RegExp(`(?<![*&.])\\b${ident}\\s*\\.\\s*pubkey\\b(?!\\s*[(=])`, "g");
      out = out.replace(re, `*${ident}.pubkey`);
    }
    // G56 — Pinocchio AccountInfo exposes key/owner/lamports/is_signer/
    // is_writable/executable as METHODS, not fields. Anchor source treats
    // them as fields. Rewrite `<x>.key` → `<x>.key()`, etc.
    // Match `.method` not followed by `(` (already a call) or word char
    // (longer ident like `key_word`). No capture group on receiver since
    // indexed receivers like `ais[1].key` have non-word chars before `.`
    // and \b doesn't anchor cleanly. The lookbehind `(?<=\w|\])` allows
    // receivers ending in word char OR `]` (index slice access).
    out = out.replace(/(?<=[\w\]])\.key(?!\s*[(\w])/g, ".key()");
    out = out.replace(/(?<=[\w\]])\.owner(?!\s*[(\w])/g, ".owner()");
    out = out.replace(/(?<=[\w\]])\.lamports(?!\s*[(\w])/g, ".lamports()");
    out = out.replace(/(?<=[\w\]])\.is_writable(?!\s*[(\w])/g, ".is_writable()");
    out = out.replace(/(?<=[\w\]])\.is_signer(?!\s*[(\w])/g, ".is_signer()");
    out = out.replace(/(?<=[\w\]])\.executable(?!\s*[(\w])/g, ".executable()");
    // G58b — Pinocchio Pubkey is `[u8; 32]` type alias (no methods).
    // Source-level `Pubkey::find_program_address(...)` and
    // `Pubkey::create_program_address(...)` need to route to standalone
    // fns at `pinocchio::pubkey::*`. Match bare `Pubkey::` and
    // `solana_program::pubkey::Pubkey::` qualified shapes. Same rewrite
    // as in postProcessPinocchioRewrites (instruction-body scope) but
    // applied here too so carried impl items + helpers get it.
    out = out.replace(
      /(?:solana_program\s*::\s*pubkey\s*::\s*)?Pubkey\s*::\s*(find_program_address|create_program_address)\b/g,
      "pinocchio::pubkey::$1",
    );
    // G62 — extend solana_program::{log,program}::* → pinocchio::* rewrite
    // to carried code (was already in postProcessPinocchioRewrites for
    // instruction body, but helpers + impl items missed it).
    out = out.replace(
      /(?:anchor_lang\s*::\s*)?solana_program\s*::\s*log\s*::\s*(sol_log|sol_log_data|sol_log_64|sol_log_compute_units|sol_log_slice)\b/g,
      "pinocchio::log::$1",
    );
    out = out.replace(
      /(?:anchor_lang\s*::\s*)?solana_program\s*::\s*program\s*::\s*(set_return_data|get_return_data)\b/g,
      "pinocchio::program::$1",
    );
  }
  return out;
}

/**
 * Comment out a `impl <Trait> for <sibling>::<...>` block when the target
 * type lives in a sibling Anchor program (not a known ecosystem crate).
 * squads-mpl/roles' lib.rs has `impl From<IncomingInstruction> for
 * squads_mpl::state::IncomingInstruction { ... }` — without the sibling
 * crate, that target type is unresolvable. Comment the whole impl with
 * the same TODO banner as other unsupported-shape stubs.
 */
const SIBLING_KNOWN_EXTERNAL_CRATES = new Set([
  "anchor_lang", "anchor_spl", "solana_program", "pinocchio",
  "core", "std", "alloc",
]);
const SIBLING_KNOWN_EXTERNAL_PREFIXES = ["spl_", "mpl_", "pyth_", "switchboard_"];

/**
 * Extract the comma-separated derive names from any `#[derive(...)]`
 * attribute preceding the item in `rawCode`. Returns an empty array
 * when there are no derives. Used to preserve user-source derives like
 * FromPrimitive / ToPrimitive that target-stamped emit would otherwise
 * drop.
 */
function extractUserDerives(rawCode: string): string[] {
  const out: string[] = [];
  for (const m of rawCode.matchAll(/#\[derive\(([^)]+)\)\]/g)) {
    const args = m[1] ?? "";
    for (const part of args.split(",")) {
      const name = part.trim();
      if (name) out.push(name);
    }
  }
  for (const m of rawCode.matchAll(/#\[cfg_attr\([^,]+,\s*derive\(([^)]+)\)\)\]/g)) {
    const args = m[1] ?? "";
    for (const part of args.split(",")) {
      const name = part.trim();
      if (name) out.push(name);
    }
  }
  return out;
}

/**
 * G4 — Rewrite Anchor wrapper type names (Account, Signer, TokenAccount,
 * Box<Account>, etc.) to type-agnostic AccountInfo equivalents. Used by
 * rustTypeForCustomType to clean up struct field types in carried-source
 * structs that survive into emit. Without this, "cannot find type
 * `Signer`" errors cascade because anchor_lang is filtered.
 *
 * Generalizes to any Anchor program with helper structs (raydium-clmm's
 * SwapAccounts wrapper, drift's various Context-shaped structs).
 *
 * Returns the input verbatim when no Anchor wrapper is detected.
 */
function stripAnchorWrapperTypes(typeName: string, target: "pin" | "native"): string {
  let t = typeName.trim();
  // Pin's Pubkey is [u8; 32] type alias and AccountInfo has no lifetime
  // param. Native's AccountInfo<'a> takes a lifetime — when source has
  // a struct generic like `<'b, 'info>`, downstream fields should reference
  // 'info. We always emit 'info because that's the convention; the carry-
  // through struct generic must include 'info (Anvil-generated struct
  // headers usually do).
  const ai = target === "pin"
    ? "pinocchio::account_info::AccountInfo"
    : "solana_program::account_info::AccountInfo<'info>";
  // G59 — when source carries a lifetime arg, preserve it instead of
  // forcing `'info`. Helper that emits AccountInfo with the captured
  // lifetime. Pinocchio always drops the lifetime.
  const aiWithLt = (lt: string | undefined): string => {
    if (target === "pin") return "pinocchio::account_info::AccountInfo";
    return lt ? `solana_program::account_info::AccountInfo<${lt}>` : "solana_program::account_info::AccountInfo<'info>";
  };
  // Box<Account<'info, T>> → AccountInfo (Box dropped — Anvil doesn't carry boxed wrappers).
  t = t.replace(/Box\s*<\s*Account\s*<\s*(?:('?\w+)\s*,\s*)?[\w:]+\s*>\s*>/g, (_full, lt) => aiWithLt(lt));
  t = t.replace(/Box\s*<\s*InterfaceAccount\s*<\s*(?:('?\w+)\s*,\s*)?[\w:]+\s*>\s*>/g, (_full, lt) => aiWithLt(lt));
  // Account<'info, T> → AccountInfo (T is dropped — type-agnostic emit)
  t = t.replace(/Account\s*<\s*(?:('?\w+)\s*,\s*)?[\w:]+\s*>/g, (_full, lt) => aiWithLt(lt));
  t = t.replace(/InterfaceAccount\s*<\s*(?:('?\w+)\s*,\s*)?[\w:]+\s*>/g, (_full, lt) => aiWithLt(lt));
  // Signer<'info> / SystemAccount<'info> / UncheckedAccount<'info> / Program<'info, T>
  t = t.replace(/Signer\s*<\s*('?\w+)\s*>/g, (_full, lt) => aiWithLt(lt));
  t = t.replace(/SystemAccount\s*<\s*('?\w+)\s*>/g, (_full, lt) => aiWithLt(lt));
  t = t.replace(/UncheckedAccount\s*<\s*('?\w+)\s*>/g, (_full, lt) => aiWithLt(lt));
  t = t.replace(/Program\s*<\s*(?:('?\w+)\s*,\s*)?[\w:]+\s*>/g, (_full, lt) => aiWithLt(lt));
  t = t.replace(/AccountLoader\s*<\s*(?:('?\w+)\s*,\s*)?[\w:]+\s*>/g, (_full, lt) => aiWithLt(lt));
  void ai;
  // G27h — strip / normalize AccountInfo<'X> lifetime arg. Pinocchio's
  // AccountInfo has no lifetime; user fields like `AccountInfo<'a>` in
  // nested generics (drift's OracleMap.oracles) fail E0107.
  // G41 — Native: preserve the source-supplied lifetime instead of
  // forcing `'info`. The struct's outer generic uses whatever the source
  // declared (drift's `OracleMap<'a>`); rewriting only the field type to
  // `'info` triggers E0261 because the impl block also uses `'a`. Only
  // normalize `'_` (anonymous) to `'info`.
  if (target === "pin") {
    t = t.replace(/\bAccountInfo\s*<\s*'[a-zA-Z_]\w*\s*>/g, "AccountInfo");
  } else {
    t = t.replace(/\bAccountInfo\s*<\s*'_\s*>/g, "AccountInfo<'info>");
  }
  return t;
}

function isKnownExternalCrate(crate: string): boolean {
  if (SIBLING_KNOWN_EXTERNAL_CRATES.has(crate)) return true;
  return SIBLING_KNOWN_EXTERNAL_PREFIXES.some((p) => crate.startsWith(p));
}

/** Return the leftmost path segment of a target type node, or null when the
 *  target isn't a scoped path. Mirrors the regex `for <crate>::` shape — only
 *  paths with at least one `::` qualify as candidates. */
function leftmostScopedSegment(typeNode: SyntaxNode): string | null {
  if (typeNode.type !== "scoped_type_identifier" && typeNode.type !== "scoped_identifier") {
    return null;
  }
  let cur: SyntaxNode = typeNode;
  while (true) {
    const path = cur.childForFieldName("path");
    if (!path) break;
    if (path.type === "scoped_identifier" || path.type === "scoped_type_identifier") {
      cur = path;
      continue;
    }
    // path field is now a leaf identifier — the leftmost segment.
    return path.text;
  }
  return null;
}

export function commentOutSiblingTraitImpl(raw: string): string {
  const parser = getParserSync();
  if (parser) {
    try {
      const tree = parser.parse(raw);
      if (tree) {
        const root = tree.rootNode;
        if (root.namedChildCount === 1) {
          const top = root.namedChild(0);
          if (top && top.type === "impl_item" && !nodeHasError(top)) {
            const typeField = top.childForFieldName("type");
            if (!typeField) return raw;
            const crate = leftmostScopedSegment(typeField);
            // Non-scoped target (`for Bar`) — not a sibling, leave alone.
            if (!crate) return raw;
            if (isKnownExternalCrate(crate)) return raw;
            return commentOutBlock(raw, "trait impl for sibling-Anchor-program type — sibling crate not in target scaffold; manual port required");
          }
        }
      }
    } catch { /* fall through to regex fallback */ }
  }

  // Regex fallback for sync paths that run before parser warmup.
  const m = raw.match(/\bfor\s+([a-z_][a-z0-9_]*)\s*::/i);
  if (!m) return raw;
  const crate = m[1] ?? "";
  if (isKnownExternalCrate(crate)) return raw;
  return commentOutBlock(raw, "trait impl for sibling-Anchor-program type — sibling crate not in target scaffold; manual port required");
}

function commentOutBlock(raw: string, reason: string): string {
  const commented = raw
    .split("\n")
    .map((line) => (line.length > 0 ? `// ${line}` : "//"))
    .join("\n");
  return `// ${MARKER_ANVIL_TODO_PREFIX} ${reason}\n${commented}`;
}

/**
 * Comment out call sites referencing sibling-Anchor-program CPI helpers —
 * `<crate>::cpi::<fn>(...)` shapes where `<crate>` isn't a known external
 * Solana ecosystem crate. squads-mpl/roles' proxy handlers call
 * `squads_mpl::cpi::create_transaction(...)` which needs the sibling
 * crate's CpiContext machinery; both targets strip the import and the
 * call. Same TODO-stub pattern as solana_program::invoke commentout.
 */
const SIBLING_CPI_BANNER = "sibling-Anchor-program CPI — sibling crate not in target scaffold; manual port required";

/** Match `<crate>::cpi::<fn>` exactly (3 segments) where the call's function
 *  is a scoped_identifier. Returns the crate's leading identifier text or
 *  null on mismatch. */
function siblingCpiCallCrate(callExpr: SyntaxNode): string | null {
  const fnNode = callExpr.childForFieldName("function");
  if (!fnNode || fnNode.type !== "scoped_identifier") return null;
  // tree-sitter-rust nests as: scoped_identifier(path: scoped_identifier(path: id, name: id), name: id)
  const outerName = fnNode.childForFieldName("name");
  if (!outerName || outerName.type !== "identifier") return null;
  const mid = fnNode.childForFieldName("path");
  if (!mid || mid.type !== "scoped_identifier") return null;
  const midName = mid.childForFieldName("name");
  if (!midName || midName.type !== "identifier" || midName.text !== "cpi") return null;
  const crateNode = mid.childForFieldName("path");
  if (!crateNode || crateNode.type !== "identifier") return null;
  return crateNode.text;
}

/** Walk up to the smallest enclosing statement-or-tail-expression node.
 *  Returns either an `expression_statement`/`let_declaration` (the
 *  ;-terminated common case) or the direct child of a `block` when the call
 *  sits at the block's tail position (no trailing `;`). Mirrors the legacy
 *  regex behavior of walking back to the previous `{`/`;` and forward to
 *  the next `;`/`}`. */
function enclosingStatement(n: SyntaxNode): SyntaxNode | null {
  let cur: SyntaxNode | null = n;
  while (cur && cur.parent) {
    if (cur.type === "expression_statement" || cur.type === "let_declaration") {
      return cur;
    }
    if (cur.parent.type === "block") {
      // Direct child of a block — a tail expression in the function/block.
      return cur;
    }
    cur = cur.parent;
  }
  return null;
}

const T22_EXTENSION_SIZES: Record<string, number> = {
  "extensions::close_authority::authority": 36,
  "extensions::permanent_delegate::delegate": 36,
  "extensions::non_transferable": 4,
  "extensions::default_account_state::state": 5,
  "extensions::interest_bearing::rate": 56,
  "extensions::transfer_fee::transfer_fee_config_authority": 112,
  "extensions::transfer_hook::authority": 68,
  "extensions::metadata_pointer::authority": 68,
  "extensions::group_pointer::authority": 68,
  "extensions::group_pointer::group_address": 0,
};

function computeT22ExtensionSpace(constraints: Array<{ kind: string; value?: string }>): number {
  const seen = new Set<string>();
  let total = 0;
  for (const c of constraints) {
    const prefix = c.kind.split("::").slice(0, 2).join("::");
    if (!c.kind.startsWith("extensions::") || seen.has(prefix)) continue;
    seen.add(prefix);
    const size = T22_EXTENSION_SIZES[c.kind] ?? T22_EXTENSION_SIZES[prefix + "::authority"] ?? 0;
    total += size;
  }
  return total;
}

function collectSiblingCpiStatements(root: SyntaxNode, ranges: Array<{ start: number; end: number }>): void {
  if (root.type === "call_expression") {
    const crate = siblingCpiCallCrate(root);
    if (crate && !isKnownExternalCrate(crate)) {
      const stmt = enclosingStatement(root);
      if (stmt) {
        ranges.push({ start: stmt.startIndex, end: stmt.endIndex });
      }
    }
  }
  for (let i = 0; i < root.namedChildCount; i++) {
    const c = root.namedChild(i);
    if (c) collectSiblingCpiStatements(c, ranges);
  }
}

export function rewriteSiblingCpiCalls(body: string): string {
  const parser = getParserSync();
  if (parser) {
    try {
      const tree = parser.parse(body);
      if (tree) {
        // Skip the AST path when the input has top-level parse errors — emitter
        // output occasionally carries pre-existing residuals from earlier
        // post-processors that the regex fallback handles by ignoring scope.
        if (!nodeHasError(tree.rootNode)) {
          const ranges: Array<{ start: number; end: number }> = [];
          collectSiblingCpiStatements(tree.rootNode, ranges);
          if (ranges.length === 0) return body;
          // Merge overlapping (same statement may host multiple sibling CPI calls).
          ranges.sort((a, b) => a.start - b.start);
          const merged: Array<{ start: number; end: number }> = [];
          for (const r of ranges) {
            const last = merged[merged.length - 1];
            if (last && r.start <= last.end) last.end = Math.max(last.end, r.end);
            else merged.push({ ...r });
          }
          let out = "";
          let cursor = 0;
          for (const r of merged) {
            out += body.slice(cursor, r.start);
            const stmt = body.slice(r.start, r.end);
            const commented = stmt
              .split("\n")
              .map((line) => (line.length > 0 ? `// ${line}` : "//"))
              .join("\n");
            out += `// ${MARKER_ANVIL_TODO_PREFIX} ${SIBLING_CPI_BANNER}\n${commented}`;
            cursor = r.end;
          }
          out += body.slice(cursor);
          return out;
        }
      }
    } catch { /* fall through to regex fallback */ }
  }

  // Regex fallback — bracket-walker for cases the AST didn't cover (parse
  // errors in emitted text, or sync paths before parser warmup).
  const SIBLING_CPI_RE = /\b([a-z_][a-z0-9_]*)\s*::\s*cpi\s*::\s*[a-z_][a-z0-9_]*\s*\(/gi;
  type Range = { start: number; end: number };
  const ranges: Range[] = [];
  let m: RegExpExecArray | null;
  SIBLING_CPI_RE.lastIndex = 0;
  while ((m = SIBLING_CPI_RE.exec(body)) !== null) {
    const crate = m[1] ?? "";
    if (isKnownExternalCrate(crate)) continue;
    let pd = 0;
    let start = 0;
    for (let i = m.index - 1; i >= 0; i--) {
      const ch = body[i];
      if (ch === ")" || ch === "}" || ch === "]") pd++;
      else if (ch === "(" || ch === "[") {
        if (pd === 0) { start = i + 1; break; }
        pd--;
      } else if (ch === "{") {
        if (pd === 0) { start = i + 1; break; }
        pd--;
      } else if (ch === ";" && pd === 0) { start = i + 1; break; }
    }
    let depth = 0;
    let end = body.length;
    for (let i = m.index; i < body.length; i++) {
      const ch = body[i];
      if (ch === "(" || ch === "[" || ch === "{") depth++;
      else if (ch === ")" || ch === "]" || ch === "}") {
        if (depth === 0) { end = i; break; }
        depth--;
      } else if (ch === ";" && depth === 0) { end = i + 1; break; }
    }
    while (start < end && (body[start] === "\n" || body[start] === " ")) start++;
    ranges.push({ start, end });
  }
  if (ranges.length === 0) return body;
  ranges.sort((a, b) => a.start - b.start);
  const merged: Range[] = [];
  for (const r of ranges) {
    const last = merged[merged.length - 1];
    if (last && r.start <= last.end) last.end = Math.max(last.end, r.end);
    else merged.push({ ...r });
  }
  let out = "";
  let cursor = 0;
  for (const r of merged) {
    out += body.slice(cursor, r.start);
    const stmt = body.slice(r.start, r.end);
    const commented = stmt
      .split("\n")
      .map((line) => (line.length > 0 ? `// ${line}` : "//"))
      .join("\n");
    out += `// ${MARKER_ANVIL_TODO_PREFIX} ${SIBLING_CPI_BANNER}\n${commented}`;
    cursor = r.end;
  }
  out += body.slice(cursor);
  return out;
}

const STUB_BODY = ` {\n        // ${MARKER_ANVIL_TODO_PREFIX} Anchor-only impl method body — manual port required.\n        // Original referenced CpiContext / ctx.accounts / require! macros that\n        // have no pinocchio/native equivalent at this layer.\n        Err(ProgramError::Custom(0))\n    }`;

// task #40 — fallback stub for impl methods whose return type isn't a
// Result. The default STUB_BODY returns `Err(ProgramError::Custom(0))`
// which only typechecks for `-> Result<X, ProgramError>` shapes. Trait
// impls like `fn owners() -> &'static [Pubkey]` (Anchor's Owners trait)
// need a body that diverges (returns `!`) so it satisfies any return
// type. `unimplemented!()` panics at runtime if reached — acceptable
// for a manual-port stub since the unsafe-marker already gates deploy.
// Surfaced by diff-arc on interface-account 2026-05-19.
const STUB_BODY_UNIMPLEMENTED = ` {\n        // ${MARKER_ANVIL_TODO_PREFIX} Anchor-only impl method body — manual port required.\n        // Non-Result return type; stub diverges via unimplemented!() so the\n        // signature typechecks. Calling this stub panics — deploy gates on\n        // the unsafe-marker validator pass.\n        unimplemented!()\n    }`;

function pickStubBody(sig: string): string {
  // Look for `-> Result<...>` or `-> ProgramResult` (which IS Result<()>);
  // either form works with the Err(...) body. Default to Result.
  if (/->\s*Result\s*</.test(sig)) return STUB_BODY;
  if (/->\s*ProgramResult\b/.test(sig)) return STUB_BODY;
  // No return-arrow means default-unit (`-> ()`) — Err() doesn't typecheck
  // there either, fall through to unimplemented.
  if (!/->/.test(sig)) return STUB_BODY_UNIMPLEMENTED;
  return STUB_BODY_UNIMPLEMENTED;
}

const ANCHOR_ONLY_MACRO_NAMES = new Set([
  "require", "require_eq", "require_neq",
  "require_keys_eq", "require_keys_neq",
]);
const ANCHOR_ONLY_PATH_PREFIXES = new Set([
  "CpiContext", "anchor_lang", "anchor_spl",
  "pyth_solana_receiver_sdk", "switchboard_on_demand", "switchboard_v2",
  "drift_mocks", "kamino_mocks", "juplend_mocks", "solend_mocks",
  "marginfi_type_crate", "id_crate",
]);

function nodeHasError(n: SyntaxNode): boolean {
  if (n.type === "ERROR" || n.isMissing) return true;
  for (let i = 0; i < n.namedChildCount; i++) {
    const c = n.namedChild(i);
    if (c && nodeHasError(c)) return true;
  }
  return false;
}

function nodeHasAnchorOnlyPattern(n: SyntaxNode): boolean {
  // scoped path like `CpiContext::new`, `anchor_lang::…`, `anchor_spl::…`
  if (n.type === "scoped_identifier" || n.type === "scoped_type_identifier") {
    const head = firstPathSegmentText(n);
    if (head && ANCHOR_ONLY_PATH_PREFIXES.has(head)) return true;
  }
  // field chain: `ctx.accounts.X` / `ctx.bumps.X`
  if (n.type === "field_expression") {
    const value = n.childForFieldName("value");
    if (value && value.type === "field_expression") {
      const inner = value.childForFieldName("value");
      const innerField = value.childForFieldName("field");
      if (
        inner && inner.type === "identifier" && inner.text === "ctx" &&
        innerField && (innerField.text === "accounts" || innerField.text === "bumps")
      ) return true;
    }
  }
  // macro_invocation: require!, require_eq!, …
  if (n.type === "macro_invocation") {
    const nameNode = n.childForFieldName("macro");
    if (nameNode && ANCHOR_ONLY_MACRO_NAMES.has(nameNode.text)) return true;
  }
  // signature shape `Context<Self>`
  if (n.type === "generic_type") {
    const tyNode = n.childForFieldName("type");
    const argsNode = n.childForFieldName("type_arguments");
    if (tyNode && tyNode.text === "Context" && argsNode && /\bSelf\b/.test(argsNode.text)) {
      return true;
    }
  }
  for (let i = 0; i < n.namedChildCount; i++) {
    const c = n.namedChild(i);
    if (c && nodeHasAnchorOnlyPattern(c)) return true;
  }
  return false;
}

function firstPathSegmentText(n: SyntaxNode): string | null {
  // `A::B::C` → walk leftmost path; tree-sitter-rust nests these.
  let cur: SyntaxNode | null = n;
  while (cur && (cur.type === "scoped_identifier" || cur.type === "scoped_type_identifier")) {
    const path = cur.childForFieldName("path");
    if (!path) {
      const name = cur.childForFieldName("name");
      return name?.text ?? null;
    }
    cur = path;
  }
  return cur?.text ?? null;
}

export function stubAnchorOnlyImplItem(raw: string): string {
  const parser = getParserSync();
  if (parser) {
    try {
      const tree = parser.parse(raw);
      if (tree) {
        const root = tree.rootNode;
        // Expect a single top-level function_item — skip const_item and any
        // other shape; the regex fallback below preserves prior behavior for
        // those edges.
        if (root.namedChildCount === 1) {
          const top = root.namedChild(0);
          if (top && top.type === "function_item" && !nodeHasError(top)) {
            const body = top.childForFieldName("body");
            if (body && body.type === "block") {
              if (!nodeHasAnchorOnlyPattern(top)) return raw;
              const sig = raw.slice(0, body.startIndex).trimEnd();
              return `${sig}${pickStubBody(sig)}`;
            }
          }
        }
      }
    } catch { /* fall through to regex fallback */ }
  }

  // Regex fallback — used when tree-sitter isn't initialized yet (sync paths
  // before parseAnchor warms the singleton) or when the chunk isn't a
  // standalone function_item. Manual depth-walk with string + comment skipping
  // preserves bit-identity for the const_item path (no `{` at depth 0 ⇒ raw).
  if (!ANCHOR_ONLY_PATTERNS.some((re) => re.test(raw))) return raw;
  let depth = 0;
  let inString = false;
  let inLine = false;
  let inBlock = false;
  let bodyStart = -1;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    const next = raw[i + 1];
    if (inLine) { if (ch === "\n") inLine = false; continue; }
    if (inBlock) { if (ch === "*" && next === "/") { inBlock = false; i++; } continue; }
    if (inString) { if (ch === "\\") { i++; continue; } if (ch === '"') inString = false; continue; }
    if (ch === "/" && next === "/") { inLine = true; i++; continue; }
    if (ch === "/" && next === "*") { inBlock = true; i++; continue; }
    if (ch === '"') { inString = true; continue; }
    if (ch === "{") {
      if (depth === 0 && bodyStart === -1) bodyStart = i;
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth === 0 && bodyStart !== -1) {
        const sig = raw.slice(0, bodyStart).trimEnd();
        return `${sig}${pickStubBody(sig)}`;
      }
    }
  }
  return raw;
}

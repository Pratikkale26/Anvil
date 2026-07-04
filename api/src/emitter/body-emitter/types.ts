/**
 * Shared interfaces for the body-emitter package. The walker holds mutable
 * tracking state via BodyEmitterContext and calls back into the framework
 * emitter via BodyEmitterCallbacks.
 */

export interface BodyEmitterContext {
  transformedCount: number;
  passedThroughCount: number;
  details: string[];
  warnings: string[];
  /**
   * Account names whose bump derivation was already emitted in the
   * instruction-function preamble (init constraint preludes). The body
   * walker uses this to skip re-emitting the bump check when the body
   * later references `ctx.bumps.<X>`.
   */
  preEmittedBumps?: string[];
}

/**
 * Per-call options for SPL token CPIs that vary based on the token program in
 * use. Token-2022 deprecates the unchecked variants, so the emitter routes to
 * `transfer_checked` / `mint_to_checked` / `burn_checked` and needs the mint
 * + decimals to build the instruction. Plain SPL Token leaves these unset.
 */
export interface Token2022Opts {
  tokenProgram?: "token" | "token_2022";
  /** Mint account snake_case name — only meaningful when tokenProgram === "token_2022". */
  mint?: string;
  /** Mint decimals expression — only meaningful when tokenProgram === "token_2022". */
  decimals?: string;
  /**
   * AccountInfo binding name for runtime program-ID dispatch. Set when the
   * source uses Anchor's `Interface<TokenInterface>` (or anchor_spl::
   * token_interface::*) — Anchor's reference dispatches the SPL CPI to
   * whichever token program the runtime AccountInfo owns at call time.
   * When set, the emit reads `<tokenProgramArg>.key()` instead of
   * a hardcoded const program ID. Discriminator + account layout are
   * SHARED between SPL Token and SPL Token-2022 for transfer_checked /
   * mint_to_checked / burn_checked / close_account, so the same code
   * shape works for either at runtime — only the program-id source
   * differs. tokenProgram should be set to "token_2022" alongside this
   * to pick the *_checked variant; the dispatch is what makes it work
   * for legacy Token too.
   */
  tokenProgramArg?: string;
}

export interface BodyEmitterCallbacks {
  readonly frameworkName: string;
  emitAccountKeyExpr(accountName: string): string;
  emitAccountKeyAsRefExpr(accountName: string): string;
  emitAccountLamportsExpr(accountName: string): string;
  emitStateRead(accountName: string, typeName: string, localVar: string, mutable: boolean): string;
  /**
   * `init_if_needed` runtime branch — emit a let-binding that reads existing
   * state when the account already has data, and default-initializes when
   * empty. Without this, body code following an `init_if_needed` constraint
   * would silently overwrite pre-existing state on every call.
   */
  emitStateReadOrInit(accountName: string, typeName: string, localVar: string, mutable: boolean): string;
  emitStateSave(accountName: string, typeName: string, localVar: string): string;
  emitStateInit(typeName: string, localVar: string): string;
  emitBumpSeed(programId: string, seeds: string[], expectedKey: string): string;
  emitOwnerCheck(name: string): string;
  emitPdaSignerSeeds(
    account: string,
    accountInfoVar: string,
    seeds: string[],
    bumpField?: string,
    stateVar?: string,
    typeName?: string,
    // Maps each seed-referenced account name → its deserialized state var
    // (Pinocchio F6). Kept in sync with BaseEmitter.emitPdaSignerSeeds.
    stateVarMap?: ReadonlyMap<string, string>,
  ): string;
  emitRequire(condition: string, error: string): string;
  emitMsg(message: string): string;
  emitEmit(event: string, fields: string): string;
  emitClockGet(localVar: string, field?: string): string;
  emitRentGet(localVar: string, field?: string): string;
  emitClockGetExpr(field?: string): string;
  emitClockGetExprNoTry(field?: string): string;
  emitRentGetExpr(field?: string): string;
  emitRentGetExprNoTry(field?: string): string;
  emitSystemTransfer(from: string, to: string, amount: string, signerSeeds?: string): string;
  emitSplTransfer(from: string, to: string, authority: string, amount: string, signerSeeds?: string, opts?: Token2022Opts): string;
  emitSplMintTo(mint: string, to: string, authority: string, amount: string, signerSeeds?: string, opts?: Token2022Opts): string;
  emitSplBurn(from: string, mint: string, authority: string, amount: string, signerSeeds?: string, opts?: Token2022Opts): string;
  emitSplCloseAccount(account: string, destination: string, authority: string, signerSeeds?: string, opts?: Token2022Opts): string;
  emitSplSetAuthority(account: string, currentAuthority: string, authorityType: string, newAuthority: string, signerSeeds?: string, opts?: Token2022Opts): string;
  emitT22NonTransferableMintInitialize(mint: string, tokenProgram: string, signerSeeds?: string): string;
  emitT22InitializeMint2(mint: string, tokenProgram: string, decimals: string, mintAuthority: string, freezeAuthority: string, signerSeeds?: string): string;
  emitT22TransferFeeInitialize(mint: string, tokenProgram: string, transferFeeConfigAuthority: string, withdrawWithheldAuthority: string, basisPoints: string, maximumFee: string, signerSeeds?: string): string;
  emitT22TransferFeeSetFee(mint: string, tokenProgram: string, authority: string, basisPoints: string, maximumFee: string, signerSeeds?: string): string;
  emitT22ImmutableOwnerInitialize(tokenAccount: string, tokenProgram: string, signerSeeds?: string): string;
  emitT22MintCloseAuthorityInitialize(mint: string, tokenProgram: string, closeAuthority: string, signerSeeds?: string): string;
  emitT22PermanentDelegateInitialize(mint: string, tokenProgram: string, delegate: string, signerSeeds?: string): string;
  emitT22TransferHookInitialize(mint: string, tokenProgram: string, authority: string, transferHookProgramId: string, signerSeeds?: string): string;
  emitT22TransferHookUpdate(mint: string, tokenProgram: string, authority: string, transferHookProgramId: string, signerSeeds?: string): string;
  emitT22MetadataPointerInitialize(mint: string, tokenProgram: string, authority: string, metadataAddress: string, signerSeeds?: string): string;
  emitT22MetadataPointerUpdate(mint: string, tokenProgram: string, authority: string, metadataAddress: string, signerSeeds?: string): string;
  emitT22GroupPointerInitialize(mint: string, tokenProgram: string, authority: string, groupAddress: string, signerSeeds?: string): string;
  emitT22GroupPointerUpdate(mint: string, tokenProgram: string, authority: string, groupAddress: string, signerSeeds?: string): string;
  emitT22GroupMemberPointerInitialize(mint: string, tokenProgram: string, authority: string, memberAddress: string, signerSeeds?: string): string;
  emitT22GroupMemberPointerUpdate(mint: string, tokenProgram: string, authority: string, memberAddress: string, signerSeeds?: string): string;
  emitT22TransferCheckedWithFee(source: string, mint: string, destination: string, authority: string, tokenProgram: string, amount: string, decimals: string, fee: string, signerSeeds?: string): string;
  emitT22WithdrawWithheldFromMint(mint: string, destination: string, authority: string, tokenProgram: string, signerSeeds?: string): string;
  emitT22HarvestWithheldToMint(mint: string, tokenProgram: string, sourcesExpr: string, signerSeeds?: string): string;
  emitT22DefaultAccountStateInitialize(mint: string, tokenProgram: string, state: string, signerSeeds?: string): string;
  emitT22DefaultAccountStateUpdate(mint: string, tokenProgram: string, freezeAuthority: string, state: string, signerSeeds?: string): string;
  emitT22InterestBearingMintInitialize(mint: string, tokenProgram: string, rateAuthority: string, rate: string, signerSeeds?: string): string;
  emitT22InterestBearingMintUpdateRate(mint: string, tokenProgram: string, rateAuthority: string, rate: string, signerSeeds?: string): string;
  emitT22TokenMetadataInitialize(metadata: string, mint: string, mintAuthority: string, updateAuthority: string, tokenProgram: string, name: string, symbol: string, uri: string, signerSeeds?: string): string;
  emitT22TokenMetadataUpdateField(metadata: string, updateAuthority: string, tokenProgram: string, field: string, value: string, signerSeeds?: string): string;
  emitT22TokenMetadataUpdateAuthority(metadata: string, currentAuthority: string, tokenProgram: string, newAuthority: string, signerSeeds?: string): string;
  emitCreateAta(ata: string, payer: string, mint: string, authority: string, signerSeeds?: string): string;
  emitMemo(data: string, signerSeeds?: string): string;
  emitProgramAccountClose(account: string, destination: string): string;
  emitCreateAccountCpi(from: string, to: string, lamports: string, space: string, owner: string): string;
  transformAmountExpr(amount: string): string;
  /**
   * N6 — Pyth legacy / modern read emits. These already exist on
   * BaseEmitter (api/src/emitter/emitter-base.ts:534, 585) and are
   * called from ast-visitor/visitor-base.ts:3485, 3521 — TS flagged
   * the missing-on-interface gap on every typecheck. Declared here
   * to close the loop. The signatures mirror the BaseEmitter
   * methods; subclasses (Pinocchio / Native) inherit a single
   * implementation from emitter-base.
   */
  emitPythReadPriceLegacy(
    feedAccount: string,
    priceBinding: string,
    clockExpr: string,
    maxAgeExpr: string,
    staleErrExpr: string | undefined,
  ): string;
  emitPythReadPriceModern(
    priceUpdateAccount: string,
    priceBinding: string,
    clockExpr: string,
    maxAgeExpr: string,
    feedIdExpr: string,
  ): string;
  /**
   * task #47 — Switchboard On-Demand PullFeed reader. Like Pyth, lives
   * on BaseEmitter as a shared hand-rolled byte-read; both Pinocchio
   * and Native inherit the same implementation.
   */
  emitSwitchboardReadFeed(
    feedAccount: string,
    priceBinding: string,
    staleErrExpr: string | undefined,
    maxStalenessSlots: string | undefined,
  ): string;
}

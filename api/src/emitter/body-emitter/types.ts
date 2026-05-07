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
  emitPdaSignerSeeds(
    account: string,
    accountInfoVar: string,
    seeds: string[],
    bumpField?: string,
    stateVar?: string,
    typeName?: string,
  ): string;
  emitRequire(condition: string, error: string): string;
  emitMsg(message: string): string;
  emitEmit(event: string, fields: string): string;
  emitClockGet(localVar: string): string;
  emitRentGet(localVar: string): string;
  emitSystemTransfer(from: string, to: string, amount: string, signerSeeds?: string): string;
  emitSplTransfer(from: string, to: string, authority: string, amount: string, signerSeeds?: string, opts?: Token2022Opts): string;
  emitSplMintTo(mint: string, to: string, authority: string, amount: string, signerSeeds?: string, opts?: Token2022Opts): string;
  emitSplBurn(from: string, mint: string, authority: string, amount: string, signerSeeds?: string, opts?: Token2022Opts): string;
  emitSplCloseAccount(account: string, destination: string, authority: string, signerSeeds?: string, opts?: Token2022Opts): string;
  emitSplSetAuthority(account: string, currentAuthority: string, authorityType: string, newAuthority: string, signerSeeds?: string, opts?: Token2022Opts): string;
  emitT22NonTransferableMintInitialize(mint: string, tokenProgram: string, signerSeeds?: string): string;
  emitT22TransferFeeInitialize(mint: string, tokenProgram: string, transferFeeConfigAuthority: string, withdrawWithheldAuthority: string, basisPoints: string, maximumFee: string, signerSeeds?: string): string;
  emitT22TransferFeeSetFee(mint: string, tokenProgram: string, authority: string, basisPoints: string, maximumFee: string, signerSeeds?: string): string;
  emitCreateAta(ata: string, payer: string, mint: string, authority: string, signerSeeds?: string): string;
  emitMemo(data: string, signerSeeds?: string): string;
  emitProgramAccountClose(account: string, destination: string): string;
  emitCreateAccountCpi(from: string, to: string, lamports: string, space: string, owner: string): string;
  transformAmountExpr(amount: string): string;
}

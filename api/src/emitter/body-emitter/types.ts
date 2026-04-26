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
}

export interface BodyEmitterCallbacks {
  readonly frameworkName: string;
  emitAccountKeyExpr(accountName: string): string;
  emitAccountKeyAsRefExpr(accountName: string): string;
  emitAccountLamportsExpr(accountName: string): string;
  emitStateRead(accountName: string, typeName: string, localVar: string, mutable: boolean): string;
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
  emitCreateAta(ata: string, payer: string, mint: string, authority: string, signerSeeds?: string): string;
  emitMemo(data: string, signerSeeds?: string): string;
  emitProgramAccountClose(account: string, destination: string): string;
  emitCreateAccountCpi(from: string, to: string, lamports: string, space: string, owner: string): string;
  transformAmountExpr(amount: string): string;
}

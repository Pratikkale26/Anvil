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
  emitSplTransfer(from: string, to: string, authority: string, amount: string, signerSeeds?: string): string;
  emitSplMintTo(mint: string, to: string, authority: string, amount: string, signerSeeds?: string): string;
  emitSplBurn(from: string, mint: string, authority: string, amount: string, signerSeeds?: string): string;
  emitSplCloseAccount(account: string, destination: string, authority: string, signerSeeds?: string): string;
  emitCreateAta(ata: string, payer: string, mint: string, authority: string, signerSeeds?: string): string;
  emitProgramAccountClose(account: string, destination: string): string;
  emitCreateAccountCpi(from: string, to: string, lamports: string, space: string, owner: string): string;
  transformAmountExpr(amount: string): string;
}

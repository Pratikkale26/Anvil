import { TEST_SCRATCH } from "../scratch-root.ts";
import { join } from "node:path";
/**
 * Shared fixture pieces for solana-developers/program-examples'
 * basics/create-account/anchor program. The `create_system_account` ix
 * is the scope: a raw `system_program::create_account` CPI that hands
 * ownership of the new account to the system program (not the calling
 * program), with zero space and rent-exempt minimum lamports.
 *
 * Adjacent to program-examples-rent — same CPI shape (create_account
 * with owner = system_program), but no AddressData payload + no
 * instruction args. Rent computes `(Rent::get()?).minimum_balance(0)`
 * inline; the account is left empty post-create.
 *
 * Counts toward grant A1 (10 byte-equal external Anchor programs).
 *
 * Source: github.com/solana-developers/program-examples (basics/create-account).
 */
import {
  Transaction,
  TransactionInstruction,
  SystemProgram,
} from "@solana/web3.js";
import {
  anchorIxDiscriminator,
  Keypair,
  PublicKey,
  LiteSVM,
} from "../differential-harness.ts";
import { isTxFailure, txFailureMessage } from "../litesvm-tx-error.ts";
import { existsSync, readFileSync } from "node:fs";

export const LIB_RS =
  join(TEST_SCRATCH, "program-examples", "basics/create-account/anchor/programs/create-system-account/src/lib.rs");
// declare_id! from upstream source. Match verbatim — Anchor 0.30+'s
// DeclaredProgramIdMismatch check fires custom error 4100 otherwise.
export const PROGRAM_ID = "ARVNCsYKDQsCLHbwUTJLpFXVrJdjhWZStyzvxmKe2xHi";

export function loadAnchorSource(): string {
  if (!existsSync(LIB_RS)) {
    return "// MISSING: program-examples not cloned. Differential will skip.";
  }
  // Upstream calls `CpiContext::new(ctx.accounts.system_program.key(), …)`
  // — `.key()` returns a Pubkey, but anchor-lang 0.32's CpiContext::new
  // expects an AccountInfo. Swap to `.to_account_info()` for the
  // reference build. Anvil's parser is happy either way — the IR is the
  // same typed cpi_create_account regardless of which form the source
  // uses (the captured `owner` arg is what matters for the emit).
  return readFileSync(LIB_RS, "utf-8").replace(
    "CpiContext::new(\n                ctx.accounts.system_program.key(),",
    "CpiContext::new(\n                ctx.accounts.system_program.to_account_info(),",
  );
}

export interface CreateAccountCtx {
  payer: Keypair;
  newAccount: Keypair;
}

export async function setupCreateAccount(): Promise<CreateAccountCtx> {
  return {
    payer: Keypair.generate(),
    newAccount: Keypair.generate(),
  };
}

export async function callCreateSystemAccount(
  svm: LiteSVM,
  ctx: CreateAccountCtx,
  programId: PublicKey,
): Promise<void> {
  svm.airdrop(ctx.payer.publicKey, BigInt(10_000_000_000));

  const ix = new TransactionInstruction({
    programId,
    keys: [
      { pubkey: ctx.payer.publicKey, isSigner: true, isWritable: true },
      { pubkey: ctx.newAccount.publicKey, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    // No args — just the discriminator. Handler reads Rent sysvar +
    // computes lamports inline; the new account is space=0 + owner=system.
    data: Buffer.from(anchorIxDiscriminator("create_system_account")),
  });

  const tx = new Transaction().add(ix);
  tx.recentBlockhash = svm.latestBlockhash();
  tx.feePayer = ctx.payer.publicKey;
  // Both payer + new_account must sign (system_program::create_account
  // requires the new account to sign).
  tx.sign(ctx.payer, ctx.newAccount);
  const r = svm.sendTransaction(tx);
  if (isTxFailure(r)) {
    throw new Error(`create_system_account failed: ${txFailureMessage(r)}`);
  }
}

export function createAccountAccountsToCompare(ctx: CreateAccountCtx) {
  // The handler never writes data INTO the new account — it only allocates
  // (space=0) + assigns to system_program. So data byte-compare is
  // trivially equal (empty). compareLamports + compareOwner are the
  // actual correctness signal: must be system-owned with rent-exempt
  // minimum for a 0-byte account.
  return [{ pubkey: ctx.newAccount.publicKey, label: "new_account" }];
}

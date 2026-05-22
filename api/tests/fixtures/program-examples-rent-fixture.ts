/**
 * Shared fixture pieces for solana-developers/program-examples'
 * basics/rent/anchor program. The `create_system_account` ix is the
 * scope: a raw `system_program::create_account` CPI that hands ownership
 * to the system program (not the calling program) and writes
 * AddressData (two borsh Strings) into the new account.
 *
 * Why this fixture matters: surfaced a real emit bug during
 * authoring — Anvil's Pinocchio emit was substituting `program_id` for
 * the source's `&ctx.accounts.system_program.key()` 4th arg, leaving
 * the new account owned by the calling program instead of the system
 * program. Fixed in pinocchio-emitter.ts:emitCreateAccountCpi. This
 * fixture now gates against regression.
 *
 * Source: github.com/solana-developers/program-examples (basics/rent).
 */
import {
  Transaction,
  TransactionInstruction,
  SystemProgram,
} from "@solana/web3.js";
import {
  anchorIxDiscriminator,
  concatBytes,
  Keypair,
  PublicKey,
  LiteSVM,
} from "../differential-harness.ts";
import { isTxFailure, txFailureMessage } from "../litesvm-tx-error.ts";
import { existsSync, readFileSync } from "node:fs";

export const LIB_RS =
  "/tmp/program-examples/basics/rent/anchor/programs/rent-example/src/lib.rs";
// declare_id! from upstream source. Match verbatim — Anchor 0.30+'s
// DeclaredProgramIdMismatch check fires custom error 4100 otherwise.
export const PROGRAM_ID = "ED6f4gweAE7hWPQPXMt4kWxzDJne8VQEm9zkb1tMpFNB";

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

// Borsh String layout: u32 LE length + UTF-8 bytes.
function borshString(s: string): Uint8Array {
  const bytes = new TextEncoder().encode(s);
  const out = new Uint8Array(4 + bytes.length);
  new DataView(out.buffer).setUint32(0, bytes.length, true);
  out.set(bytes, 4);
  return out;
}

export interface RentCtx {
  payer: Keypair;
  newAccount: Keypair;
  name: string;
  address: string;
}

export async function setupRent(): Promise<RentCtx> {
  return {
    payer: Keypair.generate(),
    newAccount: Keypair.generate(),
    name: "Solana",
    address: "Anchor Test Program",
  };
}

export async function callCreateSystemAccount(
  svm: LiteSVM,
  ctx: RentCtx,
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
    // address_data = AddressData { name: String, address: String }.
    data: Buffer.from(
      concatBytes(
        anchorIxDiscriminator("create_system_account"),
        borshString(ctx.name),
        borshString(ctx.address),
      ),
    ),
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

export function rentAccountsToCompare(ctx: RentCtx) {
  // The handler doesn't write data INTO the account post-create_account;
  // it only allocates + assigns to system_program. So data byte-compare
  // is trivially equal (zero data). compareLamports + compareOwner are
  // the actual correctness signal — must be system-owned with the
  // computed rent-exempt minimum.
  return [{ pubkey: ctx.newAccount.publicKey, label: "new_account" }];
}

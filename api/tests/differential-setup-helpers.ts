/**
 * Shared SPL setup primitives for differential fixtures.
 *
 * Every SPL-touching fixture (ata-mint, spl-transfer, spl-burn, set-
 * authority, t22-transfer, escrow, future multisig/marketplace) ran ~30
 * lines of "create + initialize mint, create token account, mint tokens"
 * boilerplate inline. Each duplicate is a hand-typed copy: easy to drift,
 * easy to mistype account ordering, hard to keep aligned with on-chain
 * SPL Token wire format if the reference shifts.
 *
 * These helpers are the identity-preserving extraction. They take a
 * LiteSVM, a payer, and the relevant keypairs/pubkeys; they produce
 * Transaction instructions you compose into your own setup tx (so the
 * fixture stays in control of `recentBlockhash` / `feePayer` / the order
 * of tx-level signers). No new behavior — just the same setup, callable
 * with one line per logical primitive.
 *
 * Call sites pass the same `svm` they used for `airdrop` / `latestBlockhash`.
 * No internal state; safe to call from parallel scenarios.
 */
import {
  Transaction,
  SystemProgram,
  type TransactionInstruction,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  MINT_SIZE,
  ACCOUNT_SIZE,
  createInitializeMintInstruction,
  createInitializeAccountInstruction,
  createAssociatedTokenAccountInstruction,
  createMintToInstruction,
} from "@solana/spl-token";
import {
  Keypair,
  PublicKey,
  LiteSVM,
} from "./differential-harness.ts";
import { isTxFailure, txFailureMessage } from "./litesvm-tx-error.ts";

/**
 * Allocate + initialize an SPL Token mint. Returns the two ix to compose.
 * Caller signs with `payer` AND `mint`.
 */
export function createMintIxs(
  svm: LiteSVM,
  payer: PublicKey,
  mint: PublicKey,
  decimals: number,
  mintAuthority: PublicKey,
  freezeAuthority: PublicKey | null = null,
): TransactionInstruction[] {
  const lamports = Number(svm.minimumBalanceForRentExemption(BigInt(MINT_SIZE)));
  return [
    SystemProgram.createAccount({
      fromPubkey: payer,
      newAccountPubkey: mint,
      lamports,
      space: MINT_SIZE,
      programId: TOKEN_PROGRAM_ID,
    }),
    createInitializeMintInstruction(mint, decimals, mintAuthority, freezeAuthority),
  ];
}

/**
 * Allocate + initialize a regular (non-ATA) SPL Token account. Returns
 * two ix. Caller signs with `payer` AND `account`. Useful when a fixture
 * wants a token account at a specific keypair address (vs an ATA).
 */
export function createTokenAccountIxs(
  svm: LiteSVM,
  payer: PublicKey,
  account: PublicKey,
  mint: PublicKey,
  owner: PublicKey,
): TransactionInstruction[] {
  const lamports = Number(svm.minimumBalanceForRentExemption(BigInt(ACCOUNT_SIZE)));
  return [
    SystemProgram.createAccount({
      fromPubkey: payer,
      newAccountPubkey: account,
      lamports,
      space: ACCOUNT_SIZE,
      programId: TOKEN_PROGRAM_ID,
    }),
    createInitializeAccountInstruction(account, mint, owner),
  ];
}

/**
 * Create an Associated Token Account via the ATA program. Returns one ix.
 * Caller signs with `payer`. Idempotent on-chain: ATA-create-instruction
 * checks for existence; this helper assumes the account doesn't exist yet.
 */
export function createAtaIx(
  payer: PublicKey,
  ata: PublicKey,
  owner: PublicKey,
  mint: PublicKey,
): TransactionInstruction {
  return createAssociatedTokenAccountInstruction(payer, ata, owner, mint);
}

/**
 * Mint tokens to a destination token account. Returns one ix. Caller
 * signs with `mintAuthority`.
 */
export function mintToIx(
  mint: PublicKey,
  destination: PublicKey,
  mintAuthority: PublicKey,
  amount: bigint,
): TransactionInstruction {
  return createMintToInstruction(mint, destination, mintAuthority, amount);
}

/**
 * Compose: create mint + create owner ATA + mint `amount` tokens to ATA.
 * Returns the array of ix you append to a setup tx.
 *
 * Caller signs with: `payer`, `mint`, `mintAuthority` (often payer itself).
 * If the mintAuthority IS the payer, only [payer, mint] need to sign.
 *
 * Common shape across ata-mint, spl-transfer, escrow, set-authority.
 * Extracting collapses ~25 lines per fixture down to one call.
 */
export function setupMintAndAtaIxs(
  svm: LiteSVM,
  payer: PublicKey,
  mint: PublicKey,
  ata: PublicKey,
  ownerOfAta: PublicKey,
  decimals: number,
  amountToMint: bigint,
  mintAuthority: PublicKey = payer,
  freezeAuthority: PublicKey | null = null,
): TransactionInstruction[] {
  return [
    ...createMintIxs(svm, payer, mint, decimals, mintAuthority, freezeAuthority),
    createAtaIx(payer, ata, ownerOfAta, mint),
    mintToIx(mint, ata, mintAuthority, amountToMint),
  ];
}

/**
 * Send a setup tx that already has its instructions attached. Threads
 * through the boilerplate: blockhash, feePayer, sign, send, throw on err.
 * Lets fixture call sites skip 5 lines per setup tx.
 */
export function sendSetupTx(
  svm: LiteSVM,
  tx: Transaction,
  feePayer: PublicKey,
  signers: Keypair[],
  errLabel: string,
): void {
  tx.recentBlockhash = svm.latestBlockhash();
  tx.feePayer = feePayer;
  tx.sign(...signers);
  const r = svm.sendTransaction(tx);
  if (isTxFailure(r)) {
    throw new Error(`${errLabel} failed: ${txFailureMessage(r)}`);
  }
}

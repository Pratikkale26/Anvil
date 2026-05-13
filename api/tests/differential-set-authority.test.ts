/**
 * set_authority differential — Pinocchio has no pinocchio_token helper
 * for set_authority, so the emit hand-rolls a raw CPI against the SPL
 * Token program ID with the discriminator + AuthorityType byte +
 * COption-encoded new_authority. This fixture is the runtime gate on
 * that hand-rolled path.
 *
 * What we compare: the token account's data buffer (165 bytes of SPL
 * Token state including the owner field). If Anvil's hand-rolled
 * encoding miscounts the COption tag byte, swaps endianness, or sets
 * the wrong AuthorityType variant, the byte-equal compare fails.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  Transaction,
  TransactionInstruction,
  SystemProgram,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  MINT_SIZE,
  ACCOUNT_SIZE,
  createInitializeMintInstruction,
  createInitializeAccountInstruction,
} from "@solana/spl-token";
import {
  defineDifferential,
  anchorIxDiscriminator,
  concatBytes,
  Keypair,
  PublicKey,
  LiteSVM,
} from "./differential-harness.ts";
import { isTxFailure, txFailureMessage } from "./litesvm-tx-error.ts";

const SRC = join(import.meta.dir, "..", "src", "demo-programs", "set-authority.rs");
const PROGRAM_ID = "2Q4rAEjnfX9saZXrMieuKR49ozRVQiuJtamC7d8WFpGE";

defineDifferential({
  fixtureName: "set-authority",
  programIdBase58: PROGRAM_ID,
  anchorSource: readFileSync(SRC, "utf-8"),
  anchorPackageName: "set_authority_anchor_diff",
  anchorExtraDeps: `anchor-spl = "0.31"
spl-token = "7.0"`,

  setup: async () => {
    const payer = Keypair.generate();
    const currentOwner = Keypair.generate();
    const newOwner = Keypair.generate();
    const mint = Keypair.generate();
    const tokenAccount = Keypair.generate();
    return { payer, currentOwner, newOwner, mint, tokenAccount };
  },

  callScript: async (svm: LiteSVM, ctx, programId: PublicKey) => {
    svm.withDefaultPrograms().withNativeMints();
    svm.airdrop(ctx.payer.publicKey, BigInt(10_000_000_000));

    const mintRent = svm.minimumBalanceForRentExemption(BigInt(MINT_SIZE));
    const acctRent = svm.minimumBalanceForRentExemption(BigInt(ACCOUNT_SIZE));

    // Setup: mint + token account owned by `current_owner`.
    const setupTx = new Transaction()
      .add(SystemProgram.createAccount({
        fromPubkey: ctx.payer.publicKey,
        newAccountPubkey: ctx.mint.publicKey,
        lamports: Number(mintRent),
        space: MINT_SIZE,
        programId: TOKEN_PROGRAM_ID,
      }))
      .add(createInitializeMintInstruction(
        ctx.mint.publicKey,
        6,
        ctx.payer.publicKey,
        null,
      ))
      .add(SystemProgram.createAccount({
        fromPubkey: ctx.payer.publicKey,
        newAccountPubkey: ctx.tokenAccount.publicKey,
        lamports: Number(acctRent),
        space: ACCOUNT_SIZE,
        programId: TOKEN_PROGRAM_ID,
      }))
      .add(createInitializeAccountInstruction(
        ctx.tokenAccount.publicKey,
        ctx.mint.publicKey,
        ctx.currentOwner.publicKey,
      ));
    setupTx.recentBlockhash = svm.latestBlockhash();
    setupTx.feePayer = ctx.payer.publicKey;
    setupTx.sign(ctx.payer, ctx.mint, ctx.tokenAccount);
    const r1 = svm.sendTransaction(setupTx);
    if (isTxFailure(r1)) throw new Error(`setup failed: ${txFailureMessage(r1)}`);

    // Call the program's change_owner — flips token account owner from
    // current_owner to new_owner via token::set_authority CPI.
    const newOwnerBytes = ctx.newOwner.publicKey.toBuffer();
    const ix = new TransactionInstruction({
      programId,
      keys: [
        { pubkey: ctx.tokenAccount.publicKey, isSigner: false, isWritable: true },
        { pubkey: ctx.currentOwner.publicKey, isSigner: true, isWritable: false },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      ],
      data: Buffer.from(concatBytes(
        anchorIxDiscriminator("change_owner"),
        new Uint8Array(newOwnerBytes),
      )),
    });
    const tx = new Transaction().add(ix);
    tx.recentBlockhash = svm.latestBlockhash();
    tx.feePayer = ctx.payer.publicKey;
    tx.sign(ctx.payer, ctx.currentOwner);
    const r2 = svm.sendTransaction(tx);
    if (isTxFailure(r2)) throw new Error(`change_owner failed: ${txFailureMessage(r2)}`);
  },

  // Token account is SPL-layout (no Anchor disc).
  stripDiscriminator: false,
  accountsToCompare: (ctx) => [
    { pubkey: ctx.tokenAccount.publicKey, label: "token_account_post_set_authority" },
  ],
});

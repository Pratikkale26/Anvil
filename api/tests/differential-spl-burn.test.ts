/**
 * SPL burn differential — fifth fixture.
 *
 * Exercises token::burn — decrements both the source ATA balance AND the
 * mint's total supply. Two account-buffer comparisons catch any
 * divergence in either direction.
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
  createMintToInstruction,
} from "@solana/spl-token";
import {
  defineDifferential,
  anchorIxDiscriminator,
  encodeU64LE,
  concatBytes,
  Keypair,
  PublicKey,
  LiteSVM,
} from "./differential-harness.ts";
import { isTxFailure, txFailureMessage } from "./litesvm-tx-error.ts";

const SRC = join(import.meta.dir, "..", "src", "demo-programs", "spl-burn.rs");
const PROGRAM_ID = "2Ytt3TVz3AyEzWQCuSmoSZPyWqqvrF2Ko64rdWJgfcBN";

defineDifferential({
  fixtureName: "spl-burn",
  programIdBase58: PROGRAM_ID,
  anchorSource: readFileSync(SRC, "utf-8"),
  anchorPackageName: "spl_burn_anchor_diff",
  anchorExtraDeps: `anchor-spl = "0.31"`,

  setup: async () => {
    const payer = Keypair.generate();
    const authority = Keypair.generate();
    const mint = Keypair.generate();
    const fromAta = Keypair.generate();
    return { payer, authority, mint, fromAta };
  },

  callScript: async (svm: LiteSVM, ctx, programId: PublicKey) => {
    svm.withDefaultPrograms().withNativeMints();
    svm.airdrop(ctx.payer.publicKey, BigInt(10_000_000_000));

    const mintRent = svm.minimumBalanceForRentExemption(BigInt(MINT_SIZE));
    const ataRent = svm.minimumBalanceForRentExemption(BigInt(ACCOUNT_SIZE));

    const setupTx = new Transaction()
      .add(SystemProgram.createAccount({
        fromPubkey: ctx.payer.publicKey,
        newAccountPubkey: ctx.mint.publicKey,
        lamports: Number(mintRent),
        space: MINT_SIZE,
        programId: TOKEN_PROGRAM_ID,
      }))
      .add(createInitializeMintInstruction(ctx.mint.publicKey, 6, ctx.authority.publicKey, ctx.authority.publicKey))
      .add(SystemProgram.createAccount({
        fromPubkey: ctx.payer.publicKey,
        newAccountPubkey: ctx.fromAta.publicKey,
        lamports: Number(ataRent),
        space: ACCOUNT_SIZE,
        programId: TOKEN_PROGRAM_ID,
      }))
      .add(createInitializeAccountInstruction(ctx.fromAta.publicKey, ctx.mint.publicKey, ctx.authority.publicKey))
      .add(createMintToInstruction(ctx.mint.publicKey, ctx.fromAta.publicKey, ctx.authority.publicKey, 1_000_000n));
    setupTx.recentBlockhash = svm.latestBlockhash();
    setupTx.feePayer = ctx.payer.publicKey;
    setupTx.sign(ctx.payer, ctx.mint, ctx.fromAta, ctx.authority);
    const r1 = svm.sendTransaction(setupTx);
    if (isTxFailure(r1)) throw new Error(`setup failed: ${txFailureMessage(r1)}`);

    // Burn 300_000 tokens.
    const ix = new TransactionInstruction({
      programId,
      keys: [
        { pubkey: ctx.mint.publicKey, isSigner: false, isWritable: true },
        { pubkey: ctx.fromAta.publicKey, isSigner: false, isWritable: true },
        { pubkey: ctx.authority.publicKey, isSigner: true, isWritable: false },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      ],
      data: Buffer.from(concatBytes(
        anchorIxDiscriminator("do_burn"),
        encodeU64LE(300_000n),
      )),
    });
    const tx = new Transaction().add(ix);
    tx.recentBlockhash = svm.latestBlockhash();
    tx.feePayer = ctx.payer.publicKey;
    tx.sign(ctx.payer, ctx.authority);
    const r2 = svm.sendTransaction(tx);
    if (isTxFailure(r2)) throw new Error(`do_burn failed: ${txFailureMessage(r2)}`);
  },

  stripDiscriminator: false,
  accountsToCompare: (ctx) => [
    { pubkey: ctx.mint.publicKey, label: "mint" },
    { pubkey: ctx.fromAta.publicKey, label: "from_ata" },
  ],
});

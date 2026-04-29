/**
 * Token-2022 transfer_checked differential — eighth fixture.
 *
 * Critical because of the silent-corruption risk: when the emitter can't
 * resolve mint.decimals, it falls back to a 0u8 placeholder with a
 * "TODO: decimals" annotation, which compiles cleanly and runs WITHOUT
 * the on-chain decimals check.
 * The validator catches the literal pattern, but only on programs that
 * hit it. This fixture asserts the byte-equality property at runtime.
 *
 * Setup: Token-2022 mint (program TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEbW),
 * two T22 token accounts, mint to source, transfer_checked between them.
 *
 * If the emit drops the decimals byte, the on-chain T22 program returns
 * an error before mutating either account, so byte-equality already
 * fails for the success path. Robust gate.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  Transaction,
  TransactionInstruction,
  SystemProgram,
} from "@solana/web3.js";
import {
  TOKEN_2022_PROGRAM_ID,
  MINT_SIZE,
  ACCOUNT_SIZE,
  createInitializeMintInstruction,
  createInitializeAccountInstruction,
  createMintToCheckedInstruction,
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

const SRC = join(import.meta.dir, "..", "src", "demo-programs", "t22-transfer.rs");
const PROGRAM_ID = "4bejS8bLDMyJSshuJwWaf73ZKF9EASdUb71Y59E3NQX9";

defineDifferential({
  fixtureName: "t22-transfer",
  programIdBase58: PROGRAM_ID,
  anchorSource: readFileSync(SRC, "utf-8"),
  anchorPackageName: "t22_transfer_anchor_diff",
  anchorExtraDeps: 'anchor-spl = { version = "0.31", features = ["token_2022"] }',

  setup: async () => {
    const payer = Keypair.generate();
    const authority = Keypair.generate();
    const mint = Keypair.generate();
    const fromAta = Keypair.generate();
    const toAta = Keypair.generate();
    return { payer, authority, mint, fromAta, toAta };
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
        programId: TOKEN_2022_PROGRAM_ID,
      }))
      .add(createInitializeMintInstruction(
        ctx.mint.publicKey,
        6,
        ctx.authority.publicKey,
        ctx.authority.publicKey,
        TOKEN_2022_PROGRAM_ID,
      ))
      .add(SystemProgram.createAccount({
        fromPubkey: ctx.payer.publicKey,
        newAccountPubkey: ctx.fromAta.publicKey,
        lamports: Number(ataRent),
        space: ACCOUNT_SIZE,
        programId: TOKEN_2022_PROGRAM_ID,
      }))
      .add(createInitializeAccountInstruction(
        ctx.fromAta.publicKey,
        ctx.mint.publicKey,
        ctx.authority.publicKey,
        TOKEN_2022_PROGRAM_ID,
      ))
      .add(SystemProgram.createAccount({
        fromPubkey: ctx.payer.publicKey,
        newAccountPubkey: ctx.toAta.publicKey,
        lamports: Number(ataRent),
        space: ACCOUNT_SIZE,
        programId: TOKEN_2022_PROGRAM_ID,
      }))
      .add(createInitializeAccountInstruction(
        ctx.toAta.publicKey,
        ctx.mint.publicKey,
        ctx.authority.publicKey,
        TOKEN_2022_PROGRAM_ID,
      ))
      .add(createMintToCheckedInstruction(
        ctx.mint.publicKey,
        ctx.fromAta.publicKey,
        ctx.authority.publicKey,
        500_000n,
        6,
        [],
        TOKEN_2022_PROGRAM_ID,
      ));
    setupTx.recentBlockhash = svm.latestBlockhash();
    setupTx.feePayer = ctx.payer.publicKey;
    setupTx.sign(ctx.payer, ctx.mint, ctx.fromAta, ctx.toAta, ctx.authority);
    const r1 = svm.sendTransaction(setupTx);
    if ("err" in r1) {
      throw new Error("t22 setup failed: " + JSON.stringify(r1));
    }

    const ix = new TransactionInstruction({
      programId,
      keys: [
        { pubkey: ctx.mint.publicKey, isSigner: false, isWritable: false },
        { pubkey: ctx.fromAta.publicKey, isSigner: false, isWritable: true },
        { pubkey: ctx.toAta.publicKey, isSigner: false, isWritable: true },
        { pubkey: ctx.authority.publicKey, isSigner: true, isWritable: false },
        { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false },
      ],
      data: Buffer.from(concatBytes(
        anchorIxDiscriminator("do_transfer"),
        encodeU64LE(120_000n),
      )),
    });
    const tx = new Transaction().add(ix);
    tx.recentBlockhash = svm.latestBlockhash();
    tx.feePayer = ctx.payer.publicKey;
    tx.sign(ctx.payer, ctx.authority);
    const r2 = svm.sendTransaction(tx);
    if ("err" in r2) {
      throw new Error("t22 do_transfer failed: " + JSON.stringify(r2));
    }
  },

  stripDiscriminator: false,
  accountsToCompare: (ctx) => [
    { pubkey: ctx.fromAta.publicKey, label: "from_ata" },
    { pubkey: ctx.toAta.publicKey, label: "to_ata" },
  ],
});

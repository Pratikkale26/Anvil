/**
 * Token-2022 InterestBearingMint differential — EM2 Session 3.
 * Validates cpi_t22_interest_bearing_mint_initialize +
 * cpi_t22_interest_bearing_mint_update_rate.
 *
 * Both Native and Pinocchio fully implement these CPIs (i16 rate +
 * Option<Pubkey> rate_authority — clean payloads). Pinocchio uses
 * hand-rolled discriminator 33+0 / 33+1.
 *
 * Setup: allocate mint with InterestBearingConfig space, run
 * make_bearing(rate=500) → initialize_mint → change_rate(rate=-200).
 * Compare mint state.
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
  ExtensionType,
  getMintLen,
  createInitializeMintInstruction,
} from "@solana/spl-token";
import {
  defineDifferential,
  anchorIxDiscriminator,
  concatBytes,
  Keypair,
  PublicKey,
  LiteSVM,
} from "./differential-harness.ts";

const SRC = join(import.meta.dir, "..", "src", "demo-programs", "t22-interest-bearing.rs");
const PROGRAM_ID = "6wowAPDC2z3aLJQy8yNPrZ7RWSThXpCBTKLgLG12JkaG";

function encodeI16LE(n: number): Uint8Array {
  const buf = new Uint8Array(2);
  new DataView(buf.buffer).setInt16(0, n, true);
  return buf;
}

function expectOk(r: unknown, label: string): void {
  if ((r as { constructor?: { name?: string } })?.constructor?.name === "FailedTransactionMetadata") {
    const meta = (r as { meta?: () => { logs?: () => string[] } }).meta?.();
    throw new Error(`${label} failed | logs=${JSON.stringify(meta?.logs?.() ?? [])}`);
  }
}

defineDifferential({
  fixtureName: "t22-interest-bearing",
  programIdBase58: PROGRAM_ID,
  anchorSource: readFileSync(SRC, "utf-8"),
  anchorPackageName: "t22_ibm_anchor_diff",
  anchorExtraDeps: 'anchor-spl = { version = "0.31", features = ["token_2022"] }',

  setup: async () => ({ payer: Keypair.generate(), mint: Keypair.generate() }),

  callScript: async (svm: LiteSVM, ctx, programId: PublicKey) => {
    svm.withDefaultPrograms().withNativeMints();
    svm.airdrop(ctx.payer.publicKey, BigInt(10_000_000_000));

    const mintLen = getMintLen([ExtensionType.InterestBearingConfig]);
    const mintRent = svm.minimumBalanceForRentExemption(BigInt(mintLen));
    // 1. Allocate mint
    const allocTx = new Transaction().add(
      SystemProgram.createAccount({
        fromPubkey: ctx.payer.publicKey,
        newAccountPubkey: ctx.mint.publicKey,
        lamports: Number(mintRent),
        space: mintLen,
        programId: TOKEN_2022_PROGRAM_ID,
      }),
    );
    allocTx.recentBlockhash = svm.latestBlockhash();
    allocTx.feePayer = ctx.payer.publicKey;
    allocTx.sign(ctx.payer, ctx.mint);
    expectOk(svm.sendTransaction(allocTx), "alloc mint");

    // 2. make_bearing(rate=500) — InterestBearingConfig + payer as rate_authority
    const initIx = new TransactionInstruction({
      programId,
      keys: [
        { pubkey: ctx.payer.publicKey, isSigner: true, isWritable: false },
        { pubkey: ctx.mint.publicKey, isSigner: false, isWritable: true },
        { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false },
      ],
      data: Buffer.from(
        concatBytes(anchorIxDiscriminator("make_bearing"), encodeI16LE(500)),
      ),
    });
    const initTx = new Transaction().add(initIx);
    initTx.recentBlockhash = svm.latestBlockhash();
    initTx.feePayer = ctx.payer.publicKey;
    initTx.sign(ctx.payer);
    expectOk(svm.sendTransaction(initTx), "make_bearing");

    // 3. Init base mint
    const mintInitTx = new Transaction().add(
      createInitializeMintInstruction(
        ctx.mint.publicKey, 2, ctx.payer.publicKey, ctx.payer.publicKey, TOKEN_2022_PROGRAM_ID,
      ),
    );
    mintInitTx.recentBlockhash = svm.latestBlockhash();
    mintInitTx.feePayer = ctx.payer.publicKey;
    mintInitTx.sign(ctx.payer);
    expectOk(svm.sendTransaction(mintInitTx), "initialize_mint");

    // 4. change_rate(rate=-200)
    const updateIx = new TransactionInstruction({
      programId,
      keys: [
        { pubkey: ctx.payer.publicKey, isSigner: true, isWritable: false },
        { pubkey: ctx.mint.publicKey, isSigner: false, isWritable: true },
        { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false },
      ],
      data: Buffer.from(
        concatBytes(anchorIxDiscriminator("change_rate"), encodeI16LE(-200)),
      ),
    });
    const updateTx = new Transaction().add(updateIx);
    updateTx.recentBlockhash = svm.latestBlockhash();
    updateTx.feePayer = ctx.payer.publicKey;
    updateTx.sign(ctx.payer);
    expectOk(svm.sendTransaction(updateTx), "change_rate");
  },

  stripDiscriminator: false,
  accountsToCompare: (ctx) => [{ pubkey: ctx.mint.publicKey, label: "mint" }],
});

/**
 * SPL transfer differential — fourth fixture.
 *
 * Exercises a target Anvil hasn't proven yet at runtime: token::transfer
 * via CpiContext::new (unsigned form). If the emit's account ordering or
 * amount encoding drifts, both ATA byte-buffers diverge.
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
import {
  createMintIxs,
  createTokenAccountIxs,
  mintToIx,
  sendSetupTx,
} from "./differential-setup-helpers.ts";
import { isTxFailure, txFailureMessage } from "./litesvm-tx-error.ts";

const SRC = join(import.meta.dir, "..", "src", "demo-programs", "spl-transfer.rs");
const PROGRAM_ID = "2GMS2v2T4wqDwkfuZSmDcTKffxRKd63879ofy5J6vT34";

defineDifferential({
  fixtureName: "spl-transfer",
  programIdBase58: PROGRAM_ID,
  anchorSource: readFileSync(SRC, "utf-8"),
  anchorPackageName: "spl_transfer_anchor_diff",
  anchorExtraDeps: `anchor-spl = "0.31"`,

  setup: async () => {
    const payer = Keypair.generate();
    const authority = Keypair.generate();
    const mint = Keypair.generate();
    // Two regular token accounts (not ATAs) so we can preallocate them
    // ourselves and predict their addresses without depending on the
    // ATA-derivation path being correct in the emit.
    const fromAta = Keypair.generate();
    const toAta = Keypair.generate();
    return { payer, authority, mint, fromAta, toAta };
  },

  callScript: async (svm: LiteSVM, ctx, programId: PublicKey) => {
    svm.withDefaultPrograms().withNativeMints();
    svm.airdrop(ctx.payer.publicKey, BigInt(10_000_000_000));

    // Allocate + initialize mint, both token accounts, mint to source.
    const setupTx = new Transaction()
      .add(...createMintIxs(svm, ctx.payer.publicKey, ctx.mint.publicKey, 6, ctx.authority.publicKey, ctx.authority.publicKey))
      .add(...createTokenAccountIxs(svm, ctx.payer.publicKey, ctx.fromAta.publicKey, ctx.mint.publicKey, ctx.authority.publicKey))
      .add(...createTokenAccountIxs(svm, ctx.payer.publicKey, ctx.toAta.publicKey, ctx.mint.publicKey, ctx.authority.publicKey))
      .add(mintToIx(ctx.mint.publicKey, ctx.fromAta.publicKey, ctx.authority.publicKey, 1_000_000n));
    sendSetupTx(svm, setupTx, ctx.payer.publicKey,
      [ctx.payer, ctx.mint, ctx.fromAta, ctx.toAta, ctx.authority],
      "setup");

    // 2. Transfer 250_000 tokens from → to via the program.
    const ix = new TransactionInstruction({
      programId,
      keys: [
        { pubkey: ctx.fromAta.publicKey, isSigner: false, isWritable: true },
        { pubkey: ctx.toAta.publicKey, isSigner: false, isWritable: true },
        { pubkey: ctx.authority.publicKey, isSigner: true, isWritable: false },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      ],
      data: Buffer.from(concatBytes(
        anchorIxDiscriminator("do_transfer"),
        encodeU64LE(250_000n),
      )),
    });
    const tx = new Transaction().add(ix);
    tx.recentBlockhash = svm.latestBlockhash();
    tx.feePayer = ctx.payer.publicKey;
    tx.sign(ctx.payer, ctx.authority);
    const r2 = svm.sendTransaction(tx);
    if (isTxFailure(r2)) throw new Error(`do_transfer failed: ${txFailureMessage(r2)}`);
  },

  stripDiscriminator: false,
  accountsToCompare: (ctx) => [
    { pubkey: ctx.fromAta.publicKey, label: "from_ata" },
    { pubkey: ctx.toAta.publicKey, label: "to_ata" },
  ],
});

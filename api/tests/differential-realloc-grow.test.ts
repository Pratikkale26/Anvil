/**
 * Realloc grow differential — multi-step variant.
 *
 * Same emit shape as differential-realloc.test.ts but exercises THREE
 * grow calls in sequence: 13 → 14 → 16 → 20 bytes. The byte-equal gate
 * validates rent-delta correctness across multiple realloc CPIs (each
 * computes its own delta vs the previous lamport balance) and that
 * realloc::zero=true zero-fills the new region identically.
 *
 * Native target only — Pinocchio's AccountInfo doesn't expose realloc.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  Transaction, TransactionInstruction, SystemProgram,
} from "@solana/web3.js";
import {
  defineDifferential,
  anchorIxDiscriminator,
  concatBytes,
  Keypair,
  PublicKey,
  LiteSVM,
} from "./differential-harness.ts";

const SRC = join(import.meta.dir, "..", "src", "demo-programs", "realloc-grow.rs");
const PROGRAM_ID = "rea11ocgrow11111111111111111111111111111111";

defineDifferential({
  fixtureName: "realloc-grow",
  programIdBase58: PROGRAM_ID,
  anchorSource: readFileSync(SRC, "utf-8"),
  anchorPackageName: "realloc_grow_anchor_diff",
  anvilTarget: "native",

  setup: async () => {
    const owner = Keypair.generate();
    const programId = new PublicKey(PROGRAM_ID);
    const [statePda] = PublicKey.findProgramAddressSync(
      [Buffer.from("realloc-grow"), owner.publicKey.toBuffer()],
      programId,
    );
    return { owner, statePda };
  },

  callScript: async (svm: LiteSVM, ctx, programId: PublicKey) => {
    svm.airdrop(ctx.owner.publicKey, BigInt(2_000_000_000));

    const initIx = new TransactionInstruction({
      programId,
      keys: [
        { pubkey: ctx.statePda, isSigner: false, isWritable: true },
        { pubkey: ctx.owner.publicKey, isSigner: true, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data: Buffer.from(anchorIxDiscriminator("init")),
    });

    const buildIx = (name: string, payload: Uint8Array) =>
      new TransactionInstruction({
        programId,
        keys: [
          { pubkey: ctx.statePda, isSigner: false, isWritable: true },
          { pubkey: ctx.owner.publicKey, isSigner: true, isWritable: true },
          { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        ],
        data: Buffer.from(concatBytes(anchorIxDiscriminator(name), payload)),
      });

    const append1 = buildIx("append_one", new Uint8Array([0x10]));
    const append2 = buildIx("append_two", new Uint8Array([0x20, 0x21]));
    const append4 = buildIx("append_four", new Uint8Array([0x30, 0x31, 0x32, 0x33]));

    for (const ix of [initIx, append1, append2, append4]) {
      const tx = new Transaction().add(ix);
      tx.recentBlockhash = svm.latestBlockhash();
      tx.feePayer = ctx.owner.publicKey;
      tx.sign(ctx.owner);
      const r = svm.sendTransaction(tx);
      if (r?.constructor?.name === "FailedTransactionMetadata") {
        const failed = r as unknown as {
          err: () => { toString(): string };
          meta: () => { logs: () => string[] };
        };
        throw new Error(`tx failed: ${failed.err().toString()}\nlogs:\n${failed.meta().logs().join("\n")}`);
      }
    }
  },

  accountsToCompare: (ctx) => [
    { pubkey: ctx.statePda, label: "state_pda" },
  ],
});

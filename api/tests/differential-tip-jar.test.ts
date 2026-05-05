/**
 * tip-jar differential.
 *
 * Lamport-flow demo: owner creates a PDA jar, anyone tips SOL via
 * system_program::transfer. The jar's lamport balance IS the running
 * total. Asserts byte-equal on (a) account data after create + (b)
 * lamport balance after 3 sequential tips from different tippers.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Transaction, TransactionInstruction, SystemProgram } from "@solana/web3.js";
import {
  defineDifferential,
  anchorIxDiscriminator,
  encodeU64LE,
  concatBytes,
  Keypair,
  PublicKey,
  LiteSVM,
} from "./differential-harness.ts";

const SRC = join(import.meta.dir, "..", "src", "demo-programs", "tip-jar.rs");
const PROGRAM_ID = "TipJar1111111111111111111111111111111111111";

defineDifferential({
  fixtureName: "tip-jar",
  programIdBase58: PROGRAM_ID,
  anchorSource: readFileSync(SRC, "utf-8"),
  anchorPackageName: "tip_jar_anchor_diff",

  setup: async () => {
    const owner = Keypair.generate();
    const tipper1 = Keypair.generate();
    const tipper2 = Keypair.generate();
    const programId = new PublicKey(PROGRAM_ID);
    const [jarPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("jar"), owner.publicKey.toBuffer()],
      programId,
    );
    return { owner, tipper1, tipper2, jarPda };
  },

  callScript: async (svm: LiteSVM, ctx, programId: PublicKey) => {
    svm.airdrop(ctx.owner.publicKey, BigInt(2_000_000_000));
    svm.airdrop(ctx.tipper1.publicKey, BigInt(1_000_000_000));
    svm.airdrop(ctx.tipper2.publicKey, BigInt(1_000_000_000));

    const createIx = new TransactionInstruction({
      programId,
      keys: [
        { pubkey: ctx.jarPda, isSigner: false, isWritable: true },
        { pubkey: ctx.owner.publicKey, isSigner: true, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data: Buffer.from(anchorIxDiscriminator("create_jar")),
    });

    const tipIx = (tipper: Keypair, amount: bigint) => new TransactionInstruction({
      programId,
      keys: [
        { pubkey: ctx.jarPda, isSigner: false, isWritable: true },
        { pubkey: tipper.publicKey, isSigner: true, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data: Buffer.from(concatBytes(
        anchorIxDiscriminator("tip"),
        encodeU64LE(amount),
      )),
    });

    // Create jar (owner signs)
    {
      const tx = new Transaction().add(createIx);
      tx.recentBlockhash = svm.latestBlockhash();
      tx.feePayer = ctx.owner.publicKey;
      tx.sign(ctx.owner);
      const r = svm.sendTransaction(tx);
      if ("err" in r) throw new Error(`create_jar failed: ${JSON.stringify(r.err)}`);
    }

    // Tipper1 tips 100k
    for (const [signer, amount] of [
      [ctx.tipper1, 100_000n],
      [ctx.tipper2, 250_000n],
      [ctx.tipper1, 50_000n],
    ] as const) {
      const tx = new Transaction().add(tipIx(signer, amount));
      tx.recentBlockhash = svm.latestBlockhash();
      tx.feePayer = signer.publicKey;
      tx.sign(signer);
      const r = svm.sendTransaction(tx);
      if ("err" in r) throw new Error(`tip failed: ${JSON.stringify(r.err)}`);
    }
  },

  accountsToCompare: (ctx) => [
    { pubkey: ctx.jarPda, label: "jar_pda" },
  ],
});

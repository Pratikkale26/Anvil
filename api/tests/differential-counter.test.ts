/**
 * Counter differential — first fixture, smallest surface.
 *
 * Exercises: account init, PDA derivation, simple u64 state mutation.
 * No SPL, no signer seeds, no CPI. If this fails, every other fixture
 * will fail, so it stays first in the suite.
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

const COUNTER_SRC = join(import.meta.dir, "..", "src", "demo-programs", "counter.rs");
const PROGRAM_ID = "Counter111111111111111111111111111111111111";

defineDifferential({
  fixtureName: "counter",
  programIdBase58: PROGRAM_ID,
  anchorSource: readFileSync(COUNTER_SRC, "utf-8"),
  anchorPackageName: "counter_anchor_diff",

  setup: async () => {
    const authority = Keypair.generate();
    const programId = new PublicKey(PROGRAM_ID);
    const [counterPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("counter"), authority.publicKey.toBuffer()],
      programId,
    );
    return { authority, counterPda };
  },

  callScript: async (svm: LiteSVM, ctx, programId: PublicKey) => {
    svm.airdrop(ctx.authority.publicKey, BigInt(1_000_000_000));

    const initIx = new TransactionInstruction({
      programId,
      keys: [
        { pubkey: ctx.counterPda, isSigner: false, isWritable: true },
        { pubkey: ctx.authority.publicKey, isSigner: true, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data: Buffer.from(concatBytes(anchorIxDiscriminator("initialize"), encodeU64LE(10n))),
    });
    const incIx = new TransactionInstruction({
      programId,
      keys: [
        { pubkey: ctx.counterPda, isSigner: false, isWritable: true },
        { pubkey: ctx.authority.publicKey, isSigner: true, isWritable: false },
      ],
      data: Buffer.from(concatBytes(anchorIxDiscriminator("increment"), encodeU64LE(5n))),
    });

    for (const ix of [initIx, incIx]) {
      const tx = new Transaction().add(ix);
      tx.recentBlockhash = svm.latestBlockhash();
      tx.feePayer = ctx.authority.publicKey;
      tx.sign(ctx.authority);
      const r = svm.sendTransaction(tx);
      if ("err" in r) throw new Error(`tx failed: ${JSON.stringify(r.err)}`);
    }
  },

  accountsToCompare: (ctx) => [
    { pubkey: ctx.counterPda, label: "counter_pda" },
  ],
});

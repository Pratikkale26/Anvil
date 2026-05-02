/**
 * Event emit differential — sol_log_data byte-equality.
 *
 * The first fixture to set compareEventLogs: true. Validates that
 * Anvil's emit!() lowering produces sol_log_data lines byte-identical
 * to Anchor's macro expansion. Without this, programs using emit!()
 * could pass the data+lamports+owner gate but emit different events,
 * silently breaking off-chain indexers.
 *
 * Scenario: init counter PDA, increment by 5, increment by 3.
 * Each increment emits Incremented { new_value, delta }. The two
 * `Program data: <base64>` lines (one per increment) must byte-equal
 * across Anchor + Anvil-Pinocchio.
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

const SRC = join(import.meta.dir, "..", "src", "demo-programs", "event-emit.rs");
const PROGRAM_ID = "evMit11111111111111111111111111111111111111";

defineDifferential({
  fixtureName: "event-emit",
  programIdBase58: PROGRAM_ID,
  anchorSource: readFileSync(SRC, "utf-8"),
  anchorPackageName: "event_emit_anchor_diff",
  compareEventLogs: true,

  setup: async () => {
    const authority = Keypair.generate();
    const programId = new PublicKey(PROGRAM_ID);
    const [counterPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("evt-counter"), authority.publicKey.toBuffer()],
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
      data: Buffer.from(anchorIxDiscriminator("initialize")),
    });
    const incrIx = (amount: bigint) =>
      new TransactionInstruction({
        programId,
        keys: [
          { pubkey: ctx.counterPda, isSigner: false, isWritable: true },
          { pubkey: ctx.authority.publicKey, isSigner: true, isWritable: false },
        ],
        data: Buffer.from(concatBytes(anchorIxDiscriminator("increment"), encodeU64LE(amount))),
      });

    for (const ix of [initIx, incrIx(5n), incrIx(3n)]) {
      const tx = new Transaction().add(ix);
      tx.recentBlockhash = svm.latestBlockhash();
      tx.feePayer = ctx.authority.publicKey;
      tx.sign(ctx.authority);
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
    { pubkey: ctx.counterPda, label: "counter_pda" },
  ],
});

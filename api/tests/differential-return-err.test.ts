/**
 * return-err differential — covers the `return_err` BodyStatement kind.
 * Initializes the state once with a non-zero value (success path), then
 * exercises the try_set+0 case which hits the early `return Err(...)`. We
 * compare the post-state account; both runs should leave it byte-equal at
 * the value set in step 1, since the failed tx in step 2 leaves state
 * untouched. M3 coverage fixture.
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

const SRC = join(import.meta.dir, "..", "src", "demo-programs", "return-err.rs");
const PROGRAM_ID = "ReturnErr1111111111111111111111111111111111";

defineDifferential({
  fixtureName: "return-err",
  programIdBase58: PROGRAM_ID,
  anchorSource: readFileSync(SRC, "utf-8"),
  anchorPackageName: "return_err_anchor_diff",
  // init_if_needed is gated behind a Cargo feature, plus an alphanumeric
  // matching declare_id — the harness handles both.
  anchorLangFeatures: ["init-if-needed"],

  setup: async () => {
    const authority = Keypair.generate();
    const programId = new PublicKey(PROGRAM_ID);
    const [statePda] = PublicKey.findProgramAddressSync(
      [Buffer.from("return-err"), authority.publicKey.toBuffer()],
      programId,
    );
    return { authority, statePda };
  },

  callScript: async (svm: LiteSVM, ctx, programId: PublicKey) => {
    svm.airdrop(ctx.authority.publicKey, BigInt(1_000_000_000));
    const send = (data: Buffer, label: string, expectFail = false) => {
      const tx = new Transaction().add(new TransactionInstruction({
        programId,
        keys: [
          { pubkey: ctx.statePda, isSigner: false, isWritable: true },
          { pubkey: ctx.authority.publicKey, isSigner: true, isWritable: true },
          { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        ],
        data,
      }));
      tx.recentBlockhash = svm.latestBlockhash();
      tx.feePayer = ctx.authority.publicKey;
      tx.sign(ctx.authority);
      const r = svm.sendTransaction(tx);
      const failed = r?.constructor?.name === "FailedTransactionMetadata";
      if (failed && !expectFail) {
        const f = r as unknown as { err: () => { toString(): string } };
        throw new Error(`${label} unexpectedly failed: ${f.err().toString()}`);
      }
      if (!failed && expectFail) {
        throw new Error(`${label} unexpectedly succeeded`);
      }
    };

    // Step 1: try_set(42) — succeeds, initializes state with value=42.
    send(
      Buffer.from(concatBytes(anchorIxDiscriminator("try_set"), encodeU64LE(42n))),
      "try_set(42)",
    );
    // Step 2: try_set(0) — early `return Err(...)`. Tx fails; state stays at 42.
    send(
      Buffer.from(concatBytes(anchorIxDiscriminator("try_set"), encodeU64LE(0n))),
      "try_set(0)",
      /*expectFail*/ true,
    );
  },

  accountsToCompare: (ctx) => [{ pubkey: ctx.statePda, label: "state" }],
});

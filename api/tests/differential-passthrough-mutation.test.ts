/**
 * pass-through state-mutation silent-loss (prod-readiness eval 2026-06-21, #11).
 *
 * `mutate` writes state fields via idioms with no `acc.field =` on the surface:
 *   - `acc.blob.copy_from_slice(&value.to_le_bytes())`  (slice mutator)
 *   - `let r = &mut acc.counter; *r = r.wrapping_add(value)`  (&mut deref)
 *
 * Pre-fix detectPassThroughStateMutations (an allowlist) matched neither, so the
 * hoisted `Blob::write` writeback was skipped → the mutation was computed in a
 * local and never persisted. Anchor writes back every `mut` account, so the
 * post-state diverged. Fails on HEAD (blob/counter stay zero), byte-equal on fix.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Transaction, TransactionInstruction, SystemProgram } from "@solana/web3.js";
import {
  defineDifferential,
  anchorIxDiscriminator,
  Keypair,
  PublicKey,
  LiteSVM,
} from "./differential-harness.ts";

const SRC = join(import.meta.dir, "..", "src", "demo-programs", "passthrough-mutation.rs");
const PROGRAM_ID = "PassMut111111111111111111111111111111111111";
const VALUE = 0x1122334455667788n;

defineDifferential({
  fixtureName: "passthrough-mutation",
  programIdBase58: PROGRAM_ID,
  anchorSource: readFileSync(SRC, "utf-8"),
  anchorPackageName: "passthrough_mutation_anchor_diff",

  setup: async () => {
    const payer = Keypair.generate();
    const acc = Keypair.generate();
    return { payer, acc };
  },

  callScript: async (svm: LiteSVM, ctx, programId: PublicKey) => {
    svm.airdrop(ctx.payer.publicKey, BigInt(1_000_000_000));

    // initialize(acc) — acc is a fresh keypair-backed init account.
    const initIx = new TransactionInstruction({
      programId,
      keys: [
        { pubkey: ctx.acc.publicKey, isSigner: true, isWritable: true },
        { pubkey: ctx.payer.publicKey, isSigner: true, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data: Buffer.from(anchorIxDiscriminator("initialize")),
    });
    const initTx = new Transaction().add(initIx);
    initTx.recentBlockhash = svm.latestBlockhash();
    initTx.feePayer = ctx.payer.publicKey;
    initTx.sign(ctx.payer, ctx.acc);
    const r1 = svm.sendTransaction(initTx);
    if (r1?.constructor?.name === "FailedTransactionMetadata") {
      throw new Error(`init failed: ${(r1 as any).err().toString()}`);
    }

    // mutate(value) — value is a u64 LE arg appended to the discriminator.
    const arg = Buffer.alloc(8);
    arg.writeBigUInt64LE(VALUE);
    const mutIx = new TransactionInstruction({
      programId,
      keys: [{ pubkey: ctx.acc.publicKey, isSigner: false, isWritable: true }],
      data: Buffer.concat([Buffer.from(anchorIxDiscriminator("mutate")), arg]),
    });
    const mutTx = new Transaction().add(mutIx);
    mutTx.recentBlockhash = svm.latestBlockhash();
    mutTx.feePayer = ctx.payer.publicKey;
    mutTx.sign(ctx.payer);
    const r2 = svm.sendTransaction(mutTx);
    if (r2?.constructor?.name === "FailedTransactionMetadata") {
      throw new Error(`mutate failed: ${(r2 as any).err().toString()}`);
    }
  },

  accountsToCompare: (ctx) => [{ pubkey: ctx.acc.publicKey, label: "acc" }],
});

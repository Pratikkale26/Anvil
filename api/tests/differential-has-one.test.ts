/**
 * has_one constraint differential — sixth fixture.
 *
 * Exercises the runtime check Anchor's `has_one = owner` injects: at
 * the start of `bump_value`, the program must verify
 * `safe.owner == owner.key`. Anvil's emit produces the equivalent
 * if-guard. The post-instruction state of the safe account must
 * byte-equal between the two.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  Transaction,
  TransactionInstruction,
  SystemProgram,
} from "@solana/web3.js";
import {
  defineDifferential,
  anchorIxDiscriminator,
  encodeU64LE,
  concatBytes,
  Keypair,
  PublicKey,
  LiteSVM,
} from "./differential-harness.ts";

const SRC = join(import.meta.dir, "..", "src", "demo-programs", "has-one.rs");
const PROGRAM_ID = "Absfps8DboaQrCi71THcW4r1CuhrQLokx6DVufbnDmUZ";

defineDifferential({
  fixtureName: "has-one",
  programIdBase58: PROGRAM_ID,
  anchorSource: readFileSync(SRC, "utf-8"),
  anchorPackageName: "has_one_anchor_diff",

  setup: async () => {
    const owner = Keypair.generate();
    const safe = Keypair.generate();
    return { owner, safe };
  },

  callScript: async (svm: LiteSVM, ctx, programId: PublicKey) => {
    svm.airdrop(ctx.owner.publicKey, BigInt(2_000_000_000));

    const initIx = new TransactionInstruction({
      programId,
      keys: [
        { pubkey: ctx.safe.publicKey, isSigner: true, isWritable: true },
        { pubkey: ctx.owner.publicKey, isSigner: true, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data: Buffer.from(anchorIxDiscriminator("initialize")),
    });
    const bumpIx = new TransactionInstruction({
      programId,
      keys: [
        { pubkey: ctx.safe.publicKey, isSigner: false, isWritable: true },
        { pubkey: ctx.owner.publicKey, isSigner: true, isWritable: false },
      ],
      data: Buffer.from(concatBytes(
        anchorIxDiscriminator("bump_value"),
        encodeU64LE(42n),
      )),
    });

    const tx1 = new Transaction().add(initIx);
    tx1.recentBlockhash = svm.latestBlockhash();
    tx1.feePayer = ctx.owner.publicKey;
    tx1.sign(ctx.owner, ctx.safe);
    const r1 = svm.sendTransaction(tx1);
    if ("err" in r1) throw new Error(`init failed: ${JSON.stringify(r1.err)}`);

    const tx2 = new Transaction().add(bumpIx);
    tx2.recentBlockhash = svm.latestBlockhash();
    tx2.feePayer = ctx.owner.publicKey;
    tx2.sign(ctx.owner);
    const r2 = svm.sendTransaction(tx2);
    if ("err" in r2) throw new Error(`bump failed: ${JSON.stringify(r2.err)}`);
  },

  accountsToCompare: (ctx) => [
    { pubkey: ctx.safe.publicKey, label: "safe" },
  ],
});

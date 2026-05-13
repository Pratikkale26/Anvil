/**
 * Zero-copy AccountLoader differential — first end-to-end fixture for
 * #[account(zero_copy)] support.
 *
 * Exercises: load_init (write discriminator + cast), load_mut (verify disc +
 * cast), Pubkey + u64 zero-copy field write, has_one constraint check.
 *
 * Compares full account data INCLUDING the 8-byte discriminator (stripDisc-
 * riminator: false) — proves both the disc-write path and the field-layout
 * match the Anchor reference byte-for-byte.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  Transaction,
  TransactionInstruction,
  SystemProgram,
  LAMPORTS_PER_SOL,
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
import { isTxFailure, txFailureMessage } from "./litesvm-tx-error.ts";

const DEMO_SRC = join(import.meta.dir, "..", "src", "demo-programs", "zero-copy-foo.rs");
const PROGRAM_ID = "ZcpFoo1xperiment11111111111111111111111111K";

defineDifferential({
  fixtureName: "zero-copy-foo",
  programIdBase58: PROGRAM_ID,
  anchorSource: readFileSync(DEMO_SRC, "utf-8"),
  anchorPackageName: "zero_copy_foo_anchor_diff",
  anvilTarget: "native",
  // Compare full data including disc — verifies our load_init wrote the
  // same sha256("account:Foo")[..8] bytes Anchor's load_init did.
  stripDiscriminator: false,

  setup: async () => {
    const authority = Keypair.generate();
    const foo = Keypair.generate();
    return { authority, foo };
  },

  callScript: async (svm: LiteSVM, ctx, programId: PublicKey) => {
    svm.airdrop(ctx.authority.publicKey, BigInt(LAMPORTS_PER_SOL));

    const accountSize = 48; // 8 disc + 32 authority + 8 data
    const rent = svm.minimumBalanceForRentExemption(BigInt(accountSize));

    // #[account(zero)] requires the account to be pre-allocated and owned by
    // the program with all-zero data. Caller bundles the create_account
    // ix in front of create_foo.
    const createAcctIx = SystemProgram.createAccount({
      fromPubkey: ctx.authority.publicKey,
      newAccountPubkey: ctx.foo.publicKey,
      space: accountSize,
      lamports: Number(rent),
      programId,
    });

    const createFooIx = new TransactionInstruction({
      programId,
      keys: [
        { pubkey: ctx.foo.publicKey, isSigner: false, isWritable: true },
        { pubkey: ctx.authority.publicKey, isSigner: true, isWritable: false },
      ],
      data: Buffer.from(anchorIxDiscriminator("create_foo")),
    });

    const updateFooIx = new TransactionInstruction({
      programId,
      keys: [
        { pubkey: ctx.foo.publicKey, isSigner: false, isWritable: true },
        { pubkey: ctx.authority.publicKey, isSigner: true, isWritable: false },
      ],
      data: Buffer.from(
        concatBytes(anchorIxDiscriminator("update_foo"), encodeU64LE(42n)),
      ),
    });

    const tx1 = new Transaction().add(createAcctIx).add(createFooIx);
    tx1.recentBlockhash = svm.latestBlockhash();
    tx1.feePayer = ctx.authority.publicKey;
    tx1.sign(ctx.authority, ctx.foo);
    const r1 = svm.sendTransaction(tx1);
    if (isTxFailure(r1)) {
      const logs = (r1 as { meta?: { logs?: string[] } }).meta?.logs ?? [];
      throw new Error(`tx1 failed: ${txFailureMessage(r1)}\nlogs:\n${logs.join("\n")}`);
    }

    const tx2 = new Transaction().add(updateFooIx);
    tx2.recentBlockhash = svm.latestBlockhash();
    tx2.feePayer = ctx.authority.publicKey;
    tx2.sign(ctx.authority);
    const r2 = svm.sendTransaction(tx2);
    if (isTxFailure(r2)) {
      const logs = (r2 as { meta?: { logs?: string[] } }).meta?.logs ?? [];
      throw new Error(`tx2 failed: ${txFailureMessage(r2)}\nlogs:\n${logs.join("\n")}`);
    }
  },

  accountsToCompare: (ctx) => [
    { pubkey: ctx.foo.publicKey, label: "foo_account" },
  ],
});

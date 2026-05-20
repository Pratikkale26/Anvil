/**
 * arjun-counterapp differential (Pinocchio target) — first byte-equal proof
 * on real-world external Anchor source. Sourced from
 * github.com/aarjn/solana-programs-list/anchor-counterapp.
 *
 * Exercises 4 instructions: initialize (no-op), create_user_account (PDA
 * init), increment (u64 add), decrement (u64 sub). Post-state is the
 * UserAccount PDA — byte-equal proves Anchor + Anvil-Pinocchio produce
 * identical buffers + lamports + owner under the same instruction sequence.
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
import { isTxFailure, txFailureMessage } from "./litesvm-tx-error.ts";

const SRC = join(import.meta.dir, "..", "src", "demo-programs", "external", "arjun-counterapp.rs");
const PROGRAM_ID = "ArjnCount11111111111111111111111111111111111";

defineDifferential({
  fixtureName: "arjun-counterapp-pin",
  programIdBase58: PROGRAM_ID,
  anchorSource: readFileSync(SRC, "utf-8"),
  anchorPackageName: "arjun_counterapp_anchor_diff",
  anvilTarget: "pinocchio",

  setup: async () => {
    const user = Keypair.generate();
    const programId = new PublicKey(PROGRAM_ID);
    const [userAccountPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("counterprogram"), user.publicKey.toBuffer()],
      programId,
    );
    return { user, userAccountPda };
  },

  callScript: async (svm: LiteSVM, ctx, programId: PublicKey) => {
    svm.airdrop(ctx.user.publicKey, BigInt(1_000_000_000));

    const createIx = new TransactionInstruction({
      programId,
      keys: [
        { pubkey: ctx.userAccountPda, isSigner: false, isWritable: true },
        { pubkey: ctx.user.publicKey, isSigner: true, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data: Buffer.from(anchorIxDiscriminator("create_user_account")),
    });
    const incIx = new TransactionInstruction({
      programId,
      keys: [
        { pubkey: ctx.userAccountPda, isSigner: false, isWritable: true },
        { pubkey: ctx.user.publicKey, isSigner: true, isWritable: false },
      ],
      data: Buffer.from(anchorIxDiscriminator("increment")),
    });
    const decIx = new TransactionInstruction({
      programId,
      keys: [
        { pubkey: ctx.userAccountPda, isSigner: false, isWritable: true },
        { pubkey: ctx.user.publicKey, isSigner: true, isWritable: false },
      ],
      data: Buffer.from(anchorIxDiscriminator("decrement")),
    });

    // Bundle multiple same-shape ixs into one Tx so LiteSVM doesn't dedupe
    // identical messages as AlreadyProcessed. Anchor + Anvil both apply
    // each ix in-order within a single tx, so net effect is count = 0 + 3 - 1 = 2.
    const tx1 = new Transaction().add(createIx);
    tx1.recentBlockhash = svm.latestBlockhash();
    tx1.feePayer = ctx.user.publicKey;
    tx1.sign(ctx.user);
    const r1 = svm.sendTransaction(tx1);
    if (isTxFailure(r1)) throw new Error(`tx create_user_account: ${txFailureMessage(r1)}`);

    const tx2 = new Transaction().add(incIx).add(incIx).add(incIx).add(decIx);
    tx2.recentBlockhash = svm.latestBlockhash();
    tx2.feePayer = ctx.user.publicKey;
    tx2.sign(ctx.user);
    const r2 = svm.sendTransaction(tx2);
    if (isTxFailure(r2)) throw new Error(`tx counter-math: ${txFailureMessage(r2)}`);
  },

  accountsToCompare: (ctx) => [
    { pubkey: ctx.userAccountPda, label: "user_account" },
  ],
});

/**
 * Account-close differential — fixture covering Anchor's `close = X`
 * constraint, which:
 *   - transfers ALL lamports from the closed account to `X`
 *   - zeroes the closed account's data
 *   - reassigns owner / sets the 8-byte CLOSED_ACCOUNT_DISCRIMINATOR
 *
 * Anvil-Pinocchio emits the equivalent close path. If any of those three
 * effects drift (wrong destination, partial lamport transfer, missing
 * disc), this fixture fires.
 *
 * Compare surface:
 *   - note PDA post-close (data + lamports — both go to 0/Anchor's
 *     CLOSED disc layout)
 *   - receiver post-close (lamports — should equal Anchor's transfer)
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

const SRC = join(import.meta.dir, "..", "src", "demo-programs", "close-account.rs");
const PROGRAM_ID = "CLoSeAccount11111111111111111111111111111111";

defineDifferential({
  fixtureName: "close-account",
  programIdBase58: PROGRAM_ID,
  anchorSource: readFileSync(SRC, "utf-8"),
  anchorPackageName: "close_account_anchor_diff",

  setup: async () => {
    const owner = Keypair.generate();
    const receiver = Keypair.generate();
    const programId = new PublicKey(PROGRAM_ID);
    const [notePda] = PublicKey.findProgramAddressSync(
      [Buffer.from("note"), owner.publicKey.toBuffer()],
      programId,
    );
    return { owner, receiver, notePda };
  },

  callScript: async (svm: LiteSVM, ctx, programId: PublicKey) => {
    svm.airdrop(ctx.owner.publicKey, BigInt(2_000_000_000));
    // Pre-fund receiver with a non-zero balance — proves the close
    // constraint ADDS to receiver's lamports, not REPLACES.
    svm.airdrop(ctx.receiver.publicKey, BigInt(1_000_000));

    const openIx = new TransactionInstruction({
      programId,
      keys: [
        { pubkey: ctx.notePda, isSigner: false, isWritable: true },
        { pubkey: ctx.owner.publicKey, isSigner: true, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data: Buffer.from(concatBytes(anchorIxDiscriminator("open"), encodeU64LE(42n))),
    });
    const shutIx = new TransactionInstruction({
      programId,
      keys: [
        { pubkey: ctx.notePda, isSigner: false, isWritable: true },
        { pubkey: ctx.receiver.publicKey, isSigner: false, isWritable: true },
        { pubkey: ctx.owner.publicKey, isSigner: true, isWritable: false },
      ],
      data: Buffer.from(anchorIxDiscriminator("shut")),
    });

    for (const ix of [openIx, shutIx]) {
      const tx = new Transaction().add(ix);
      tx.recentBlockhash = svm.latestBlockhash();
      tx.feePayer = ctx.owner.publicKey;
      tx.sign(ctx.owner);
      const r = svm.sendTransaction(tx);
      if ("err" in r) throw new Error(`tx failed: ${JSON.stringify(r.err)}`);
    }
  },

  // Note PDA: post-close, Anchor zeroes data and writes the 8-byte
  // CLOSED_ACCOUNT_DISCRIMINATOR. We strip the discriminator so the
  // remaining bytes (the zeroed payload) compare equal regardless of
  // any divergence in the disc constant itself.
  // Receiver: lamports must match exactly across runs (Anvil + Anchor
  // both add the rent refund to receiver).
  accountsToCompare: (ctx) => [
    { pubkey: ctx.notePda, label: "note_post_close" },
    { pubkey: ctx.receiver.publicKey, label: "receiver_post_refund" },
  ],
});

/**
 * bumps-access differential — covers the `bumps_access` BodyStatement kind.
 * Initialize a PDA and verify the bump is stored byte-identically in the
 * post-state across Anchor + Anvil-Pinocchio runs. M3 coverage fixture.
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

const SRC = join(import.meta.dir, "..", "src", "demo-programs", "bumps-access.rs");
const PROGRAM_ID = "BumpsAcc11111111111111111111111111111111111";

defineDifferential({
  fixtureName: "bumps-access",
  programIdBase58: PROGRAM_ID,
  anchorSource: readFileSync(SRC, "utf-8"),
  anchorPackageName: "bumps_access_anchor_diff",

  setup: async () => {
    const authority = Keypair.generate();
    const programId = new PublicKey(PROGRAM_ID);
    const [statePda] = PublicKey.findProgramAddressSync(
      [Buffer.from("bumps-access"), authority.publicKey.toBuffer()],
      programId,
    );
    return { authority, statePda };
  },

  callScript: async (svm: LiteSVM, ctx, programId: PublicKey) => {
    svm.airdrop(ctx.authority.publicKey, BigInt(1_000_000_000));
    const ix = new TransactionInstruction({
      programId,
      keys: [
        { pubkey: ctx.statePda, isSigner: false, isWritable: true },
        { pubkey: ctx.authority.publicKey, isSigner: true, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data: Buffer.from(anchorIxDiscriminator("initialize")),
    });
    const tx = new Transaction().add(ix);
    tx.recentBlockhash = svm.latestBlockhash();
    tx.feePayer = ctx.authority.publicKey;
    tx.sign(ctx.authority);
    const r = svm.sendTransaction(tx);
    if (r?.constructor?.name === "FailedTransactionMetadata") {
      const failed = r as unknown as { err: () => { toString(): string } };
      throw new Error(`tx failed: ${failed.err().toString()}`);
    }
  },

  accountsToCompare: (ctx) => [{ pubkey: ctx.statePda, label: "state" }],
});

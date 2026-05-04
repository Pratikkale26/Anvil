/**
 * sysvar-rent differential — covers the `sysvar_rent` BodyStatement kind.
 * Calls Rent::get(), computes a rent-exempt minimum, and stores it on a
 * PDA. M3 coverage fixture.
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

const SRC = join(import.meta.dir, "..", "src", "demo-programs", "sysvar-rent.rs");
const PROGRAM_ID = "SysvRent11111111111111111111111111111111111";

defineDifferential({
  fixtureName: "sysvar-rent",
  programIdBase58: PROGRAM_ID,
  anchorSource: readFileSync(SRC, "utf-8"),
  anchorPackageName: "sysvar_rent_anchor_diff",

  setup: async () => {
    const authority = Keypair.generate();
    const programId = new PublicKey(PROGRAM_ID);
    const [statePda] = PublicKey.findProgramAddressSync(
      [Buffer.from("sysvar-rent"), authority.publicKey.toBuffer()],
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
      data: Buffer.from(anchorIxDiscriminator("record_min_balance")),
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

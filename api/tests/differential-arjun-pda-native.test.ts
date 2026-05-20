/**
 * arjun-pda differential (Native target). Mirror of -pin sibling.
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

const SRC = join(import.meta.dir, "..", "src", "demo-programs", "external", "arjun-pda.rs");
const PROGRAM_ID = "ArjnPda1111111111111111111111111111111111111";

defineDifferential({
  fixtureName: "arjun-pda-native",
  programIdBase58: PROGRAM_ID,
  anchorSource: readFileSync(SRC, "utf-8"),
  anchorPackageName: "arjun_pda_anchor_diff_n",
  anvilTarget: "native",

  setup: async () => {
    const user = Keypair.generate();
    const programId = new PublicKey(PROGRAM_ID);
    const [pdaAccount] = PublicKey.findProgramAddressSync(
      [Buffer.from("data"), user.publicKey.toBuffer()],
      programId,
    );
    return { user, pdaAccount };
  },

  callScript: async (svm: LiteSVM, ctx, programId: PublicKey) => {
    svm.airdrop(ctx.user.publicKey, BigInt(1_000_000_000));
    const ix = new TransactionInstruction({
      programId,
      keys: [
        { pubkey: ctx.user.publicKey, isSigner: true, isWritable: true },
        { pubkey: ctx.pdaAccount, isSigner: false, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data: Buffer.from(anchorIxDiscriminator("initialize")),
    });
    const tx = new Transaction().add(ix);
    tx.recentBlockhash = svm.latestBlockhash();
    tx.feePayer = ctx.user.publicKey;
    tx.sign(ctx.user);
    const r = svm.sendTransaction(tx);
    if (isTxFailure(r)) throw new Error(`tx initialize: ${txFailureMessage(r)}`);
  },

  accountsToCompare: (ctx) => [
    { pubkey: ctx.pdaAccount, label: "pda_account" },
  ],
});

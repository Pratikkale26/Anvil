/**
 * arjun-pda differential (Pinocchio target). Second byte-equal proof on
 * real-world external Anchor source. Sourced from
 * github.com/aarjn/solana-programs-list/anchor-pda.
 *
 * Exercises: PDA init with seeds=["data", user.key()], ctx.bumps access
 * (the bumps_access IR kind), Pubkey field write, u8 field write,
 * msg!() string format (log diverges by design — not compared).
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
  fixtureName: "arjun-pda-pin",
  programIdBase58: PROGRAM_ID,
  anchorSource: readFileSync(SRC, "utf-8"),
  anchorPackageName: "arjun_pda_anchor_diff",
  anvilTarget: "pinocchio",

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

    // Source's Initialize struct orders: user FIRST, then pda_account, then
    // system_program. Anchor serializes accounts in struct-declaration
    // order, so the IX accounts slice must match.
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

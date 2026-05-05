/**
 * M1 — fixture for the compareMsgLogs surface.
 *
 * The verdict structure ships 3 surfaces beyond data/lamports/owner:
 * compareMsgLogs, compareReturnData, assertions. Pre-M1 each had ~0
 * fixture coverage — Anvil ships the API but we don't prove end-to-end
 * that a user enabling compareMsgLogs in their scenario gets the right
 * answer.
 *
 * This fixture is the cheapest possible witness for compareMsgLogs.
 * msg-emit.rs has two instructions, each emitting a couple of msg!()
 * lines. The compare strips Anchor's "Instruction:" framing (the
 * harness already does this in runScenario) and asserts the user-emitted
 * lines byte-match between Anchor and Anvil emit. If the emitter mangles
 * the format string OR routes msg! through a different log path that
 * adds/drops bytes, this catches it.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import {
  defineDifferential,
  anchorIxDiscriminator,
  concatBytes,
  Keypair,
  PublicKey,
  LiteSVM,
} from "./differential-harness.ts";

const SRC = join(import.meta.dir, "..", "src", "demo-programs", "msg-emit.rs");
const PROGRAM_ID = "MsgEmit111111111111111111111111111111111111";

defineDifferential({
  fixtureName: "msg-emit",
  programIdBase58: PROGRAM_ID,
  anchorSource: readFileSync(SRC, "utf-8"),
  anchorPackageName: "msg_emit_anchor_diff",

  setup: async () => {
    return { payer: Keypair.generate() };
  },

  callScript: async (svm: LiteSVM, ctx, programId: PublicKey) => {
    svm.airdrop(ctx.payer.publicKey, BigInt(1_000_000_000));

    const helloIx = new TransactionInstruction({
      programId,
      keys: [],
      data: Buffer.from(anchorIxDiscriminator("say_hello")),
    });
    const statusOkIx = new TransactionInstruction({
      programId,
      keys: [],
      data: Buffer.from(concatBytes(anchorIxDiscriminator("say_status"), Uint8Array.from([1]))),
    });
    const statusBadIx = new TransactionInstruction({
      programId,
      keys: [],
      data: Buffer.from(concatBytes(anchorIxDiscriminator("say_status"), Uint8Array.from([0]))),
    });

    for (const ix of [helloIx, statusOkIx, statusBadIx]) {
      const tx = new Transaction().add(ix);
      tx.recentBlockhash = svm.latestBlockhash();
      tx.feePayer = ctx.payer.publicKey;
      tx.sign(ctx.payer);
      const r = svm.sendTransaction(tx);
      if ("err" in r) throw new Error(`tx failed: ${JSON.stringify(r.err)}`);
    }
  },

  // No accounts to byte-compare — every signal lives in the msg!() logs.
  accountsToCompare: () => [],
  compareMsgLogs: true,
});

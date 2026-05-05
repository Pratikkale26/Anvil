/**
 * M1 — fixture for the compareReturnData surface.
 *
 * The cross-program return-value channel: callers reading via
 * get_return_data() observe whatever bytes the program wrote with
 * set_return_data(). If Anvil's emit drops the call OR re-encodes the
 * payload OR calls a different-program-id set_return_data, this catches
 * it.
 *
 * Scope: one ix, one explicit set_return_data() call with an 8-byte
 * fixed payload. The harness wraps svm.sendTransaction to capture the
 * returnData() metadata for every step and asserts the captured arrays
 * byte-match between Anchor and Anvil.
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
  Keypair,
  PublicKey,
  LiteSVM,
} from "./differential-harness.ts";

const SRC = join(import.meta.dir, "..", "src", "demo-programs", "return-data.rs");
const PROGRAM_ID = "Retdata111111111111111111111111111111111111";

defineDifferential({
  fixtureName: "return-data",
  programIdBase58: PROGRAM_ID,
  anchorSource: readFileSync(SRC, "utf-8"),
  anchorPackageName: "return_data_anchor_diff",

  setup: async () => {
    return { payer: Keypair.generate() };
  },

  callScript: async (svm: LiteSVM, ctx, programId: PublicKey) => {
    svm.airdrop(ctx.payer.publicKey, BigInt(1_000_000_000));
    const ix = new TransactionInstruction({
      programId,
      keys: [],
      data: Buffer.from(anchorIxDiscriminator("echo")),
    });
    const tx = new Transaction().add(ix);
    tx.recentBlockhash = svm.latestBlockhash();
    tx.feePayer = ctx.payer.publicKey;
    tx.sign(ctx.payer);
    const r = svm.sendTransaction(tx);
    if ("err" in r) throw new Error(`tx failed: ${JSON.stringify(r.err)}`);
  },

  // No accounts — every signal lives in the set_return_data payload.
  accountsToCompare: () => [],
  compareReturnData: true,
});

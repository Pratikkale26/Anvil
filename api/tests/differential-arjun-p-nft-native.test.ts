/**
 * arjun-p-nft differential (Native target). Mirror of -pin sibling.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Transaction, TransactionInstruction } from "@solana/web3.js";
import {
  defineDifferential,
  anchorIxDiscriminator,
  Keypair,
  PublicKey,
  LiteSVM,
} from "./differential-harness.ts";
import { isTxFailure, txFailureMessage } from "./litesvm-tx-error.ts";

const SRC = join(import.meta.dir, "..", "src", "demo-programs", "external", "arjun-p-nft.rs");
const PROGRAM_ID = "ArjnNft1111111111111111111111111111111111111";

defineDifferential({
  fixtureName: "arjun-p-nft-native",
  programIdBase58: PROGRAM_ID,
  anchorSource: readFileSync(SRC, "utf-8"),
  anchorPackageName: "arjun_p_nft_anchor_diff_n",
  anvilTarget: "native",
  stripDiscriminator: false,

  setup: async () => {
    const user = Keypair.generate();
    return { user };
  },

  callScript: async (svm: LiteSVM, ctx, programId: PublicKey) => {
    svm.airdrop(ctx.user.publicKey, BigInt(1_000_000_000));
    const ix = new TransactionInstruction({
      programId,
      keys: [],
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
    { pubkey: ctx.user.publicKey, label: "fee_payer" },
  ],
});

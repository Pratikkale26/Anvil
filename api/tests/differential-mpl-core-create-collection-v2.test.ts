/**
 * MPL Core CreateCollectionV2 byte-equal differential (task #48 S5).
 *
 * Creates a collection asset and compares the resulting account bytes.
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
  concatBytes,
  Keypair,
  PublicKey,
  LiteSVM,
} from "./differential-harness.ts";
import { isTxFailure, txFailureMessage } from "./litesvm-tx-error.ts";

const SRC = join(import.meta.dir, "..", "src", "demo-programs", "mpl-core-create-collection-v2.rs");
const PROGRAM_ID = "2H287qf7yi8uGcS23oR1yRRRn3HfrbYPmCffb9UAwUnv";
const MPL_CORE_ID = "CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d";

function borshString(s: string): Uint8Array {
  const bytes = new TextEncoder().encode(s);
  const out = new Uint8Array(4 + bytes.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, bytes.length, true);
  out.set(bytes, 4);
  return out;
}

defineDifferential({
  fixtureName: "mpl-core-create-collection-v2",
  programIdBase58: PROGRAM_ID,
  anchorSource: readFileSync(SRC, "utf-8"),
  anchorPackageName: "mpl_core_create_collection_v2_anchor_diff",
  anchorExtraDeps: `mpl-core = { version = "0.11", features = ["anchor"] }`,
  auxiliaryPrograms: [
    { programId: MPL_CORE_ID, soFilename: "mpl_core.so" },
  ],

  setup: async () => {
    const payer = Keypair.generate();
    const collection = Keypair.generate();
    const mplCoreProgramId = new PublicKey(MPL_CORE_ID);
    return { payer, collection, mplCoreProgramId };
  },

  callScript: async (svm: LiteSVM, ctx, programId: PublicKey) => {
    svm.withDefaultPrograms();
    svm.airdrop(ctx.payer.publicKey, BigInt(10_000_000_000));

    const name = "Anvil Collection";
    const uri = "https://collection.example/0.json";
    // CreateCollection account order: collection (signer), payer (signer),
    // system_program, mpl_core_program.
    const ix = new TransactionInstruction({
      programId,
      keys: [
        { pubkey: ctx.collection.publicKey, isSigner: true, isWritable: true },
        { pubkey: ctx.payer.publicKey, isSigner: true, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        { pubkey: ctx.mplCoreProgramId, isSigner: false, isWritable: false },
      ],
      data: Buffer.from(concatBytes(
        anchorIxDiscriminator("create_collection"),
        borshString(name),
        borshString(uri),
      )),
    });
    const tx = new Transaction().add(ix);
    tx.recentBlockhash = svm.latestBlockhash();
    tx.feePayer = ctx.payer.publicKey;
    tx.sign(ctx.payer, ctx.collection);
    const r = svm.sendTransaction(tx);
    if (isTxFailure(r)) throw new Error(`create_collection failed: ${txFailureMessage(r)}`);
  },

  stripDiscriminator: false,
  accountsToCompare: (ctx) => [
    { pubkey: ctx.collection.publicKey, label: "collection_after_create" },
  ],
});

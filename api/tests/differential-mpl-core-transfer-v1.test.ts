/**
 * MPL Core TransferV1 byte-equal differential (task #48 S3).
 *
 * Creates an asset, then transfers it to a new owner. Compares the
 * asset's post-transfer bytes (owner field flips).
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

const SRC = join(import.meta.dir, "..", "src", "demo-programs", "mpl-core-transfer-v1.rs");
const PROGRAM_ID = "2BNqVtFYLMr8MbvEQbjbDNw4sNvJp4Xo2fBpeVWWZCxj";
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
  fixtureName: "mpl-core-transfer-v1",
  programIdBase58: PROGRAM_ID,
  anchorSource: readFileSync(SRC, "utf-8"),
  anchorPackageName: "mpl_core_transfer_v1_anchor_diff",
  anchorExtraDeps: `mpl-core = { version = "0.11", features = ["anchor"] }`,
  auxiliaryPrograms: [
    { programId: MPL_CORE_ID, soFilename: "mpl_core.so" },
  ],

  setup: async () => {
    const payer = Keypair.generate();
    const asset = Keypair.generate();
    const owner = payer;
    const recipient = Keypair.generate();
    const mplCoreProgramId = new PublicKey(MPL_CORE_ID);
    return { payer, asset, owner, recipient, mplCoreProgramId };
  },

  callScript: async (svm: LiteSVM, ctx, programId: PublicKey) => {
    svm.withDefaultPrograms();
    svm.airdrop(ctx.payer.publicKey, BigInt(10_000_000_000));

    // Pre-mint an asset directly via raw mpl_core CreateV2 so the demo's
    // transfer_asset ix has something to transfer. Owner defaults to
    // payer (Owner=None on Create means the payer becomes the asset owner).
    const createName = "T1";
    const createUri = "https://t.example/0.json";
    const create = new TransactionInstruction({
      programId: ctx.mplCoreProgramId,
      keys: [
        { pubkey: ctx.asset.publicKey, isSigner: true, isWritable: true },
        { pubkey: ctx.mplCoreProgramId, isSigner: false, isWritable: false },
        { pubkey: ctx.mplCoreProgramId, isSigner: false, isWritable: false },
        { pubkey: ctx.payer.publicKey, isSigner: true, isWritable: true },
        { pubkey: ctx.mplCoreProgramId, isSigner: false, isWritable: false },
        { pubkey: ctx.mplCoreProgramId, isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        { pubkey: ctx.mplCoreProgramId, isSigner: false, isWritable: false },
      ],
      data: Buffer.from(concatBytes(
        new Uint8Array([20, 0]),
        borshString(createName),
        borshString(createUri),
        new Uint8Array([0, 0]),
      )),
    });
    const tx0 = new Transaction().add(create);
    tx0.recentBlockhash = svm.latestBlockhash();
    tx0.feePayer = ctx.payer.publicKey;
    tx0.sign(ctx.payer, ctx.asset);
    const c0 = svm.sendTransaction(tx0);
    if (isTxFailure(c0)) throw new Error(`create setup: ${txFailureMessage(c0)}`);

    // Now transfer_asset — account order matches TransferAsset struct:
    // asset, payer, owner, recipient, system_program, mpl_core_program.
    const transferIx = new TransactionInstruction({
      programId,
      keys: [
        { pubkey: ctx.asset.publicKey, isSigner: false, isWritable: true },
        { pubkey: ctx.payer.publicKey, isSigner: true, isWritable: true },
        { pubkey: ctx.owner.publicKey, isSigner: true, isWritable: false },
        { pubkey: ctx.recipient.publicKey, isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        { pubkey: ctx.mplCoreProgramId, isSigner: false, isWritable: false },
      ],
      data: Buffer.from(anchorIxDiscriminator("transfer_asset")),
    });
    const tx = new Transaction().add(transferIx);
    tx.recentBlockhash = svm.latestBlockhash();
    tx.feePayer = ctx.payer.publicKey;
    tx.sign(ctx.payer);
    const r = svm.sendTransaction(tx);
    if (isTxFailure(r)) throw new Error(`transfer_asset failed: ${txFailureMessage(r)}`);
  },

  stripDiscriminator: false,
  accountsToCompare: (ctx) => [
    { pubkey: ctx.asset.publicKey, label: "asset_after_transfer" },
  ],
});

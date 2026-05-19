/**
 * MPL Core BurnV1 byte-equal differential (task #48 S4).
 *
 * Creates an asset, then burns it. After burn, the asset account is
 * closed (zero-lamport, no data). Compares the post-burn account state.
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

const SRC = join(import.meta.dir, "..", "src", "demo-programs", "mpl-core-burn-v1.rs");
const PROGRAM_ID = "ohtS18nre3TJyrqaExvFT46z5YuTKrSJCBDj5CZEYHC";
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
  fixtureName: "mpl-core-burn-v1",
  programIdBase58: PROGRAM_ID,
  anchorSource: readFileSync(SRC, "utf-8"),
  anchorPackageName: "mpl_core_burn_v1_anchor_diff",
  anchorExtraDeps: `mpl-core = { version = "0.11", features = ["anchor"] }`,
  auxiliaryPrograms: [
    { programId: MPL_CORE_ID, soFilename: "mpl_core.so" },
  ],

  setup: async () => {
    const payer = Keypair.generate();
    const asset = Keypair.generate();
    const owner = payer;
    const mplCoreProgramId = new PublicKey(MPL_CORE_ID);
    return { payer, asset, owner, mplCoreProgramId };
  },

  callScript: async (svm: LiteSVM, ctx, programId: PublicKey) => {
    svm.withDefaultPrograms();
    svm.airdrop(ctx.payer.publicKey, BigInt(10_000_000_000));

    // Pre-mint asset.
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
        borshString("B"),
        borshString("https://b/0.json"),
        new Uint8Array([0, 0]),
      )),
    });
    const tx0 = new Transaction().add(create);
    tx0.recentBlockhash = svm.latestBlockhash();
    tx0.feePayer = ctx.payer.publicKey;
    tx0.sign(ctx.payer, ctx.asset);
    const c0 = svm.sendTransaction(tx0);
    if (isTxFailure(c0)) throw new Error(`create setup: ${txFailureMessage(c0)}`);

    // burn_asset — account order: asset, payer, owner, system_program,
    // mpl_core_program.
    const burnIx = new TransactionInstruction({
      programId,
      keys: [
        { pubkey: ctx.asset.publicKey, isSigner: false, isWritable: true },
        { pubkey: ctx.payer.publicKey, isSigner: true, isWritable: true },
        { pubkey: ctx.owner.publicKey, isSigner: true, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        { pubkey: ctx.mplCoreProgramId, isSigner: false, isWritable: false },
      ],
      data: Buffer.from(anchorIxDiscriminator("burn_asset")),
    });
    const tx = new Transaction().add(burnIx);
    tx.recentBlockhash = svm.latestBlockhash();
    tx.feePayer = ctx.payer.publicKey;
    tx.sign(ctx.payer);
    const r = svm.sendTransaction(tx);
    if (isTxFailure(r)) throw new Error(`burn_asset failed: ${txFailureMessage(r)}`);
  },

  stripDiscriminator: false,
  accountsToCompare: (ctx) => [
    { pubkey: ctx.asset.publicKey, label: "asset_after_burn" },
  ],
});

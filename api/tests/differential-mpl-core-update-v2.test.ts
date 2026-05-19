/**
 * MPL Core UpdateV2 byte-equal differential (task #48 S2, validated).
 *
 * Mints an asset (CreateV2) then updates name+uri (UpdateV2). Compares
 * the post-update asset bytes against the Anchor reference build, both
 * invoking real mpl_core.so loaded into LiteSVM.
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

const SRC = join(import.meta.dir, "..", "src", "demo-programs", "mpl-core-update-v2.rs");
const PROGRAM_ID = "H8RFHvzoYujBW2mGqUVA1Ua5Pzu6bEjaWQmXjgviQinR";
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
  fixtureName: "mpl-core-update-v2",
  programIdBase58: PROGRAM_ID,
  anchorSource: readFileSync(SRC, "utf-8"),
  anchorPackageName: "mpl_core_update_v2_anchor_diff",
  anchorExtraDeps: `mpl-core = { version = "0.11", features = ["anchor"] }`,
  auxiliaryPrograms: [
    { programId: MPL_CORE_ID, soFilename: "mpl_core.so" },
  ],

  setup: async () => {
    const payer = Keypair.generate();
    const asset = Keypair.generate();
    const authority = payer; // same key for simplicity
    const mplCoreProgramId = new PublicKey(MPL_CORE_ID);
    return { payer, asset, authority, mplCoreProgramId };
  },

  callScript: async (svm: LiteSVM, ctx, programId: PublicKey) => {
    svm.withDefaultPrograms();
    svm.airdrop(ctx.payer.publicKey, BigInt(10_000_000_000));

    // We can't mint via the Anvil-Pinocchio program directly (it only
    // exposes update_metadata + update_uri_only). The demo source assumes
    // an already-existing asset. So we mint one via a raw CPI to mpl_core
    // by issuing the CreateV2 ix directly here.
    //
    // CreateV2 wire: disc=20 + data_state=0 (AccountState) + name + uri +
    // plugins=None + xpa=None. 8 accounts.
    const createName = "Init Name";
    const createUri = "https://initial.example/0.json";
    const ix = new TransactionInstruction({
      programId: ctx.mplCoreProgramId,
      keys: [
        { pubkey: ctx.asset.publicKey, isSigner: true, isWritable: true },
        { pubkey: ctx.mplCoreProgramId, isSigner: false, isWritable: false }, // collection=None
        { pubkey: ctx.mplCoreProgramId, isSigner: false, isWritable: false }, // authority=None
        { pubkey: ctx.payer.publicKey, isSigner: true, isWritable: true },
        { pubkey: ctx.mplCoreProgramId, isSigner: false, isWritable: false }, // owner=None
        { pubkey: ctx.mplCoreProgramId, isSigner: false, isWritable: false }, // update_authority=None
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        { pubkey: ctx.mplCoreProgramId, isSigner: false, isWritable: false }, // log_wrapper=None
      ],
      data: Buffer.from(concatBytes(
        new Uint8Array([20, 0]), // disc + data_state=AccountState
        borshString(createName),
        borshString(createUri),
        new Uint8Array([0, 0]), // plugins=None, xpa=None
      )),
    });
    const createTx = new Transaction().add(ix);
    createTx.recentBlockhash = svm.latestBlockhash();
    createTx.feePayer = ctx.payer.publicKey;
    createTx.sign(ctx.payer, ctx.asset);
    const cr = svm.sendTransaction(createTx);
    if (isTxFailure(cr)) throw new Error(`create_v2 setup failed: ${txFailureMessage(cr)}`);

    // Now invoke the program's update_metadata(new_name, new_uri) ix.
    // Account order matches UpdateAsset struct: asset, payer, authority,
    // system_program, mpl_core_program.
    const newName = "Updated Anvil";
    const newUri = "https://updated.example/1.json";
    const updateIx = new TransactionInstruction({
      programId,
      keys: [
        { pubkey: ctx.asset.publicKey, isSigner: false, isWritable: true },
        { pubkey: ctx.payer.publicKey, isSigner: true, isWritable: true },
        { pubkey: ctx.authority.publicKey, isSigner: true, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        { pubkey: ctx.mplCoreProgramId, isSigner: false, isWritable: false },
      ],
      data: Buffer.from(concatBytes(
        anchorIxDiscriminator("update_metadata"),
        borshString(newName),
        borshString(newUri),
      )),
    });
    const updateTx = new Transaction().add(updateIx);
    updateTx.recentBlockhash = svm.latestBlockhash();
    updateTx.feePayer = ctx.payer.publicKey;
    updateTx.sign(ctx.payer);
    const ur = svm.sendTransaction(updateTx);
    if (isTxFailure(ur)) throw new Error(`update_metadata failed: ${txFailureMessage(ur)}`);
  },

  stripDiscriminator: false,
  accountsToCompare: (ctx) => [
    { pubkey: ctx.asset.publicKey, label: "asset_after_update" },
  ],
});

/**
 * MPL N1h — verify_collection byte-equal differential (slot 11/12).
 *
 * Flow:
 *  1. make_collection(name, sym, uri) — creates collection NFT (metadata
 *     + master_edition with max_supply=0).
 *  2. make_item(name, sym, uri) — creates item NFT with
 *     collection: Some(Collection { verified: false, key: collection_mint })
 *     pre-set in DataV2 (requires task #84 phase 4 — collection field IR).
 *  3. verify() — invokes MPL verify_collection (disc 18). Flips the
 *     item.metadata.collection.verified from false -> true.
 *
 * Byte-equal anchor: item.metadata's collection field flips
 * verified=false -> true on both Anchor + Anvil emit; rest of the
 * metadata stays identical. The collection NFT's metadata is untouched.
 *
 * Pre-task-#84-phase-4 this was impossible: emit wrote DataV2.collection
 * as None regardless of source intent, so verify_collection had no
 * collection to verify and MPL rejected with 0x96.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  Transaction,
  TransactionInstruction,
  SystemProgram,
  SYSVAR_RENT_PUBKEY,
} from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import {
  defineDifferential,
  anchorIxDiscriminator,
  concatBytes,
  Keypair,
  PublicKey,
  LiteSVM,
} from "./differential-harness.ts";
import {
  createMintIxs,
  createTokenAccountIxs,
  mintToIx,
  sendSetupTx,
} from "./differential-setup-helpers.ts";
import { isTxFailure, txFailureMessage } from "./litesvm-tx-error.ts";

const SRC = join(import.meta.dir, "..", "src", "demo-programs", "mpl-verify-collection-direct.rs");
const PROGRAM_ID = "DShboa9F21jsET79STm3NUfogxC8CU7h28yKiAckeA86";
const MPL_PROGRAM_ID = "metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s";

function borshString(s: string): Uint8Array {
  const bytes = new TextEncoder().encode(s);
  const out = new Uint8Array(4 + bytes.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, bytes.length, true);
  out.set(bytes, 4);
  return out;
}

function pdas(mplProgramId: PublicKey, mint: PublicKey) {
  const [metadata] = PublicKey.findProgramAddressSync(
    [Buffer.from("metadata"), mplProgramId.toBuffer(), mint.toBuffer()],
    mplProgramId,
  );
  const [edition] = PublicKey.findProgramAddressSync(
    [Buffer.from("metadata"), mplProgramId.toBuffer(), mint.toBuffer(), Buffer.from("edition")],
    mplProgramId,
  );
  return { metadata, edition };
}

defineDifferential({
  fixtureName: "mpl-verify-collection-direct",
  programIdBase58: PROGRAM_ID,
  anchorSource: readFileSync(SRC, "utf-8"),
  anchorPackageName: "mpl_verify_collection_direct_anchor_diff",
  anchorExtraDeps: `anchor-spl = { version = "0.31", features = ["metadata"] }`,
  auxiliaryPrograms: [
    { programId: MPL_PROGRAM_ID, soFilename: "mpl_token_metadata.so" },
  ],

  setup: async () => {
    const payer = Keypair.generate();
    const collectionMint = Keypair.generate();
    const collectionTokenAccount = Keypair.generate();
    const itemMint = Keypair.generate();
    const itemTokenAccount = Keypair.generate();
    const mplProgramId = new PublicKey(MPL_PROGRAM_ID);
    const cPdas = pdas(mplProgramId, collectionMint.publicKey);
    const iPdas = pdas(mplProgramId, itemMint.publicKey);
    return {
      payer, mplProgramId,
      collectionMint, collectionTokenAccount,
      itemMint, itemTokenAccount,
      collectionMetadataPda: cPdas.metadata,
      collectionEditionPda: cPdas.edition,
      itemMetadataPda: iPdas.metadata,
      itemEditionPda: iPdas.edition,
    };
  },

  callScript: async (svm: LiteSVM, ctx, programId: PublicKey) => {
    svm.withDefaultPrograms();
    svm.airdrop(ctx.payer.publicKey, BigInt(15_000_000_000));

    // Mint setup for collection + item (NFT spec: decimals=0, supply=1).
    const setupTx = new Transaction()
      .add(...createMintIxs(svm, ctx.payer.publicKey, ctx.collectionMint.publicKey, 0, ctx.payer.publicKey, ctx.payer.publicKey))
      .add(...createTokenAccountIxs(svm, ctx.payer.publicKey, ctx.collectionTokenAccount.publicKey, ctx.collectionMint.publicKey, ctx.payer.publicKey))
      .add(mintToIx(ctx.collectionMint.publicKey, ctx.collectionTokenAccount.publicKey, ctx.payer.publicKey, 1n))
      .add(...createMintIxs(svm, ctx.payer.publicKey, ctx.itemMint.publicKey, 0, ctx.payer.publicKey, ctx.payer.publicKey))
      .add(...createTokenAccountIxs(svm, ctx.payer.publicKey, ctx.itemTokenAccount.publicKey, ctx.itemMint.publicKey, ctx.payer.publicKey))
      .add(mintToIx(ctx.itemMint.publicKey, ctx.itemTokenAccount.publicKey, ctx.payer.publicKey, 1n));
    sendSetupTx(svm, setupTx, ctx.payer.publicKey,
      [ctx.payer, ctx.collectionMint, ctx.collectionTokenAccount, ctx.itemMint, ctx.itemTokenAccount],
      "collection+item-mints");

    // 1) make_collection — MakeCollection account order: metadata, edition,
    // mint, payer, token_metadata_program, token_program, system_program, rent
    let tx = new Transaction().add(new TransactionInstruction({
      programId,
      keys: [
        { pubkey: ctx.collectionMetadataPda, isSigner: false, isWritable: true },
        { pubkey: ctx.collectionEditionPda, isSigner: false, isWritable: true },
        { pubkey: ctx.collectionMint.publicKey, isSigner: false, isWritable: true },
        { pubkey: ctx.payer.publicKey, isSigner: true, isWritable: true },
        { pubkey: ctx.mplProgramId, isSigner: false, isWritable: false },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
      ],
      data: Buffer.from(concatBytes(
        anchorIxDiscriminator("make_collection"),
        borshString("Collection Parent"),
        borshString("COLL"),
        borshString("ipfs://collection"),
      )),
    }));
    tx.recentBlockhash = svm.latestBlockhash();
    tx.feePayer = ctx.payer.publicKey;
    tx.sign(ctx.payer);
    let r = svm.sendTransaction(tx);
    if (isTxFailure(r)) throw new Error(`make_collection failed: ${txFailureMessage(r)}`);

    // 2) make_item — MakeItem account order: metadata, edition, mint,
    // collection_mint, payer, token_metadata_program, token_program,
    // system_program, rent
    tx = new Transaction().add(new TransactionInstruction({
      programId,
      keys: [
        { pubkey: ctx.itemMetadataPda, isSigner: false, isWritable: true },
        { pubkey: ctx.itemEditionPda, isSigner: false, isWritable: true },
        { pubkey: ctx.itemMint.publicKey, isSigner: false, isWritable: true },
        { pubkey: ctx.collectionMint.publicKey, isSigner: false, isWritable: false },
        { pubkey: ctx.payer.publicKey, isSigner: true, isWritable: true },
        { pubkey: ctx.mplProgramId, isSigner: false, isWritable: false },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
      ],
      data: Buffer.from(concatBytes(
        anchorIxDiscriminator("make_item"),
        borshString("Item NFT"),
        borshString("ITEM"),
        borshString("ipfs://item"),
      )),
    }));
    tx.recentBlockhash = svm.latestBlockhash();
    tx.feePayer = ctx.payer.publicKey;
    tx.sign(ctx.payer);
    r = svm.sendTransaction(tx);
    if (isTxFailure(r)) throw new Error(`make_item failed: ${txFailureMessage(r)}`);

    // 3) verify — VerifyCtx account order: metadata, collection_metadata,
    // collection_master_edition, collection_mint, payer, token_metadata_program
    tx = new Transaction().add(new TransactionInstruction({
      programId,
      keys: [
        { pubkey: ctx.itemMetadataPda, isSigner: false, isWritable: true },
        { pubkey: ctx.collectionMetadataPda, isSigner: false, isWritable: false },
        { pubkey: ctx.collectionEditionPda, isSigner: false, isWritable: false },
        { pubkey: ctx.collectionMint.publicKey, isSigner: false, isWritable: false },
        { pubkey: ctx.payer.publicKey, isSigner: true, isWritable: true },
        { pubkey: ctx.mplProgramId, isSigner: false, isWritable: false },
      ],
      data: Buffer.from(anchorIxDiscriminator("verify")),
    }));
    tx.recentBlockhash = svm.latestBlockhash();
    tx.feePayer = ctx.payer.publicKey;
    tx.sign(ctx.payer);
    r = svm.sendTransaction(tx);
    if (isTxFailure(r)) throw new Error(`verify failed: ${txFailureMessage(r)}`);
  },

  stripDiscriminator: false,
  accountsToCompare: (ctx) => [
    { pubkey: ctx.itemMetadataPda, label: "item_metadata_after_verify" },
    { pubkey: ctx.collectionMetadataPda, label: "collection_metadata" },
  ],
});

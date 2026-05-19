/**
 * MPL N1c — set_and_verify_collection byte-equal differential (slot 4/12).
 *
 * Flow:
 *  1. make_nft(collection_mint) — creates the COLLECTION NFT's metadata + master_edition
 *  2. make_nft(item_mint) — creates the ITEM NFT's metadata + master_edition
 *  3. set_and_verify — writes Collection { key: collection_mint, verified: true } on item
 *
 * Bugs surfaced + fixed by this differential:
 *   - Parser: VerifyCollection/SetAndVerifyCollection extracted wrong struct
 *     field name ("collection" instead of anchor-spl's "collection_metadata").
 *   - Parser: UnverifyCollection extracted "collection_master_edition" instead
 *     of anchor-spl's "collection_master_edition_account".
 *   - Emit (Pinocchio): verify_collection disc was 21 — actual MPL 5.1.1 disc is 18.
 *   - Emit (Pinocchio): unverify_collection passed `payer` in meta slot 2 —
 *     MPL UnverifyCollection has NO payer slot (5 base accounts, not 6).
 *   - Emit (Pinocchio): verify/unverify/set_and_verify helpers used
 *     `let infos: &[&AccountInfo]` (slice) which Pinocchio's invoke rejects;
 *     refactored to per-branch typed-array calls. Helpers never compiled in
 *     Pinocchio prior to this differential.
 *
 * Why no unverify_collection / verify_collection byte-equal in this fixture:
 *   - anchor-spl 0.31's `unverify_collection` wrapper has a known bug:
 *     it sets the MPL `collection` field to `*ctx.accounts.metadata.key`
 *     (item metadata) instead of `*ctx.accounts.collection.key` (collection
 *     metadata). The MPL program then reads the wrong account as the
 *     collection metadata and rejects with "Mint given does not match mint
 *     on Metadata" (0xf). This breaks the wrapper itself — Anchor users
 *     hitting this CPI also get the error. Until anchor-spl ships a fix
 *     (or users migrate to MPL's modern verify_v1/unverify_v1 instructions
 *     via mpl-token-metadata directly), Anvil can't produce a byte-equal
 *     successful unverify via this surface.
 *   - verify_collection requires metadata.collection to be set with
 *     verified=false, which needs either DataV2.collection in create
 *     (Task #84 — pending) or the broken unverify flow.
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

const SRC = join(import.meta.dir, "..", "src", "demo-programs", "mpl-collection-verify.rs");
const PROGRAM_ID = "CHQqELvHkRwCu4QXSdAcYbXgvxbe5dh89nWmZmF2bbVK";
const MPL_PROGRAM_ID = "metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s";

function borshString(s: string): Uint8Array {
  const bytes = new TextEncoder().encode(s);
  const out = new Uint8Array(4 + bytes.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, bytes.length, true);
  out.set(bytes, 4);
  return out;
}

function deriveMetadataPdas(mplProgramId: PublicKey, mintKey: PublicKey) {
  const [metadataPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("metadata"), mplProgramId.toBuffer(), mintKey.toBuffer()],
    mplProgramId,
  );
  const [editionPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("metadata"), mplProgramId.toBuffer(), mintKey.toBuffer(), Buffer.from("edition")],
    mplProgramId,
  );
  return { metadataPda, editionPda };
}

defineDifferential({
  fixtureName: "mpl-collection-verify",
  programIdBase58: PROGRAM_ID,
  anchorSource: readFileSync(SRC, "utf-8"),
  anchorPackageName: "mpl_collection_verify_anchor_diff",
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
    const collection = deriveMetadataPdas(mplProgramId, collectionMint.publicKey);
    const item = deriveMetadataPdas(mplProgramId, itemMint.publicKey);
    return {
      payer, mplProgramId,
      collectionMint, collectionTokenAccount,
      itemMint, itemTokenAccount,
      collectionMetadataPda: collection.metadataPda,
      collectionEditionPda: collection.editionPda,
      itemMetadataPda: item.metadataPda,
      itemEditionPda: item.editionPda,
    };
  },

  callScript: async (svm: LiteSVM, ctx, programId: PublicKey) => {
    svm.withDefaultPrograms();
    svm.airdrop(ctx.payer.publicKey, BigInt(10_000_000_000));

    // === Setup both mints (decimals=0, supply=1 — NFT spec required by master_edition) ===
    const setupTx = new Transaction()
      .add(...createMintIxs(svm, ctx.payer.publicKey, ctx.collectionMint.publicKey, 0, ctx.payer.publicKey, ctx.payer.publicKey))
      .add(...createTokenAccountIxs(svm, ctx.payer.publicKey, ctx.collectionTokenAccount.publicKey, ctx.collectionMint.publicKey, ctx.payer.publicKey))
      .add(mintToIx(ctx.collectionMint.publicKey, ctx.collectionTokenAccount.publicKey, ctx.payer.publicKey, 1n))
      .add(...createMintIxs(svm, ctx.payer.publicKey, ctx.itemMint.publicKey, 0, ctx.payer.publicKey, ctx.payer.publicKey))
      .add(...createTokenAccountIxs(svm, ctx.payer.publicKey, ctx.itemTokenAccount.publicKey, ctx.itemMint.publicKey, ctx.payer.publicKey))
      .add(mintToIx(ctx.itemMint.publicKey, ctx.itemTokenAccount.publicKey, ctx.payer.publicKey, 1n));
    sendSetupTx(svm, setupTx, ctx.payer.publicKey,
      [ctx.payer, ctx.collectionMint, ctx.collectionTokenAccount, ctx.itemMint, ctx.itemTokenAccount],
      "mint-init-collection-and-item");

    // helper: emit a `make_nft(name, symbol, uri)` ix targeting a specific mint
    const makeNftIx = (mintPk: PublicKey, metaPda: PublicKey, edPda: PublicKey, name: string, sym: string, uri: string) =>
      new TransactionInstruction({
        programId,
        keys: [
          { pubkey: metaPda, isSigner: false, isWritable: true },
          { pubkey: edPda, isSigner: false, isWritable: true },
          { pubkey: mintPk, isSigner: false, isWritable: true },
          { pubkey: ctx.payer.publicKey, isSigner: true, isWritable: true },
          { pubkey: ctx.mplProgramId, isSigner: false, isWritable: false },
          { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
          { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
          { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
        ],
        data: Buffer.from(concatBytes(
          anchorIxDiscriminator("make_nft"),
          borshString(name),
          borshString(sym),
          borshString(uri),
        )),
      });

    // 1. make_nft on collection mint
    let tx = new Transaction().add(
      makeNftIx(ctx.collectionMint.publicKey, ctx.collectionMetadataPda, ctx.collectionEditionPda,
                "Collection Parent", "COLL", "ipfs://Q1"),
    );
    tx.recentBlockhash = svm.latestBlockhash();
    tx.feePayer = ctx.payer.publicKey;
    tx.sign(ctx.payer);
    let r = svm.sendTransaction(tx);
    if (isTxFailure(r)) throw new Error(`make_nft(collection) failed: ${txFailureMessage(r)}`);

    // 2. make_nft on item mint
    tx = new Transaction().add(
      makeNftIx(ctx.itemMint.publicKey, ctx.itemMetadataPda, ctx.itemEditionPda,
                "Item NFT", "ITEM", "ipfs://Q2"),
    );
    tx.recentBlockhash = svm.latestBlockhash();
    tx.feePayer = ctx.payer.publicKey;
    tx.sign(ctx.payer);
    r = svm.sendTransaction(tx);
    if (isTxFailure(r)) throw new Error(`make_nft(item) failed: ${txFailureMessage(r)}`);

    // VerifyCtx account order (from #[derive(Accounts)] declaration in demo):
    //   metadata, collection_metadata, collection_master_edition,
    //   collection_mint, payer, token_metadata_program
    const verifyKeys = [
      { pubkey: ctx.itemMetadataPda, isSigner: false, isWritable: true },
      { pubkey: ctx.collectionMetadataPda, isSigner: false, isWritable: false },
      { pubkey: ctx.collectionEditionPda, isSigner: false, isWritable: false },
      { pubkey: ctx.collectionMint.publicKey, isSigner: false, isWritable: false },
      { pubkey: ctx.payer.publicKey, isSigner: true, isWritable: true },
      { pubkey: ctx.mplProgramId, isSigner: false, isWritable: false },
    ];

    // 3. set_and_verify — writes collection to item.metadata + flips verified=true
    tx = new Transaction().add(new TransactionInstruction({
      programId,
      keys: verifyKeys,
      data: Buffer.from(anchorIxDiscriminator("set_and_verify")),
    }));
    tx.recentBlockhash = svm.latestBlockhash();
    tx.feePayer = ctx.payer.publicKey;
    tx.sign(ctx.payer);
    r = svm.sendTransaction(tx);
    if (isTxFailure(r)) throw new Error(`set_and_verify failed: ${txFailureMessage(r)}`);
  },

  stripDiscriminator: false,
  accountsToCompare: (ctx) => [
    { pubkey: ctx.itemMetadataPda, label: "item_metadata_after_verify_cycle" },
    { pubkey: ctx.collectionMetadataPda, label: "collection_metadata" },
  ],
});

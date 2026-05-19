/**
 * MPL N1e — approve_collection_authority + revoke_collection_authority
 * byte-equal differential (slots 7+8/12).
 *
 * Flow:
 *  1. make_nft — creates collection NFT (metadata + master edition)
 *  2. approve — creates collection_authority_record PDA, grants new_auth
 *     authority over the collection (disc 23)
 *  3. revoke — closes the record PDA, removes the authority (disc 24)
 *
 * Wire format (mpl-token-metadata 5.1.1):
 *   ApproveCollectionAuthority (disc 23): 7 base accounts (rent=None omits 8th):
 *     [record writable, new_auth, update_auth writable+signer, payer writable+signer,
 *      metadata, mint, system_program]
 *   RevokeCollectionAuthority (disc 24): 5 accounts.
 *
 * collection_authority_record PDA derivation:
 *   seeds = ["metadata", MPL_PROGRAM_ID, mint, "collection_authority", new_auth]
 *
 * State byte-compared after revoke: metadata + mint + the record account
 * (which should be closed = lamports 0, data empty on both sides).
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

const SRC = join(import.meta.dir, "..", "src", "demo-programs", "mpl-approve-revoke.rs");
const PROGRAM_ID = "AvpRvKWUNz2zWPJ4iAuTGRPF6NeRpqDXJ8TfHTUuBcDw";
const MPL_PROGRAM_ID = "metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s";

function borshString(s: string): Uint8Array {
  const bytes = new TextEncoder().encode(s);
  const out = new Uint8Array(4 + bytes.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, bytes.length, true);
  out.set(bytes, 4);
  return out;
}

defineDifferential({
  fixtureName: "mpl-approve-revoke",
  programIdBase58: PROGRAM_ID,
  anchorSource: readFileSync(SRC, "utf-8"),
  anchorPackageName: "mpl_approve_revoke_anchor_diff",
  anchorExtraDeps: `anchor-spl = { version = "0.31", features = ["metadata"] }`,
  auxiliaryPrograms: [
    { programId: MPL_PROGRAM_ID, soFilename: "mpl_token_metadata.so" },
  ],

  setup: async () => {
    const payer = Keypair.generate();
    const mint = Keypair.generate();
    const tokenAccount = Keypair.generate();
    const newAuth = Keypair.generate();
    const mplProgramId = new PublicKey(MPL_PROGRAM_ID);
    const [metadataPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("metadata"), mplProgramId.toBuffer(), mint.publicKey.toBuffer()],
      mplProgramId,
    );
    const [editionPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("metadata"), mplProgramId.toBuffer(), mint.publicKey.toBuffer(), Buffer.from("edition")],
      mplProgramId,
    );
    const [recordPda] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("metadata"),
        mplProgramId.toBuffer(),
        mint.publicKey.toBuffer(),
        Buffer.from("collection_authority"),
        newAuth.publicKey.toBuffer(),
      ],
      mplProgramId,
    );
    return { payer, mint, tokenAccount, newAuth, mplProgramId, metadataPda, editionPda, recordPda };
  },

  callScript: async (svm: LiteSVM, ctx, programId: PublicKey) => {
    svm.withDefaultPrograms();
    svm.airdrop(ctx.payer.publicKey, BigInt(10_000_000_000));

    // 1) Create mint + token account + mint 1 (NFT spec).
    const setupTx = new Transaction()
      .add(...createMintIxs(svm, ctx.payer.publicKey, ctx.mint.publicKey, 0, ctx.payer.publicKey, ctx.payer.publicKey))
      .add(...createTokenAccountIxs(svm, ctx.payer.publicKey, ctx.tokenAccount.publicKey, ctx.mint.publicKey, ctx.payer.publicKey))
      .add(mintToIx(ctx.mint.publicKey, ctx.tokenAccount.publicKey, ctx.payer.publicKey, 1n));
    sendSetupTx(svm, setupTx, ctx.payer.publicKey,
      [ctx.payer, ctx.mint, ctx.tokenAccount], "mint-init-and-mint-1");

    // 2) make_nft — metadata + master_edition for the collection NFT.
    const mkIx = new TransactionInstruction({
      programId,
      keys: [
        { pubkey: ctx.metadataPda, isSigner: false, isWritable: true },
        { pubkey: ctx.editionPda, isSigner: false, isWritable: true },
        { pubkey: ctx.mint.publicKey, isSigner: false, isWritable: true },
        { pubkey: ctx.payer.publicKey, isSigner: true, isWritable: true },
        { pubkey: ctx.mplProgramId, isSigner: false, isWritable: false },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
      ],
      data: Buffer.from(concatBytes(
        anchorIxDiscriminator("make_nft"),
        borshString("Approve Test"),
        borshString("APR"),
        borshString("ipfs://Q1"),
      )),
    });
    let tx = new Transaction().add(mkIx);
    tx.recentBlockhash = svm.latestBlockhash();
    tx.feePayer = ctx.payer.publicKey;
    tx.sign(ctx.payer);
    let r = svm.sendTransaction(tx);
    if (isTxFailure(r)) throw new Error(`make_nft failed: ${txFailureMessage(r)}`);

    // ApproveCtx account order:
    //   record, new_auth, metadata, mint, payer, token_metadata_program, system_program, rent
    tx = new Transaction().add(new TransactionInstruction({
      programId,
      keys: [
        { pubkey: ctx.recordPda, isSigner: false, isWritable: true },
        { pubkey: ctx.newAuth.publicKey, isSigner: false, isWritable: false },
        { pubkey: ctx.metadataPda, isSigner: false, isWritable: false },
        { pubkey: ctx.mint.publicKey, isSigner: false, isWritable: false },
        { pubkey: ctx.payer.publicKey, isSigner: true, isWritable: true },
        { pubkey: ctx.mplProgramId, isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
      ],
      data: Buffer.from(anchorIxDiscriminator("approve")),
    }));
    tx.recentBlockhash = svm.latestBlockhash();
    tx.feePayer = ctx.payer.publicKey;
    tx.sign(ctx.payer);
    r = svm.sendTransaction(tx);
    if (isTxFailure(r)) throw new Error(`approve failed: ${txFailureMessage(r)}`);

    // RevokeCtx account order:
    //   record, delegate_authority, metadata, mint, payer, token_metadata_program
    // delegate_authority is writable per MPL RevokeCollectionAuthority spec
    // (AccountMeta::new(delegate_authority, false) defaults writable=true) —
    // outer tx must also mark it writable to satisfy CPI privilege escalation.
    tx = new Transaction().add(new TransactionInstruction({
      programId,
      keys: [
        { pubkey: ctx.recordPda, isSigner: false, isWritable: true },
        { pubkey: ctx.newAuth.publicKey, isSigner: false, isWritable: true },
        { pubkey: ctx.metadataPda, isSigner: false, isWritable: false },
        { pubkey: ctx.mint.publicKey, isSigner: false, isWritable: false },
        { pubkey: ctx.payer.publicKey, isSigner: true, isWritable: true },
        { pubkey: ctx.mplProgramId, isSigner: false, isWritable: false },
      ],
      data: Buffer.from(anchorIxDiscriminator("revoke")),
    }));
    tx.recentBlockhash = svm.latestBlockhash();
    tx.feePayer = ctx.payer.publicKey;
    tx.sign(ctx.payer);
    r = svm.sendTransaction(tx);
    if (isTxFailure(r)) throw new Error(`revoke failed: ${txFailureMessage(r)}`);
  },

  stripDiscriminator: false,
  accountsToCompare: (ctx) => [
    { pubkey: ctx.recordPda, label: "record_after_revoke" },
    { pubkey: ctx.metadataPda, label: "metadata_after_revoke" },
  ],
});

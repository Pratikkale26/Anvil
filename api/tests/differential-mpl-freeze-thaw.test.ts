/**
 * MPL N1d — freeze_delegated_account + thaw_delegated_account byte-equal
 * differential (slots 5+6/12).
 *
 * Flow:
 *  1. make_nft — creates the NFT's metadata + master_edition
 *  2. (setup) SPL approve — sets delegate authority on the token_account
 *  3. freeze — locks the token_account via MPL FreezeDelegatedAccount (disc 26)
 *  4. thaw — unlocks via MPL ThawDelegatedAccount (disc 27)
 *
 * State to byte-compare: token_account (its `state` byte flips
 * frozen/initialized). After full cycle, token_account should be byte-
 * identical to its pre-freeze state — but the test compares AFTER thaw,
 * so should match the in-between scenarios identically across emitters.
 *
 * Wire format (mpl-token-metadata 5.1.1):
 *   - FreezeDelegatedAccount (disc 26): 5 accounts
 *     [delegate writable+signer, token_account writable, edition, mint, token_program]
 *   - ThawDelegatedAccount (disc 27): same shape
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  createApproveInstruction,
} from "@solana/spl-token";
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

const SRC = join(import.meta.dir, "..", "src", "demo-programs", "mpl-freeze-thaw.rs");
const PROGRAM_ID = "FrEEzpY8xMFqXmS9DGw1mwm9JBeQXdT4nz4LkXfqsiqu";
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
  fixtureName: "mpl-freeze-thaw",
  programIdBase58: PROGRAM_ID,
  anchorSource: readFileSync(SRC, "utf-8"),
  anchorPackageName: "mpl_freeze_thaw_anchor_diff",
  anchorExtraDeps: `anchor-spl = { version = "0.31", features = ["metadata"] }`,
  auxiliaryPrograms: [
    { programId: MPL_PROGRAM_ID, soFilename: "mpl_token_metadata.so" },
  ],

  setup: async () => {
    const payer = Keypair.generate();
    const mint = Keypair.generate();
    const tokenAccount = Keypair.generate();
    const delegate = Keypair.generate();
    const mplProgramId = new PublicKey(MPL_PROGRAM_ID);
    const [metadataPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("metadata"), mplProgramId.toBuffer(), mint.publicKey.toBuffer()],
      mplProgramId,
    );
    const [editionPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("metadata"), mplProgramId.toBuffer(), mint.publicKey.toBuffer(), Buffer.from("edition")],
      mplProgramId,
    );
    return { payer, mint, tokenAccount, delegate, mplProgramId, metadataPda, editionPda };
  },

  callScript: async (svm: LiteSVM, ctx, programId: PublicKey) => {
    svm.withDefaultPrograms();
    svm.airdrop(ctx.payer.publicKey, BigInt(10_000_000_000));
    svm.airdrop(ctx.delegate.publicKey, BigInt(1_000_000_000));

    // 1) Create mint (decimals=0 NFT spec), token_account owned by payer, mint 1.
    const setupTx = new Transaction()
      .add(...createMintIxs(svm, ctx.payer.publicKey, ctx.mint.publicKey, 0, ctx.payer.publicKey, ctx.payer.publicKey))
      .add(...createTokenAccountIxs(svm, ctx.payer.publicKey, ctx.tokenAccount.publicKey, ctx.mint.publicKey, ctx.payer.publicKey))
      .add(mintToIx(ctx.mint.publicKey, ctx.tokenAccount.publicKey, ctx.payer.publicKey, 1n));
    sendSetupTx(svm, setupTx, ctx.payer.publicKey,
      [ctx.payer, ctx.mint, ctx.tokenAccount], "mint-init-and-mint-1");

    // 2) make_nft — creates metadata + master_edition.
    const mkIx = new TransactionInstruction({
      programId,
      keys: [
        { pubkey: ctx.metadataPda, isSigner: false, isWritable: true },
        { pubkey: ctx.editionPda, isSigner: false, isWritable: true },
        { pubkey: ctx.mint.publicKey, isSigner: false, isWritable: true },
        { pubkey: ctx.payer.publicKey, isSigner: true, isWritable: true },
        { pubkey: ctx.mplProgramId, isSigner: false, isWritable: false },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: new PublicKey("11111111111111111111111111111111"), isSigner: false, isWritable: false },
        { pubkey: new PublicKey("SysvarRent111111111111111111111111111111111"), isSigner: false, isWritable: false },
      ],
      data: Buffer.from(concatBytes(
        anchorIxDiscriminator("make_nft"),
        borshString("Frozen NFT"),
        borshString("FRZ"),
        borshString("ipfs://Qm1"),
      )),
    });
    let tx = new Transaction().add(mkIx);
    tx.recentBlockhash = svm.latestBlockhash();
    tx.feePayer = ctx.payer.publicKey;
    tx.sign(ctx.payer);
    let r = svm.sendTransaction(tx);
    if (isTxFailure(r)) throw new Error(`make_nft failed: ${txFailureMessage(r)}`);

    // 3) SPL approve delegate on token_account — required before freeze.
    const approveIx = createApproveInstruction(
      ctx.tokenAccount.publicKey,
      ctx.delegate.publicKey,
      ctx.payer.publicKey,
      1n,
    );
    tx = new Transaction().add(approveIx);
    tx.recentBlockhash = svm.latestBlockhash();
    tx.feePayer = ctx.payer.publicKey;
    tx.sign(ctx.payer);
    r = svm.sendTransaction(tx);
    if (isTxFailure(r)) throw new Error(`approve failed: ${txFailureMessage(r)}`);

    // FreezeCtx account order from #[derive(Accounts)] declaration:
    //   metadata, edition, mint, token_account, delegate, token_program, token_metadata_program
    const freezeKeys = [
      { pubkey: ctx.metadataPda, isSigner: false, isWritable: false },
      { pubkey: ctx.editionPda, isSigner: false, isWritable: false },
      { pubkey: ctx.mint.publicKey, isSigner: false, isWritable: false },
      { pubkey: ctx.tokenAccount.publicKey, isSigner: false, isWritable: true },
      { pubkey: ctx.delegate.publicKey, isSigner: true, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: ctx.mplProgramId, isSigner: false, isWritable: false },
    ];

    // 4) freeze
    tx = new Transaction().add(new TransactionInstruction({
      programId,
      keys: freezeKeys,
      data: Buffer.from(anchorIxDiscriminator("freeze")),
    }));
    tx.recentBlockhash = svm.latestBlockhash();
    tx.feePayer = ctx.delegate.publicKey;
    tx.sign(ctx.delegate);
    r = svm.sendTransaction(tx);
    if (isTxFailure(r)) throw new Error(`freeze failed: ${txFailureMessage(r)}`);

    // 5) thaw
    tx = new Transaction().add(new TransactionInstruction({
      programId,
      keys: freezeKeys,
      data: Buffer.from(anchorIxDiscriminator("thaw")),
    }));
    tx.recentBlockhash = svm.latestBlockhash();
    tx.feePayer = ctx.delegate.publicKey;
    tx.sign(ctx.delegate);
    r = svm.sendTransaction(tx);
    if (isTxFailure(r)) throw new Error(`thaw failed: ${txFailureMessage(r)}`);
  },

  stripDiscriminator: false,
  accountsToCompare: (ctx) => [
    { pubkey: ctx.tokenAccount.publicKey, label: "token_account_after_thaw" },
    { pubkey: ctx.metadataPda, label: "metadata_after_thaw" },
  ],
});

/**
 * MPL N1g — sign_metadata byte-equal differential (slot 10/12).
 *
 * Flow:
 *  1. make_with_unverified(name) — creates metadata with one creator
 *     entry where verified=false. The creator is a DIFFERENT keypair
 *     than the payer/update_authority (so MPL doesn't auto-verify on
 *     create).
 *  2. sign() — invokes MPL sign_metadata as that creator. Flips the
 *     creator's verified=true on the metadata.
 *
 * Wire format (mpl-token-metadata 5.1.1):
 *   - SignMetadata disc: 7
 *   - 2 accounts: [metadata writable, creator signer]
 *   - No data after disc
 *
 * Byte-equal anchor: the metadata PDA's creators[0].verified byte
 * flips false->true on both Anchor + Anvil emit; the rest of the
 * metadata is unchanged. Compare after sign().
 *
 * This was blocked until task #84 phase 1-3 landed DataV2.creators
 * support — without creators in IR, create_metadata emitted verified=false
 * creator as None, so sign_metadata had nothing to sign and MPL rejected.
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

const SRC = join(import.meta.dir, "..", "src", "demo-programs", "mpl-sign-metadata.rs");
const PROGRAM_ID = "9tjA7cNjLeAwdGgoi26HwCq1CPWojPThsm3myShDJokR";
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
  fixtureName: "mpl-sign-metadata",
  programIdBase58: PROGRAM_ID,
  anchorSource: readFileSync(SRC, "utf-8"),
  anchorPackageName: "mpl_sign_metadata_anchor_diff",
  anchorExtraDeps: `anchor-spl = { version = "0.31", features = ["metadata"] }`,
  auxiliaryPrograms: [
    { programId: MPL_PROGRAM_ID, soFilename: "mpl_token_metadata.so" },
  ],

  setup: async () => {
    const payer = Keypair.generate();
    const mint = Keypair.generate();
    const tokenAccount = Keypair.generate();
    const creator = Keypair.generate();
    const mplProgramId = new PublicKey(MPL_PROGRAM_ID);
    const [metadataPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("metadata"), mplProgramId.toBuffer(), mint.publicKey.toBuffer()],
      mplProgramId,
    );
    return { payer, mint, tokenAccount, creator, mplProgramId, metadataPda };
  },

  callScript: async (svm: LiteSVM, ctx, programId: PublicKey) => {
    svm.withDefaultPrograms();
    svm.airdrop(ctx.payer.publicKey, BigInt(10_000_000_000));
    svm.airdrop(ctx.creator.publicKey, BigInt(1_000_000_000));

    // 1) Mint setup (decimals=0 NFT spec).
    const setupTx = new Transaction()
      .add(...createMintIxs(svm, ctx.payer.publicKey, ctx.mint.publicKey, 0, ctx.payer.publicKey, ctx.payer.publicKey))
      .add(...createTokenAccountIxs(svm, ctx.payer.publicKey, ctx.tokenAccount.publicKey, ctx.mint.publicKey, ctx.payer.publicKey))
      .add(mintToIx(ctx.mint.publicKey, ctx.tokenAccount.publicKey, ctx.payer.publicKey, 1n));
    sendSetupTx(svm, setupTx, ctx.payer.publicKey,
      [ctx.payer, ctx.mint, ctx.tokenAccount], "mint-init");

    // 2) make_with_unverified — creates metadata + adds unverified creator.
    // MakeNft account order: metadata, mint, creator, payer,
    // token_metadata_program, system_program, rent
    let tx = new Transaction().add(new TransactionInstruction({
      programId,
      keys: [
        { pubkey: ctx.metadataPda, isSigner: false, isWritable: true },
        { pubkey: ctx.mint.publicKey, isSigner: false, isWritable: false },
        { pubkey: ctx.creator.publicKey, isSigner: false, isWritable: false },
        { pubkey: ctx.payer.publicKey, isSigner: true, isWritable: true },
        { pubkey: ctx.mplProgramId, isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
      ],
      data: Buffer.from(concatBytes(
        anchorIxDiscriminator("make_with_unverified"),
        borshString("Unverified Test"),
      )),
    }));
    tx.recentBlockhash = svm.latestBlockhash();
    tx.feePayer = ctx.payer.publicKey;
    tx.sign(ctx.payer);
    let r = svm.sendTransaction(tx);
    if (isTxFailure(r)) throw new Error(`make_with_unverified failed: ${txFailureMessage(r)}`);

    // 3) sign — creator signs to flip verified=true.
    // SignCtx account order: metadata, creator, token_metadata_program
    tx = new Transaction().add(new TransactionInstruction({
      programId,
      keys: [
        { pubkey: ctx.metadataPda, isSigner: false, isWritable: true },
        { pubkey: ctx.creator.publicKey, isSigner: true, isWritable: false },
        { pubkey: ctx.mplProgramId, isSigner: false, isWritable: false },
      ],
      data: Buffer.from(anchorIxDiscriminator("sign")),
    }));
    tx.recentBlockhash = svm.latestBlockhash();
    tx.feePayer = ctx.creator.publicKey;
    tx.sign(ctx.creator);
    r = svm.sendTransaction(tx);
    if (isTxFailure(r)) throw new Error(`sign failed: ${txFailureMessage(r)}`);
  },

  stripDiscriminator: false,
  accountsToCompare: (ctx) => [
    { pubkey: ctx.metadataPda, label: "metadata_after_sign" },
  ],
});

/**
 * MPL N1f — mint_new_edition_from_master_edition_via_token byte-equal
 * differential (slot 9/12).
 *
 * Flow:
 *  1. make_master — creates master NFT metadata + master_edition with
 *     max_supply = Some(10) (allows up to 10 print editions).
 *  2. (setup) Create new_mint + new_token_account + mint 1.
 *  3. print_edition(edition=1) — invokes MPL mint_new_edition_from_master_
 *     edition_via_token (disc 11). Produces a new metadata + edition PDA
 *     for the new_mint, marks edition #1 in the edition_mark_pda.
 *
 * Wire format (mpl-token-metadata 5.1.1):
 *   - Discriminator: 11
 *   - 13 base accounts (rent omitted per anchor-spl 0.31 wrapper)
 *   - Data after disc: 8-byte u64 LE edition number
 *
 * edition_mark_pda derivation:
 *   ["metadata", MPL_ID, master_mint, "edition", floor(edition/248).to_string()]
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

const SRC = join(import.meta.dir, "..", "src", "demo-programs", "mpl-mint-new-edition.rs");
const PROGRAM_ID = "H2h6s8Pci1EpgSbny7KGzHz3QvV1RM1qBwmdyYFAeV6h";
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
  fixtureName: "mpl-mint-new-edition",
  programIdBase58: PROGRAM_ID,
  anchorSource: readFileSync(SRC, "utf-8"),
  anchorPackageName: "mpl_mint_new_edition_anchor_diff",
  anchorExtraDeps: `anchor-spl = { version = "0.31", features = ["metadata"] }`,
  auxiliaryPrograms: [
    { programId: MPL_PROGRAM_ID, soFilename: "mpl_token_metadata.so" },
  ],

  setup: async () => {
    const payer = Keypair.generate();
    const masterMint = Keypair.generate();
    const masterTokenAccount = Keypair.generate();
    const newMint = Keypair.generate();
    const newTokenAccount = Keypair.generate();
    const mplProgramId = new PublicKey(MPL_PROGRAM_ID);

    const [masterMetadataPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("metadata"), mplProgramId.toBuffer(), masterMint.publicKey.toBuffer()],
      mplProgramId,
    );
    const [masterEditionPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("metadata"), mplProgramId.toBuffer(), masterMint.publicKey.toBuffer(), Buffer.from("edition")],
      mplProgramId,
    );
    const [newMetadataPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("metadata"), mplProgramId.toBuffer(), newMint.publicKey.toBuffer()],
      mplProgramId,
    );
    const [newEditionPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("metadata"), mplProgramId.toBuffer(), newMint.publicKey.toBuffer(), Buffer.from("edition")],
      mplProgramId,
    );
    // edition_mark_pda seeds: ["metadata", MPL_ID, master_mint, "edition", "<floor(edition/248)>"]
    // For edition=1, floor(1/248) = 0 -> seed = "0".
    const [editionMarkPda] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("metadata"),
        mplProgramId.toBuffer(),
        masterMint.publicKey.toBuffer(),
        Buffer.from("edition"),
        Buffer.from("0"),
      ],
      mplProgramId,
    );

    return {
      payer, mplProgramId,
      masterMint, masterTokenAccount, masterMetadataPda, masterEditionPda,
      newMint, newTokenAccount, newMetadataPda, newEditionPda, editionMarkPda,
    };
  },

  callScript: async (svm: LiteSVM, ctx, programId: PublicKey) => {
    svm.withDefaultPrograms();
    svm.airdrop(ctx.payer.publicKey, BigInt(20_000_000_000));

    // 1) Create master mint + master_token_account + mint 1 (NFT spec).
    let setupTx = new Transaction()
      .add(...createMintIxs(svm, ctx.payer.publicKey, ctx.masterMint.publicKey, 0, ctx.payer.publicKey, ctx.payer.publicKey))
      .add(...createTokenAccountIxs(svm, ctx.payer.publicKey, ctx.masterTokenAccount.publicKey, ctx.masterMint.publicKey, ctx.payer.publicKey))
      .add(mintToIx(ctx.masterMint.publicKey, ctx.masterTokenAccount.publicKey, ctx.payer.publicKey, 1n));
    sendSetupTx(svm, setupTx, ctx.payer.publicKey,
      [ctx.payer, ctx.masterMint, ctx.masterTokenAccount], "master-mint-init");

    // 2) make_master — metadata + master_edition(Some(10)).
    let tx = new Transaction().add(new TransactionInstruction({
      programId,
      keys: [
        { pubkey: ctx.masterMetadataPda, isSigner: false, isWritable: true },
        { pubkey: ctx.masterEditionPda, isSigner: false, isWritable: true },
        { pubkey: ctx.masterMint.publicKey, isSigner: false, isWritable: true },
        { pubkey: ctx.payer.publicKey, isSigner: true, isWritable: true },
        { pubkey: ctx.mplProgramId, isSigner: false, isWritable: false },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
      ],
      data: Buffer.from(concatBytes(
        anchorIxDiscriminator("make_master"),
        borshString("Master NFT"),
        borshString("MSTR"),
        borshString("ipfs://master"),
      )),
    }));
    tx.recentBlockhash = svm.latestBlockhash();
    tx.feePayer = ctx.payer.publicKey;
    tx.sign(ctx.payer);
    let r = svm.sendTransaction(tx);
    if (isTxFailure(r)) throw new Error(`make_master failed: ${txFailureMessage(r)}`);

    // 3) Create new_mint + new_token_account + mint 1 (will become edition #1).
    setupTx = new Transaction()
      .add(...createMintIxs(svm, ctx.payer.publicKey, ctx.newMint.publicKey, 0, ctx.payer.publicKey, ctx.payer.publicKey))
      .add(...createTokenAccountIxs(svm, ctx.payer.publicKey, ctx.newTokenAccount.publicKey, ctx.newMint.publicKey, ctx.payer.publicKey))
      .add(mintToIx(ctx.newMint.publicKey, ctx.newTokenAccount.publicKey, ctx.payer.publicKey, 1n));
    sendSetupTx(svm, setupTx, ctx.payer.publicKey,
      [ctx.payer, ctx.newMint, ctx.newTokenAccount], "new-edition-mint-init");

    // 4) print_edition(1).
    // PrintEdition account order from #[derive(Accounts)]:
    //   new_metadata, new_edition, master_edition, metadata, edition_mark_pda,
    //   new_mint, master_token_account, master_mint, payer,
    //   token_metadata_program, token_program, system_program, rent
    const editionLe = Buffer.alloc(8);
    editionLe.writeBigUInt64LE(1n);
    tx = new Transaction().add(new TransactionInstruction({
      programId,
      keys: [
        { pubkey: ctx.newMetadataPda, isSigner: false, isWritable: true },
        { pubkey: ctx.newEditionPda, isSigner: false, isWritable: true },
        { pubkey: ctx.masterEditionPda, isSigner: false, isWritable: true },
        { pubkey: ctx.masterMetadataPda, isSigner: false, isWritable: false },
        { pubkey: ctx.editionMarkPda, isSigner: false, isWritable: true },
        { pubkey: ctx.newMint.publicKey, isSigner: false, isWritable: true },
        { pubkey: ctx.masterTokenAccount.publicKey, isSigner: false, isWritable: false },
        { pubkey: ctx.masterMint.publicKey, isSigner: false, isWritable: false },
        { pubkey: ctx.payer.publicKey, isSigner: true, isWritable: true },
        { pubkey: ctx.mplProgramId, isSigner: false, isWritable: false },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
      ],
      data: Buffer.from(concatBytes(
        anchorIxDiscriminator("print_edition"),
        Uint8Array.from(editionLe),
      )),
    }));
    tx.recentBlockhash = svm.latestBlockhash();
    tx.feePayer = ctx.payer.publicKey;
    tx.sign(ctx.payer);
    r = svm.sendTransaction(tx);
    if (isTxFailure(r)) throw new Error(`print_edition failed: ${txFailureMessage(r)}`);
  },

  stripDiscriminator: false,
  accountsToCompare: (ctx) => [
    { pubkey: ctx.newMetadataPda, label: "new_metadata_after_print" },
    { pubkey: ctx.newEditionPda, label: "new_edition_after_print" },
    { pubkey: ctx.editionMarkPda, label: "edition_mark_after_print" },
    { pubkey: ctx.masterEditionPda, label: "master_edition_after_print" },
  ],
});

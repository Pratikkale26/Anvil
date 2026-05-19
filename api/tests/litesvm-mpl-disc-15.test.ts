/**
 * Diagnostic: locks the staged MPL .so behavior for discriminator-15
 * UpdateMetadataAccountV2 with hand-assembled bytes. Independent of
 * anchor-spl / Anvil — proves the .so itself accepts the legacy ix
 * with [data, new_update_authority, primary_sale, is_mutable] field
 * order (MPL 5.1.1 wire format).
 *
 * Why this exists: a chained make + rename differential attempt hit
 * a rejection from MPL on the rename step. Hand-rolled bytes here
 * succeed cleanly — meaning the rejection came from either anchor-spl
 * 0.31's wrapper assembly OR Anvil's emit shape, not the .so. Filed
 * as task #83 for follow-up.
 *
 * Steps:
 *   1) Pre-install mint + metadata PDA via direct MPL Create Metadata
 *      Accounts V3 (disc 33).
 *   2) Send a direct Update Metadata Accounts V2 (disc 15) with hand-
 *      assembled bytes matching MPL 5.1.1's wire format:
 *        [disc=15][Option<DataV2>][Option<Pubkey>][Option<bool>][Option<bool>]
 *   3) Assert the tx succeeds.
 *
 * If this ever breaks, the staged .so has drifted from the 5.1.1 wire
 * format and the MPL differential test needs a refreshed .so.
 */
import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { LiteSVM } from "litesvm";
import {
  Transaction,
  TransactionInstruction,
  SystemProgram,
  SYSVAR_RENT_PUBKEY,
  Keypair,
  PublicKey,
} from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { createMintIxs, sendSetupTx } from "./differential-setup-helpers.ts";
import { isTxFailure, txFailureMessage } from "./litesvm-tx-error.ts";

const MPL_PROGRAM_ID = "metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s";

function borshString(s: string): Uint8Array {
  const bytes = new TextEncoder().encode(s);
  const out = new Uint8Array(4 + bytes.length);
  new DataView(out.buffer).setUint32(0, bytes.length, true);
  out.set(bytes, 4);
  return out;
}

describe("MPL .so accepts discriminator-15 UpdateMetadataAccountsV2", () => {
  test("hand-rolled disc-15 ix succeeds against the staged .so", () => {
    const svm = new LiteSVM().withDefaultPrograms();
    const mplId = new PublicKey(MPL_PROGRAM_ID);
    svm.addProgram(
      mplId,
      readFileSync(join(import.meta.dir, "fixtures", "programs", "mpl_token_metadata.so")),
    );

    const payer = Keypair.generate();
    const mint = Keypair.generate();
    svm.airdrop(payer.publicKey, BigInt(10_000_000_000));

    const setupTx = new Transaction().add(
      ...createMintIxs(svm, payer.publicKey, mint.publicKey, 0, payer.publicKey, payer.publicKey),
    );
    sendSetupTx(svm, setupTx, payer.publicKey, [payer, mint], "mint-init");

    const [metadataPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("metadata"), mplId.toBuffer(), mint.publicKey.toBuffer()],
      mplId,
    );

    // Create metadata directly (disc 33 + DataV2 + is_mutable + collection_details=None).
    const createData = (() => {
      const name = borshString("Anvil NFT");
      const symbol = borshString("ANV");
      const uri = borshString("ipfs://example");
      const sfbp = new Uint8Array(2);
      new DataView(sfbp.buffer).setUint16(0, 500, true);
      const body = new Uint8Array(1 + name.length + symbol.length + uri.length + 2 + 3 + 1 + 1);
      let o = 0;
      body[o++] = 33;
      body.set(name, o); o += name.length;
      body.set(symbol, o); o += symbol.length;
      body.set(uri, o); o += uri.length;
      body.set(sfbp, o); o += 2;
      body[o++] = 0; // creators=None
      body[o++] = 0; // collection=None
      body[o++] = 0; // uses=None
      body[o++] = 1; // is_mutable=true
      body[o++] = 0; // collection_details=None
      return body.subarray(0, o);
    })();
    const createIx = new TransactionInstruction({
      programId: mplId,
      keys: [
        { pubkey: metadataPda, isSigner: false, isWritable: true },
        { pubkey: mint.publicKey, isSigner: false, isWritable: false },
        { pubkey: payer.publicKey, isSigner: true, isWritable: false }, // mint_authority
        { pubkey: payer.publicKey, isSigner: true, isWritable: true }, // payer
        { pubkey: payer.publicKey, isSigner: true, isWritable: false }, // update_authority
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data: Buffer.from(createData),
    });
    {
      const t = new Transaction().add(createIx);
      t.recentBlockhash = svm.latestBlockhash();
      t.feePayer = payer.publicKey;
      t.sign(payer);
      const r = svm.sendTransaction(t);
      expect(isTxFailure(r), `direct create failed: ${isTxFailure(r) ? txFailureMessage(r) : ""}`).toBe(false);
    }

    // Update metadata: disc 15, Option<DataV2>=Some, Option<Pubkey>=None,
    // Option<bool>=None, Option<bool>=Some(true). MPL 5.1.1 expects:
    //   data: Option<DataV2>, update_authority: Option<Pubkey>, primary_sale, is_mutable.
    const updateData = (() => {
      const name = borshString("Updated");
      const symbol = borshString("UPD");
      const uri = borshString("ipfs://updated");
      const sfbp = new Uint8Array(2);
      new DataView(sfbp.buffer).setUint16(0, 750, true);
      const body = new Uint8Array(1 + 1 + name.length + symbol.length + uri.length + 2 + 3 + 1 + 1 + 2);
      let o = 0;
      body[o++] = 15; // disc
      body[o++] = 1; // data = Some
      body.set(name, o); o += name.length;
      body.set(symbol, o); o += symbol.length;
      body.set(uri, o); o += uri.length;
      body.set(sfbp, o); o += 2;
      body[o++] = 0; // creators = None
      body[o++] = 0; // collection = None
      body[o++] = 0; // uses = None
      body[o++] = 0; // update_authority = None
      body[o++] = 0; // primary_sale_happened = None
      body[o++] = 1; // is_mutable = Some
      body[o++] = 1; // is_mutable value = true
      return body.subarray(0, o);
    })();
    const updateIx = new TransactionInstruction({
      programId: mplId,
      keys: [
        { pubkey: metadataPda, isSigner: false, isWritable: true },
        { pubkey: payer.publicKey, isSigner: true, isWritable: false }, // update_authority
      ],
      data: Buffer.from(updateData),
    });
    const t = new Transaction().add(updateIx);
    t.recentBlockhash = svm.latestBlockhash();
    t.feePayer = payer.publicKey;
    t.sign(payer);
    const r = svm.sendTransaction(t);
    if (isTxFailure(r)) {
      console.log("UPDATE BYTES (hex):", Buffer.from(updateData).toString("hex"));
      console.log("UPDATE LEN:", updateData.length);
      throw new Error(`direct update failed: ${txFailureMessage(r)}`);
    }
    expect(isTxFailure(r)).toBe(false);
  });
});

/**
 * Token-2022 TokenMetadata differential — EM2 Session 4.
 * Validates cpi_t22_token_metadata_initialize emits a CPI byte-equal
 * to Anchor's token_metadata_initialize helper. Pinocchio path uses
 * a precomputed sha256 discriminator (first 8 bytes of
 * "spl_token_metadata_interface:initialize_account") + Borsh-encoded
 * name/symbol/uri serialized into a 1024-byte stack buffer.
 *
 * Setup: pre-allocate a mint with MetadataPointer extension pointing
 * at itself + variable-length space for the metadata blob, init the
 * MetadataPointer + base mint via @solana/spl-token, top up rent for
 * the metadata blob, then call make_metadata. Compare mint state.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  Transaction,
  TransactionInstruction,
  SystemProgram,
} from "@solana/web3.js";
import {
  TOKEN_2022_PROGRAM_ID,
  ExtensionType,
  getMintLen,
  createInitializeMintInstruction,
  createInitializeMetadataPointerInstruction,
} from "@solana/spl-token";
import {
  defineDifferential,
  anchorIxDiscriminator,
  concatBytes,
  Keypair,
  PublicKey,
  LiteSVM,
} from "./differential-harness.ts";

const SRC = join(import.meta.dir, "..", "src", "demo-programs", "t22-token-metadata.rs");
const PROGRAM_ID = "48VXaU9ZU9MqStoezSehvGA7Tqm7wedzDEbMVk2MweGE";

function encodeStringBorsh(s: string): Uint8Array {
  // Borsh: u32 LE length prefix + UTF-8 bytes.
  const bytes = new TextEncoder().encode(s);
  const buf = new Uint8Array(4 + bytes.length);
  new DataView(buf.buffer).setUint32(0, bytes.length, true);
  buf.set(bytes, 4);
  return buf;
}

function expectOk(r: unknown, label: string): void {
  if ((r as { constructor?: { name?: string } })?.constructor?.name === "FailedTransactionMetadata") {
    const meta = (r as { meta?: () => { logs?: () => string[] } }).meta?.();
    throw new Error(`${label} failed | logs=${JSON.stringify(meta?.logs?.() ?? [])}`);
  }
}

defineDifferential({
  fixtureName: "t22-token-metadata",
  programIdBase58: PROGRAM_ID,
  anchorSource: readFileSync(SRC, "utf-8"),
  anchorPackageName: "t22_token_metadata_anchor_diff",
  anchorExtraDeps: `anchor-spl = { version = "0.31", features = ["token_2022"] }
spl-token-metadata-interface = "0.6"`,
  // Default Pinocchio target now that the typed emit lands (was "native"
  // when TokenMetadata was a TODO commentout). Native cargo-build
  // coverage remains via cargo-build.test.ts on the demo.

  setup: async () => ({
    payer: Keypair.generate(),
    mint: Keypair.generate(),
    name: "Anvil Coin",
    symbol: "ANV",
    uri: "https://anvilsol.xyz/em2-test.json",
    renamed: "Anvil Coin v2",
    customValue: "anchor-rust+pinocchio",
  }),

  callScript: async (svm: LiteSVM, ctx, programId: PublicKey) => {
    svm.withDefaultPrograms().withNativeMints();
    svm.airdrop(ctx.payer.publicKey, BigInt(10_000_000_000));

    // Compute extension space. Mint init only allocates base + pointer
    // space; the variable-length metadata blob is written by
    // token_metadata_initialize, which requires more rent — we top up
    // with a follow-up SystemProgram.transfer below. Overestimate the
    // metadata blob size: 4-byte TLV header + 32-byte mint pubkey +
    // 4-byte string length prefix per of (name, symbol, uri) + the
    // string bytes + 4-byte additional_metadata Vec length + slack.
    // Account for the worst-case post-update string sizes since the
    // mint is rent-funded once and the variable-length metadata blob
    // grows with each update_field.
    const baseMintLen = getMintLen([ExtensionType.MetadataPointer]);
    const metadataLen =
      4 + 32 +
      (4 + Math.max(ctx.name.length, ctx.renamed.length)) +
      (4 + ctx.symbol.length) +
      (4 + ctx.uri.length) +
      // additional_metadata: u32 Vec len + 1 entry of (u32+key + u32+value)
      4 +
      (4 + "anvil_marker".length) +
      (4 + ctx.customValue.length) +
      256; // generous slack for TLV alignment
    const mintRent = svm.minimumBalanceForRentExemption(BigInt(baseMintLen));

    // 1. Allocate mint + init MetadataPointer + init base mint
    const setupTx = new Transaction()
      .add(SystemProgram.createAccount({
        fromPubkey: ctx.payer.publicKey,
        newAccountPubkey: ctx.mint.publicKey,
        lamports: Number(mintRent),
        space: baseMintLen,
        programId: TOKEN_2022_PROGRAM_ID,
      }))
      .add(createInitializeMetadataPointerInstruction(
        ctx.mint.publicKey,
        ctx.payer.publicKey,  // authority
        ctx.mint.publicKey,   // metadata stored at the mint itself
        TOKEN_2022_PROGRAM_ID,
      ))
      .add(createInitializeMintInstruction(
        ctx.mint.publicKey,
        2,
        ctx.payer.publicKey,
        ctx.payer.publicKey,
        TOKEN_2022_PROGRAM_ID,
      ))
      .add(SystemProgram.transfer({
        // Transfer extra lamports to cover the variable-length
        // metadata blob (the mint was init'd with only base+pointer
        // space; metadata write needs more).
        fromPubkey: ctx.payer.publicKey,
        toPubkey: ctx.mint.publicKey,
        lamports: Number(svm.minimumBalanceForRentExemption(BigInt(metadataLen))),
      }));
    setupTx.recentBlockhash = svm.latestBlockhash();
    setupTx.feePayer = ctx.payer.publicKey;
    setupTx.sign(ctx.payer, ctx.mint);
    expectOk(svm.sendTransaction(setupTx), "mint + MetadataPointer setup");

    // Helper: send a single-instruction tx for one of our handlers.
    // The 3 update instructions all use the same MakeMetadata-shaped
    // accounts list (payer/update_authority + mint + token_program).
    const send = (ixName: string, payload: Uint8Array, label: string) => {
      const ix = new TransactionInstruction({
        programId,
        keys: [
          { pubkey: ctx.payer.publicKey, isSigner: true, isWritable: true },
          { pubkey: ctx.mint.publicKey, isSigner: false, isWritable: true },
          { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false },
        ],
        data: Buffer.from(
          concatBytes(anchorIxDiscriminator(ixName), payload),
        ),
      });
      const tx = new Transaction().add(ix);
      tx.recentBlockhash = svm.latestBlockhash();
      tx.feePayer = ctx.payer.publicKey;
      tx.sign(ctx.payer);
      expectOk(svm.sendTransaction(tx), label);
    };

    // 2. make_metadata(name, symbol, uri)
    send(
      "make_metadata",
      concatBytes(
        encodeStringBorsh(ctx.name),
        encodeStringBorsh(ctx.symbol),
        encodeStringBorsh(ctx.uri),
      ),
      "make_metadata",
    );

    // 3. rename(new_name) — exercises Field::Name → byte 0 + Borsh value.
    send(
      "rename",
      encodeStringBorsh(ctx.renamed),
      "rename",
    );

    // 4. write_custom_key(value) — exercises Field::Key("anvil_marker") →
    //    byte 3 + Borsh-encoded key + Borsh-encoded value.
    send(
      "write_custom_key",
      encodeStringBorsh(ctx.customValue),
      "write_custom_key",
    );

    // 5. renounce_authority() — exercises OptionalNonZeroPubkey::None
    //    (32 zero bytes) wire form. Last because it makes metadata immutable.
    send("renounce_authority", new Uint8Array(0), "renounce_authority");
  },

  stripDiscriminator: false,
  accountsToCompare: (ctx) => [{ pubkey: ctx.mint.publicKey, label: "mint" }],
});

/**
 * Metaplex create_metadata_accounts_v3 differential — first MPL byte-equal
 * fixture (task #51 / N1).
 *
 * Scope: prove Anvil's hand-rolled cpi_mpl_create_metadata_v3 emit
 * produces byte-identical CPI bytes (discriminator 33 + DataV2 borsh +
 * 6-account meta list) to Anchor's anchor-spl metadata wrapper. The MPL
 * program (loaded as a .so fixture) writes the metadata PDA from scratch;
 * both Anchor and Anvil runs invoke the same MPL ix with the same
 * accounts and same data, so the resulting metadata PDA must byte-equal.
 *
 * What this catches:
 *   - Discriminator drift (33 → wrong byte) → loud byte-mismatch
 *   - DataV2 borsh shape drift (Option-tag, field order) → mismatch
 *   - Account ordering drift (e.g. payer/mint_authority swap) → MPL
 *     refuses the CPI or writes wrong creator → mismatch
 *   - The shorthand `DataV2 { name, symbol, uri, ... }` parser bug fix
 *     (`8bc7270`): pre-fix, this fixture would have written "unknown"
 *     into the metadata while Anchor wrote the user's arg → mismatch
 *
 * Why this fixture is safe:
 *   - The mint is pre-installed by the test (deterministic)
 *   - The metadata PDA is derived from a deterministic mint pubkey, so
 *     both runs target the same PDA
 *   - LiteSVM clock + slot are pinned by the harness so any sysvar-
 *     reading inside MPL sees identical input
 *
 * Aux program: mpl_token_metadata.so (already staged at
 * tests/fixtures/programs/, locked by litesvm-aux-programs.test.ts).
 *
 * If the MPL program updates its on-chain layout (new fields, new
 * discriminator), the .so needs to be re-dumped from a validator
 * running the new program and this fixture re-baselines.
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
  sendSetupTx,
} from "./differential-setup-helpers.ts";
import { isTxFailure, txFailureMessage } from "./litesvm-tx-error.ts";

const SRC = join(import.meta.dir, "..", "src", "demo-programs", "mpl-create-metadata.rs");
const PROGRAM_ID = "HYoSg3PQeyrytfiDptkAoBVbqqqbqouQn6ziJV9bNmjf";
const MPL_PROGRAM_ID = "metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s";

// Borsh String encoding: u32 LE length + UTF-8 bytes.
function borshString(s: string): Uint8Array {
  const bytes = new TextEncoder().encode(s);
  const out = new Uint8Array(4 + bytes.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, bytes.length, true);
  out.set(bytes, 4);
  return out;
}

defineDifferential({
  fixtureName: "mpl-create-metadata",
  programIdBase58: PROGRAM_ID,
  anchorSource: readFileSync(SRC, "utf-8"),
  anchorPackageName: "mpl_create_metadata_anchor_diff",
  // anchor-spl's metadata module is gated behind the `metadata` feature.
  // Without it the Anchor reference build fails before the differential
  // can even start.
  anchorExtraDeps: `anchor-spl = { version = "0.31", features = ["metadata"] }`,
  auxiliaryPrograms: [
    { programId: MPL_PROGRAM_ID, soFilename: "mpl_token_metadata.so" },
  ],

  setup: async () => {
    const payer = Keypair.generate();
    const mint = Keypair.generate();
    const mplProgramId = new PublicKey(MPL_PROGRAM_ID);
    const [metadataPda] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("metadata"),
        mplProgramId.toBuffer(),
        mint.publicKey.toBuffer(),
      ],
      mplProgramId,
    );
    return { payer, mint, metadataPda, mplProgramId };
  },

  callScript: async (svm: LiteSVM, ctx, programId: PublicKey) => {
    svm.withDefaultPrograms();
    svm.airdrop(ctx.payer.publicKey, BigInt(10_000_000_000));

    // 1) Allocate + initialize mint owned by payer (mint authority = payer).
    const setupTx = new Transaction().add(
      ...createMintIxs(svm, ctx.payer.publicKey, ctx.mint.publicKey, 0, ctx.payer.publicKey, ctx.payer.publicKey),
    );
    sendSetupTx(svm, setupTx, ctx.payer.publicKey, [ctx.payer, ctx.mint], "mint-init");

    // 2) Call `make(name, symbol, uri)`. Account order MUST mirror the
    // demo's #[derive(Accounts)] struct: metadata, mint, payer,
    // token_metadata_program, token_program, system_program, rent.
    const name = "Anvil NFT";
    const symbol = "ANV";
    const uri = "ipfs://QmExample";
    const ix = new TransactionInstruction({
      programId,
      keys: [
        { pubkey: ctx.metadataPda, isSigner: false, isWritable: true },
        { pubkey: ctx.mint.publicKey, isSigner: false, isWritable: false },
        { pubkey: ctx.payer.publicKey, isSigner: true, isWritable: true },
        { pubkey: ctx.mplProgramId, isSigner: false, isWritable: false },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
      ],
      data: Buffer.from(concatBytes(
        anchorIxDiscriminator("make"),
        borshString(name),
        borshString(symbol),
        borshString(uri),
      )),
    });
    const tx = new Transaction().add(ix);
    tx.recentBlockhash = svm.latestBlockhash();
    tx.feePayer = ctx.payer.publicKey;
    tx.sign(ctx.payer);
    const r = svm.sendTransaction(tx);
    if (isTxFailure(r)) throw new Error(`make failed: ${txFailureMessage(r)}`);

    // 3) Now rename: invoke update_metadata_accounts_v2. Payer is the
    // update_authority set during create. New DataV2 has different
    // name/symbol/uri/sellerFeeBasisPoints; is_mutable explicitly = true.
    // This exercises BOTH cpi_mpl_create_metadata_v3 (above) AND
    // cpi_mpl_update_metadata_accounts_v2 in one cargo cycle.
    const newName = "Anvil NFT v2";
    const newSymbol = "ANV2";
    const newUri = "ipfs://QmExampleV2";
    const renameIx = new TransactionInstruction({
      programId,
      keys: [
        { pubkey: ctx.metadataPda, isSigner: false, isWritable: true },
        { pubkey: ctx.payer.publicKey, isSigner: true, isWritable: false },
        { pubkey: ctx.mplProgramId, isSigner: false, isWritable: false },
      ],
      data: Buffer.from(concatBytes(
        anchorIxDiscriminator("rename"),
        borshString(newName),
        borshString(newSymbol),
        borshString(newUri),
      )),
    });
    const rtx = new Transaction().add(renameIx);
    rtx.recentBlockhash = svm.latestBlockhash();
    rtx.feePayer = ctx.payer.publicKey;
    rtx.sign(ctx.payer);
    const r2 = svm.sendTransaction(rtx);
    if (isTxFailure(r2)) throw new Error(`rename failed: ${txFailureMessage(r2)}`);
  },

  // The metadata PDA is what MPL writes — that's the byte-equal anchor.
  // The mint stays untouched (its mint_authority pubkey is what MPL reads,
  // but MPL doesn't write to it).
  stripDiscriminator: false, // MPL metadata accounts don't have an Anchor 8-byte discriminator.
  accountsToCompare: (ctx) => [
    { pubkey: ctx.metadataPda, label: "metadata_pda" },
  ],
});

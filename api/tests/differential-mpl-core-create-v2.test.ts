/**
 * MPL Core CreateV2 byte-equal differential (task #48 S1, validated).
 *
 * Scope: prove Anvil's hand-rolled cpi_mpl_core_create_v2 emit produces
 * byte-identical asset account bytes to Anchor's mpl-core CpiBuilder
 * reference build, both invoked against the real mpl_core.so loaded into
 * LiteSVM.
 *
 * What this catches:
 *   - Discriminator drift (20 → wrong byte) → MPL refuses or mis-types
 *   - Borsh field order drift (data_state, name, uri, plugins, xpa) → MPL
 *     misreads the args → wrong write or refusal
 *   - 8-account meta order drift (asset, collection, authority, payer,
 *     owner, update_authority, system_program, log_wrapper) → MPL refuses
 *     or asset becomes owned by the wrong key
 *   - MPL_CORE_ID readonly-fallback drift for None optional slots →
 *     account-list size mismatch → ix decode fail
 *
 * Aux program: mpl_core.so (848KB, dumped from mainnet at
 * CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d).
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

const SRC = join(import.meta.dir, "..", "src", "demo-programs", "mpl-core-create-v2.rs");
const PROGRAM_ID = "2C8CSADSG723SRbT2EisHGtZPniw2afXF3wtyRDUeW9A";
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
  fixtureName: "mpl-core-create-v2",
  programIdBase58: PROGRAM_ID,
  anchorSource: readFileSync(SRC, "utf-8"),
  anchorPackageName: "mpl_core_create_v2_anchor_diff",
  // mpl-core's "anchor" feature swaps the BorshSerialize/Deserialize
  // derives for anchor-lang's AnchorSerialize/Deserialize, sidestepping
  // the borsh-1.6 (via solana-address 2.x) vs borsh-1.5 conflict that
  // surfaces when the program also depends on anchor-lang directly.
  // Using 0.11.2 to align with the newer solana-toolchain version the
  // sbf builder targets — 0.10.1 still hits a Pubkey type-conflict
  // between solana-pubkey 2.x and anchor 0.31's solana-program reexport.
  anchorExtraDeps: `mpl-core = { version = "0.11", features = ["anchor"] }`,
  auxiliaryPrograms: [
    { programId: MPL_CORE_ID, soFilename: "mpl_core.so" },
  ],

  setup: async () => {
    const payer = Keypair.generate();
    const asset = Keypair.generate();
    const mplCoreProgramId = new PublicKey(MPL_CORE_ID);
    return { payer, asset, mplCoreProgramId };
  },

  callScript: async (svm: LiteSVM, ctx, programId: PublicKey) => {
    svm.withDefaultPrograms();
    svm.airdrop(ctx.payer.publicKey, BigInt(10_000_000_000));

    // mint_asset(name, uri) — account order matches MintAsset struct in
    // the demo: asset (signer), payer (signer), system_program, mpl_core_program.
    const name = "Anvil Core Asset";
    const uri = "https://example.com/anvil-core.json";
    const ix = new TransactionInstruction({
      programId,
      keys: [
        { pubkey: ctx.asset.publicKey, isSigner: true, isWritable: true },
        { pubkey: ctx.payer.publicKey, isSigner: true, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        { pubkey: ctx.mplCoreProgramId, isSigner: false, isWritable: false },
      ],
      data: Buffer.from(concatBytes(
        anchorIxDiscriminator("mint_asset"),
        borshString(name),
        borshString(uri),
      )),
    });
    const tx = new Transaction().add(ix);
    tx.recentBlockhash = svm.latestBlockhash();
    tx.feePayer = ctx.payer.publicKey;
    tx.sign(ctx.payer, ctx.asset);
    const r = svm.sendTransaction(tx);
    if (isTxFailure(r)) throw new Error(`mint_asset failed: ${txFailureMessage(r)}`);
  },

  stripDiscriminator: false,
  accountsToCompare: (ctx) => [
    { pubkey: ctx.asset.publicKey, label: "asset_after_create" },
  ],
});

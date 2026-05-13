/**
 * Token-2022 MetadataPointer extension init differential — EM2
 * Session 2 deliverable. Validates that the new
 * `cpi_t22_metadata_pointer_initialize` IR kind emits a CPI that
 * byte-equals what Anchor's `metadata_pointer_initialize` helper
 * produces when run end-to-end.
 *
 * Setup: pre-allocate a mint account with space for the
 * MetadataPointer extension. The program calls
 * `make_metadata_pointer(authority=payer, metadata_address=metadata)`
 * once. We byte-compare the resulting mint TLV bytes between the
 * Anchor-built and Anvil-emitted programs.
 *
 * If the Pinocchio hand-rolled parent disc 39 + sub-disc 0 + double
 * OptionalNonZeroPubkey payload OR the Native
 * `spl_token_2022::extension::metadata_pointer::instruction::initialize`
 * builder diverged from Anchor's helper, the resulting mint TLV bytes
 * would differ and this gate would catch it.
 *
 * NOTE: anchor-spl does not expose `metadata_pointer_update`, so the
 * Update sub-instruction is out of scope here. A raw-CPI typed IR
 * kind for update can be added later if a real-world fixture surfaces
 * it (see cpi-detector.ts extractT22MetadataPointerInitialize note).
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
} from "@solana/spl-token";
import {
  defineDifferential,
  anchorIxDiscriminator,
  Keypair,
  PublicKey,
  LiteSVM,
} from "./differential-harness.ts";
import { isTxFailure, txFailureMessage } from "./litesvm-tx-error.ts";

const SRC = join(
  import.meta.dir,
  "..",
  "src",
  "demo-programs",
  "t22-metadata-pointer.rs",
);
const PROGRAM_ID = "3xRtNVv3oUfz6C6w7KroQRENraPRG4gRwmyqniy8U6H1";

defineDifferential({
  fixtureName: "t22-metadata-pointer",
  programIdBase58: PROGRAM_ID,
  anchorSource: readFileSync(SRC, "utf-8"),
  anchorPackageName: "t22_metadata_pointer_anchor_diff",
  anchorExtraDeps: 'anchor-spl = { version = "0.31", features = ["token_2022", "token_2022_extensions"] }',

  setup: async () => {
    const payer = Keypair.generate();
    const mint = Keypair.generate();
    const metadata = Keypair.generate();
    return { payer, mint, metadata };
  },

  callScript: async (svm: LiteSVM, ctx, programId: PublicKey) => {
    svm.withDefaultPrograms().withNativeMints();
    svm.airdrop(ctx.payer.publicKey, BigInt(10_000_000_000));

    const mintLen = getMintLen([ExtensionType.MetadataPointer]);
    const mintRent = svm.minimumBalanceForRentExemption(BigInt(mintLen));
    const setupTx = new Transaction().add(
      SystemProgram.createAccount({
        fromPubkey: ctx.payer.publicKey,
        newAccountPubkey: ctx.mint.publicKey,
        lamports: Number(mintRent),
        space: mintLen,
        programId: TOKEN_2022_PROGRAM_ID,
      }),
    );
    setupTx.recentBlockhash = svm.latestBlockhash();
    setupTx.feePayer = ctx.payer.publicKey;
    setupTx.sign(ctx.payer, ctx.mint);
    const r1 = svm.sendTransaction(setupTx);
    if (isTxFailure(r1)) {
      throw new Error(`t22-metadata-pointer setup failed: ${txFailureMessage(r1)}`);
    }

    const ix = new TransactionInstruction({
      programId,
      keys: [
        // Account order matches MakeMetadataPointer struct: payer,
        // mint, metadata, token_program.
        { pubkey: ctx.payer.publicKey, isSigner: true, isWritable: true },
        { pubkey: ctx.mint.publicKey, isSigner: false, isWritable: true },
        { pubkey: ctx.metadata.publicKey, isSigner: false, isWritable: false },
        { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false },
      ],
      data: Buffer.from(anchorIxDiscriminator("make_metadata_pointer")),
    });
    const tx = new Transaction().add(ix);
    tx.recentBlockhash = svm.latestBlockhash();
    tx.feePayer = ctx.payer.publicKey;
    tx.sign(ctx.payer);
    const r2 = svm.sendTransaction(tx);
    if (isTxFailure(r2)) {
      throw new Error(`make_metadata_pointer failed: ${txFailureMessage(r2)}`);
    }
  },

  stripDiscriminator: false,
  accountsToCompare: (ctx) => [{ pubkey: ctx.mint.publicKey, label: "mint" }],
});

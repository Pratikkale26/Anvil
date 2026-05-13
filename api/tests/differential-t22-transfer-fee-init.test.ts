/**
 * Token-2022 TransferFee extension differential — second EM2
 * deliverable. Validates both `cpi_t22_transfer_fee_initialize` and
 * `cpi_t22_transfer_fee_set_fee` IR kinds emit byte-equal CPIs vs
 * Anchor's `transfer_fee_initialize` / `transfer_fee_set` helpers.
 *
 * Setup: pre-allocate a mint with TransferFee extension space, run
 * make_transfer_fee + update_transfer_fee in sequence, then byte-
 * compare the mint account state. The Token-2022 program writes the
 * extension TLV during init and updates the pending-fee fields on
 * set_fee — diverging emit on either CPI would surface as different
 * mint bytes.
 *
 * Pinocchio variant exercises the hand-rolled discriminators (26+0
 * for init, 26+5 for set) + the variable-length COption payload for
 * the two authority pubkeys.
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
} from "@solana/spl-token";
import {
  defineDifferential,
  anchorIxDiscriminator,
  encodeU64LE,
  concatBytes,
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
  "t22-transfer-fee-init.rs",
);
const PROGRAM_ID = "Tf1mC7QPzUNqx4M2YxYx4dXq8j5wvwZ7VtWJTeyWfuV";

function encodeU16LE(n: number): Uint8Array {
  const buf = new Uint8Array(2);
  new DataView(buf.buffer).setUint16(0, n, true);
  return buf;
}

defineDifferential({
  fixtureName: "t22-transfer-fee-init",
  programIdBase58: PROGRAM_ID,
  anchorSource: readFileSync(SRC, "utf-8"),
  anchorPackageName: "t22_transfer_fee_init_anchor_diff",
  anchorExtraDeps: 'anchor-spl = { version = "0.31", features = ["token_2022"] }',

  setup: async () => {
    const payer = Keypair.generate();
    const mint = Keypair.generate();
    return { payer, mint };
  },

  callScript: async (svm: LiteSVM, ctx, programId: PublicKey) => {
    svm.withDefaultPrograms().withNativeMints();
    svm.airdrop(ctx.payer.publicKey, BigInt(10_000_000_000));

    // Allocate mint with TransferFee extension space.
    const mintLen = getMintLen([ExtensionType.TransferFeeConfig]);
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
      throw new Error("t22-tf-init setup failed: " + JSON.stringify(r1));
    }

    // make_transfer_fee(transfer_fee_basis_points=100, maximum_fee=1_000_000)
    const initIx = new TransactionInstruction({
      programId,
      keys: [
        { pubkey: ctx.payer.publicKey, isSigner: true, isWritable: true },
        { pubkey: ctx.mint.publicKey, isSigner: false, isWritable: true },
        { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false },
      ],
      data: Buffer.from(
        concatBytes(
          anchorIxDiscriminator("make_transfer_fee"),
          encodeU16LE(100),
          encodeU64LE(1_000_000n),
        ),
      ),
    });
    const initTx = new Transaction().add(initIx);
    initTx.recentBlockhash = svm.latestBlockhash();
    initTx.feePayer = ctx.payer.publicKey;
    initTx.sign(ctx.payer);
    const rInit = svm.sendTransaction(initTx);
    if (rInit?.constructor?.name === "FailedTransactionMetadata") {
      const meta = (rInit as { meta?: () => { logs?: () => string[] } }).meta?.();
      const logs = meta?.logs?.() ?? [];
      throw new Error(
        `make_transfer_fee failed | logs=${JSON.stringify(logs)}`,
      );
    }

    // Initialize the base mint header now that the extension has been
    // configured. Token-2022 requires this between extension init and
    // any extension-management call. We do it via @solana/spl-token
    // (NOT via our typed IR) — initialize_mint isn't part of EM2's
    // Session 1 scope; this just gets the mint into a state where the
    // SetTransferFee extension instruction is accepted.
    const mintInitTx = new Transaction().add(
      createInitializeMintInstruction(
        ctx.mint.publicKey,
        2,
        ctx.payer.publicKey,
        ctx.payer.publicKey,
        TOKEN_2022_PROGRAM_ID,
      ),
    );
    mintInitTx.recentBlockhash = svm.latestBlockhash();
    mintInitTx.feePayer = ctx.payer.publicKey;
    mintInitTx.sign(ctx.payer);
    const rMintInit = svm.sendTransaction(mintInitTx);
    if (rMintInit?.constructor?.name === "FailedTransactionMetadata") {
      const meta = (rMintInit as { meta?: () => { logs?: () => string[] } }).meta?.();
      const logs = meta?.logs?.() ?? [];
      throw new Error(
        `initialize_mint (test setup) failed | logs=${JSON.stringify(logs)}`,
      );
    }

    // update_transfer_fee(transfer_fee_basis_points=200, maximum_fee=2_000_000)
    // The mint is now extension-initialised AND base-initialised;
    // set_fee schedules a future-epoch fee bump.
    const updateIx = new TransactionInstruction({
      programId,
      keys: [
        { pubkey: ctx.payer.publicKey, isSigner: true, isWritable: false },
        { pubkey: ctx.mint.publicKey, isSigner: false, isWritable: true },
        { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false },
      ],
      data: Buffer.from(
        concatBytes(
          anchorIxDiscriminator("update_transfer_fee"),
          encodeU16LE(200),
          encodeU64LE(2_000_000n),
        ),
      ),
    });
    const updateTx = new Transaction().add(updateIx);
    updateTx.recentBlockhash = svm.latestBlockhash();
    updateTx.feePayer = ctx.payer.publicKey;
    updateTx.sign(ctx.payer);
    const rUpdate = svm.sendTransaction(updateTx);
    if (rUpdate?.constructor?.name === "FailedTransactionMetadata") {
      const meta = (rUpdate as { meta?: () => { logs?: () => string[] } }).meta?.();
      const logs = meta?.logs?.() ?? [];
      throw new Error(
        `update_transfer_fee failed | logs=${JSON.stringify(logs)}`,
      );
    }
  },

  stripDiscriminator: false,
  accountsToCompare: (ctx) => [{ pubkey: ctx.mint.publicKey, label: "mint" }],
});

/**
 * Token-2022 TransferFee — extras differential (EM2 Session 1b).
 * Validates the 3 CPIs added beyond init+set_fee:
 *   - cpi_t22_transfer_checked_with_fee
 *   - cpi_t22_withdraw_withheld_tokens_from_mint
 *   - cpi_t22_harvest_withheld_tokens_to_mint
 *
 * Setup: build a TransferFee mint via @solana/spl-token (NOT via the
 * typed IR — the init differential gates that path). Mint tokens to
 * a source account, then drive our program through the fee_transfer
 * → harvest_fees → withdraw_fees sequence and byte-compare the mint
 * + destination account state between Anchor and Anvil-Pinocchio.
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
  getAccountLen,
  createInitializeAccountInstruction,
  createInitializeMintInstruction,
  createMintToCheckedInstruction,
  createInitializeTransferFeeConfigInstruction,
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

function expectOk(r: unknown, label: string): void {
  if ((r as { constructor?: { name?: string } })?.constructor?.name === "FailedTransactionMetadata") {
    const meta = (r as { meta?: () => { logs?: () => string[] } }).meta?.();
    const logs = meta?.logs?.() ?? [];
    throw new Error(`${label} failed | logs=${JSON.stringify(logs)}`);
  }
}

defineDifferential({
  fixtureName: "t22-transfer-fee-extras",
  programIdBase58: PROGRAM_ID,
  anchorSource: readFileSync(SRC, "utf-8"),
  anchorPackageName: "t22_transfer_fee_extras_anchor_diff",
  anchorExtraDeps: 'anchor-spl = { version = "0.31", features = ["token_2022"] }',

  setup: async () => ({
    payer: Keypair.generate(),
    mint: Keypair.generate(),
    src1: Keypair.generate(),
    src2: Keypair.generate(),
    dst: Keypair.generate(),
    feeRecipient: Keypair.generate(),
  }),

  callScript: async (svm: LiteSVM, ctx, programId: PublicKey) => {
    svm.withDefaultPrograms().withNativeMints();
    svm.airdrop(ctx.payer.publicKey, BigInt(10_000_000_000));

    // 1. Mint allocation + TransferFee extension init + base mint init.
    const mintLen = getMintLen([ExtensionType.TransferFeeConfig]);
    const mintRent = svm.minimumBalanceForRentExemption(BigInt(mintLen));
    // Token accounts on TransferFee mints need TransferFeeAmount extension
    // space to track withheld fees per-account.
    const tokenAcctLen = getAccountLen([ExtensionType.TransferFeeAmount]);
    const ataRent = svm.minimumBalanceForRentExemption(BigInt(tokenAcctLen));
    const allocAndInitTx = new Transaction()
      .add(SystemProgram.createAccount({
        fromPubkey: ctx.payer.publicKey,
        newAccountPubkey: ctx.mint.publicKey,
        lamports: Number(mintRent),
        space: mintLen,
        programId: TOKEN_2022_PROGRAM_ID,
      }))
      .add(createInitializeTransferFeeConfigInstruction(
        ctx.mint.publicKey,
        ctx.payer.publicKey,  // transfer_fee_config_authority
        ctx.payer.publicKey,  // withdraw_withheld_authority
        100,                  // basis points
        1_000_000n,           // max fee
        TOKEN_2022_PROGRAM_ID,
      ))
      .add(createInitializeMintInstruction(
        ctx.mint.publicKey,
        2,
        ctx.payer.publicKey,
        ctx.payer.publicKey,
        TOKEN_2022_PROGRAM_ID,
      ));
    allocAndInitTx.recentBlockhash = svm.latestBlockhash();
    allocAndInitTx.feePayer = ctx.payer.publicKey;
    allocAndInitTx.sign(ctx.payer, ctx.mint);
    expectOk(svm.sendTransaction(allocAndInitTx), "mint setup");

    // 2. Token accounts: src1, dst, feeRecipient.
    const acctTx = new Transaction()
      .add(SystemProgram.createAccount({
        fromPubkey: ctx.payer.publicKey,
        newAccountPubkey: ctx.src1.publicKey,
        lamports: Number(ataRent),
        space: tokenAcctLen,
        programId: TOKEN_2022_PROGRAM_ID,
      }))
      .add(createInitializeAccountInstruction(
        ctx.src1.publicKey, ctx.mint.publicKey, ctx.payer.publicKey, TOKEN_2022_PROGRAM_ID,
      ))
      .add(SystemProgram.createAccount({
        fromPubkey: ctx.payer.publicKey,
        newAccountPubkey: ctx.dst.publicKey,
        lamports: Number(ataRent),
        space: tokenAcctLen,
        programId: TOKEN_2022_PROGRAM_ID,
      }))
      .add(createInitializeAccountInstruction(
        ctx.dst.publicKey, ctx.mint.publicKey, ctx.payer.publicKey, TOKEN_2022_PROGRAM_ID,
      ))
      .add(SystemProgram.createAccount({
        fromPubkey: ctx.payer.publicKey,
        newAccountPubkey: ctx.feeRecipient.publicKey,
        lamports: Number(ataRent),
        space: tokenAcctLen,
        programId: TOKEN_2022_PROGRAM_ID,
      }))
      .add(createInitializeAccountInstruction(
        ctx.feeRecipient.publicKey, ctx.mint.publicKey, ctx.payer.publicKey, TOKEN_2022_PROGRAM_ID,
      ))
      .add(createMintToCheckedInstruction(
        ctx.mint.publicKey, ctx.src1.publicKey, ctx.payer.publicKey,
        500_000n, 2, [], TOKEN_2022_PROGRAM_ID,
      ));
    acctTx.recentBlockhash = svm.latestBlockhash();
    acctTx.feePayer = ctx.payer.publicKey;
    acctTx.sign(ctx.payer, ctx.src1, ctx.dst, ctx.feeRecipient);
    expectOk(svm.sendTransaction(acctTx), "token accounts setup");

    // 3. fee_transfer(amount=10_000, decimals=2, fee=100)
    //    100 basis points of 10_000 = 100; max=1_000_000 so fee==100.
    const feeTransferIx = new TransactionInstruction({
      programId,
      keys: [
        { pubkey: ctx.payer.publicKey, isSigner: true, isWritable: false },
        { pubkey: ctx.mint.publicKey, isSigner: false, isWritable: false },
        { pubkey: ctx.src1.publicKey, isSigner: false, isWritable: true },
        { pubkey: ctx.dst.publicKey, isSigner: false, isWritable: true },
        { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false },
      ],
      data: Buffer.from(
        concatBytes(
          anchorIxDiscriminator("fee_transfer"),
          encodeU64LE(10_000n),
          new Uint8Array([2]),
          encodeU64LE(100n),
        ),
      ),
    });
    const feeTransferTx = new Transaction().add(feeTransferIx);
    feeTransferTx.recentBlockhash = svm.latestBlockhash();
    feeTransferTx.feePayer = ctx.payer.publicKey;
    feeTransferTx.sign(ctx.payer);
    expectOk(svm.sendTransaction(feeTransferTx), "fee_transfer");

    // 4. harvest_fees — sweeps fees withheld on dst into the mint's
    //    pool. Single source (the dst token account that received
    //    the 100-token fee from the previous fee_transfer call).
    //    Pinocchio variant exercises the new match-on-N branch
    //    (N=1 here) instead of the old TODO commentout.
    const harvestIx = new TransactionInstruction({
      programId,
      keys: [
        { pubkey: ctx.mint.publicKey, isSigner: false, isWritable: true },
        { pubkey: ctx.dst.publicKey, isSigner: false, isWritable: true },
        { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false },
      ],
      data: Buffer.from(anchorIxDiscriminator("harvest_fees")),
    });
    const harvestTx = new Transaction().add(harvestIx);
    harvestTx.recentBlockhash = svm.latestBlockhash();
    harvestTx.feePayer = ctx.payer.publicKey;
    harvestTx.sign(ctx.payer);
    expectOk(svm.sendTransaction(harvestTx), "harvest_fees");

    // 5. withdraw_fees — drain mint's withheld pool to feeRecipient.
    const withdrawIx = new TransactionInstruction({
      programId,
      keys: [
        { pubkey: ctx.payer.publicKey, isSigner: true, isWritable: false },
        { pubkey: ctx.mint.publicKey, isSigner: false, isWritable: true },
        { pubkey: ctx.feeRecipient.publicKey, isSigner: false, isWritable: true },
        { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false },
      ],
      data: Buffer.from(anchorIxDiscriminator("withdraw_fees")),
    });
    const withdrawTx = new Transaction().add(withdrawIx);
    withdrawTx.recentBlockhash = svm.latestBlockhash();
    withdrawTx.feePayer = ctx.payer.publicKey;
    withdrawTx.sign(ctx.payer);
    expectOk(svm.sendTransaction(withdrawTx), "withdraw_fees");
  },

  stripDiscriminator: false,
  accountsToCompare: (ctx) => [
    { pubkey: ctx.mint.publicKey, label: "mint" },
    { pubkey: ctx.src1.publicKey, label: "src1" },
    { pubkey: ctx.dst.publicKey, label: "dst" },
    { pubkey: ctx.feeRecipient.publicKey, label: "feeRecipient" },
  ],
});

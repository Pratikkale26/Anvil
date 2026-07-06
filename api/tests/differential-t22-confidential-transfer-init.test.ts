/**
 * Token-2022 ConfidentialTransferMint init differential.
 *
 * Validates cpi_t22_confidential_transfer_initialize_mint emits a CPI
 * byte-equal to spl_token_2022's confidential_transfer::instruction::
 * initialize_mint builder, end-to-end against the real Token-2022 program in
 * LiteSVM. Only the INIT slot (Pod payload: OptionalNonZeroPubkey authority +
 * auto_approve bool + OptionalNonZeroElGamalPubkey auditor) — the confidential
 * Configure/Deposit/Withdraw/Transfer ops need a zk-proof prelude, stay lint.
 *
 * The reference routes through anchor-spl's re-exported spl_token_2022 (a
 * direct spl-token-2022 dep resolves a solana version incompatible with
 * anchor-lang and fails the confidential build). Setup allocates a mint with
 * ConfidentialTransferMint extension space; byte-compare the mint TLV after
 * the program's confidential-init CPI.
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

const SRC = join(import.meta.dir, "..", "src", "demo-programs", "t22-confidential-transfer-init.rs");
const PROGRAM_ID = "7EPEQWHoYysCt5PtVXVsi3jmgteWXScfnnRjLLCLZTYY";

defineDifferential({
  fixtureName: "t22-confidential-transfer-init",
  programIdBase58: PROGRAM_ID,
  anchorSource: readFileSync(SRC, "utf-8"),
  anchorPackageName: "t22_confidential_transfer_init_demo",
  anchorExtraDeps: 'anchor-spl = { version = "0.31", features = ["token_2022"] }',

  setup: async () => ({
    payer: Keypair.generate(),
    authority: Keypair.generate(),
    mint: Keypair.generate(),
  }),

  callScript: async (svm: LiteSVM, ctx, programId: PublicKey) => {
    svm.withDefaultPrograms().withNativeMints();
    svm.airdrop(ctx.payer.publicKey, BigInt(10_000_000_000));

    const mintLen = getMintLen([ExtensionType.ConfidentialTransferMint]);
    const rent = svm.minimumBalanceForRentExemption(BigInt(mintLen));
    const setupTx = new Transaction().add(SystemProgram.createAccount({
      fromPubkey: ctx.payer.publicKey,
      newAccountPubkey: ctx.mint.publicKey,
      lamports: Number(rent),
      space: mintLen,
      programId: TOKEN_2022_PROGRAM_ID,
    }));
    setupTx.recentBlockhash = svm.latestBlockhash();
    setupTx.feePayer = ctx.payer.publicKey;
    setupTx.sign(ctx.payer, ctx.mint);
    const r1 = svm.sendTransaction(setupTx);
    if (isTxFailure(r1)) throw new Error(`ct mint alloc failed: ${txFailureMessage(r1)}`);

    const ix = new TransactionInstruction({
      programId,
      keys: [
        { pubkey: ctx.mint.publicKey, isSigner: false, isWritable: true },
        { pubkey: ctx.authority.publicKey, isSigner: false, isWritable: false },
        { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false },
      ],
      data: Buffer.from(anchorIxDiscriminator("init_no_auditor")),
    });
    const tx = new Transaction().add(ix);
    tx.recentBlockhash = svm.latestBlockhash();
    tx.feePayer = ctx.payer.publicKey;
    tx.sign(ctx.payer);
    const r2 = svm.sendTransaction(tx);
    if (isTxFailure(r2)) throw new Error(`init_no_auditor failed: ${txFailureMessage(r2)}`);
  },

  stripDiscriminator: false,
  accountsToCompare: (ctx) => [{ pubkey: ctx.mint.publicKey, label: "ct_mint" }],
});

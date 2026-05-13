/**
 * Token-2022 TransferHook extension init + update differential —
 * EM2 Session 2 deliverable. Validates that the new
 * `cpi_t22_transfer_hook_initialize` + `cpi_t22_transfer_hook_update`
 * IR kinds emit CPIs that byte-equal what Anchor's
 * `transfer_hook_initialize` / `transfer_hook_update` helpers produce
 * when run end-to-end.
 *
 * Setup: pre-allocate a mint with space for the TransferHook
 * extension. The program first calls `make_transfer_hook` (Init —
 * authority = payer, hook program = hook_program), then
 * `update_transfer_hook` (Update — new hook = new_hook_program). The
 * resulting mint TLV bytes get byte-compared between Anchor-built
 * and Anvil-emitted programs.
 *
 * If the Pinocchio hand-rolled parent disc 36 + subcommand byte 0/1
 * + OptionalNonZeroPubkey payload OR the Native
 * `spl_token_2022::extension::transfer_hook::instruction::initialize
 * / update` builders diverged from Anchor's helpers, the resulting
 * mint TLV bytes would differ and this gate would catch it.
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
  createInitializeMint2Instruction,
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
  "t22-transfer-hook.rs",
);
const PROGRAM_ID = "Ei3rChupo8BEWEnFZjVHEBRZvg1FmoVKM9kCnHJdXRFc";

defineDifferential({
  fixtureName: "t22-transfer-hook",
  programIdBase58: PROGRAM_ID,
  anchorSource: readFileSync(SRC, "utf-8"),
  anchorPackageName: "t22_transfer_hook_anchor_diff",
  anchorExtraDeps: 'anchor-spl = { version = "0.31", features = ["token_2022", "token_2022_extensions"] }',

  setup: async () => {
    const payer = Keypair.generate();
    const mint = Keypair.generate();
    const hookProgram = Keypair.generate();
    const newHookProgram = Keypair.generate();
    return { payer, mint, hookProgram, newHookProgram };
  },

  callScript: async (svm: LiteSVM, ctx, programId: PublicKey) => {
    svm.withDefaultPrograms().withNativeMints();
    svm.airdrop(ctx.payer.publicKey, BigInt(10_000_000_000));

    const mintLen = getMintLen([ExtensionType.TransferHook]);
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
      throw new Error(`t22-transfer-hook setup failed: ${txFailureMessage(r1)}`);
    }

    // Init: account order matches MakeTransferHook struct.
    const initIx = new TransactionInstruction({
      programId,
      keys: [
        { pubkey: ctx.payer.publicKey, isSigner: true, isWritable: true },
        { pubkey: ctx.mint.publicKey, isSigner: false, isWritable: true },
        { pubkey: ctx.hookProgram.publicKey, isSigner: false, isWritable: false },
        { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false },
      ],
      data: Buffer.from(anchorIxDiscriminator("make_transfer_hook")),
    });
    const tx1 = new Transaction().add(initIx);
    tx1.recentBlockhash = svm.latestBlockhash();
    tx1.feePayer = ctx.payer.publicKey;
    tx1.sign(ctx.payer);
    const r2 = svm.sendTransaction(tx1);
    if (isTxFailure(r2)) {
      throw new Error(`make_transfer_hook failed: ${txFailureMessage(r2)}`);
    }

    // Update is only valid on a mint that has already been
    // InitializeMint'd (the Token-2022 program rejects the Update
    // sub-instruction with UninitializedAccount otherwise). The
    // extension Init we just ran configured the TransferHook TLV; we
    // now finalize the base mint so Update can run.
    const initMintIx = createInitializeMint2Instruction(
      ctx.mint.publicKey,
      6,                       // decimals — value doesn't affect this test
      ctx.payer.publicKey,     // mint authority
      null,                    // freeze authority
      TOKEN_2022_PROGRAM_ID,
    );
    const initMintTx = new Transaction().add(initMintIx);
    initMintTx.recentBlockhash = svm.latestBlockhash();
    initMintTx.feePayer = ctx.payer.publicKey;
    initMintTx.sign(ctx.payer);
    const rIM = svm.sendTransaction(initMintTx);
    if (isTxFailure(rIM)) {
      throw new Error(`InitializeMint2 (between hook init and update) failed: ${txFailureMessage(rIM)}`);
    }

    // Update: account order matches UpdateTransferHook struct.
    // The payer (init authority) signs the update.
    const updateIx = new TransactionInstruction({
      programId,
      keys: [
        { pubkey: ctx.mint.publicKey, isSigner: false, isWritable: true },
        { pubkey: ctx.payer.publicKey, isSigner: true, isWritable: false },
        { pubkey: ctx.newHookProgram.publicKey, isSigner: false, isWritable: false },
        { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false },
      ],
      data: Buffer.from(anchorIxDiscriminator("update_transfer_hook")),
    });
    const tx2 = new Transaction().add(updateIx);
    tx2.recentBlockhash = svm.latestBlockhash();
    tx2.feePayer = ctx.payer.publicKey;
    tx2.sign(ctx.payer);
    const r3 = svm.sendTransaction(tx2);
    if (isTxFailure(r3)) {
      throw new Error(`update_transfer_hook failed: ${txFailureMessage(r3)}`);
    }
  },

  stripDiscriminator: false,
  accountsToCompare: (ctx) => [{ pubkey: ctx.mint.publicKey, label: "mint" }],
});

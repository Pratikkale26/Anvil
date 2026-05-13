/**
 * Token-2022 GroupMemberPointer extension init + update differential —
 * EM2 Session 3 deliverable. Validates the new
 * `cpi_t22_group_member_pointer_initialize` +
 * `cpi_t22_group_member_pointer_update` IR kinds. Identical wire
 * shape to GroupPointer, parent disc 41.
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
  "t22-group-member-pointer.rs",
);
const PROGRAM_ID = "3Y8d52oF7TL3vYDBWjWARyHQ46MNUQzBRTVa1Zw19u7c";

defineDifferential({
  fixtureName: "t22-group-member-pointer",
  programIdBase58: PROGRAM_ID,
  anchorSource: readFileSync(SRC, "utf-8"),
  anchorPackageName: "t22_group_member_pointer_anchor_diff",
  anchorExtraDeps: 'anchor-spl = { version = "0.31", features = ["token_2022", "token_2022_extensions"] }',

  setup: async () => {
    const payer = Keypair.generate();
    const mint = Keypair.generate();
    const memberAccount = Keypair.generate();
    const newMemberAccount = Keypair.generate();
    return { payer, mint, memberAccount, newMemberAccount };
  },

  callScript: async (svm: LiteSVM, ctx, programId: PublicKey) => {
    svm.withDefaultPrograms().withNativeMints();
    svm.airdrop(ctx.payer.publicKey, BigInt(10_000_000_000));

    const mintLen = getMintLen([ExtensionType.GroupMemberPointer]);
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
      throw new Error(`t22-group-member-pointer setup failed: ${txFailureMessage(r1)}`);
    }

    const initIx = new TransactionInstruction({
      programId,
      keys: [
        { pubkey: ctx.payer.publicKey, isSigner: true, isWritable: true },
        { pubkey: ctx.mint.publicKey, isSigner: false, isWritable: true },
        { pubkey: ctx.memberAccount.publicKey, isSigner: false, isWritable: false },
        { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false },
      ],
      data: Buffer.from(anchorIxDiscriminator("make_group_member_pointer")),
    });
    const tx1 = new Transaction().add(initIx);
    tx1.recentBlockhash = svm.latestBlockhash();
    tx1.feePayer = ctx.payer.publicKey;
    tx1.sign(ctx.payer);
    const r2 = svm.sendTransaction(tx1);
    if (isTxFailure(r2)) {
      throw new Error(`make_group_member_pointer failed: ${txFailureMessage(r2)}`);
    }

    const initMintIx = createInitializeMint2Instruction(
      ctx.mint.publicKey,
      6,
      ctx.payer.publicKey,
      null,
      TOKEN_2022_PROGRAM_ID,
    );
    const initMintTx = new Transaction().add(initMintIx);
    initMintTx.recentBlockhash = svm.latestBlockhash();
    initMintTx.feePayer = ctx.payer.publicKey;
    initMintTx.sign(ctx.payer);
    const rIM = svm.sendTransaction(initMintTx);
    if (isTxFailure(rIM)) {
      throw new Error(`InitializeMint2 (between member init and update) failed: ${txFailureMessage(rIM)}`);
    }

    const updateIx = new TransactionInstruction({
      programId,
      keys: [
        { pubkey: ctx.mint.publicKey, isSigner: false, isWritable: true },
        { pubkey: ctx.payer.publicKey, isSigner: true, isWritable: false },
        { pubkey: ctx.newMemberAccount.publicKey, isSigner: false, isWritable: false },
        { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false },
      ],
      data: Buffer.from(anchorIxDiscriminator("update_group_member_pointer")),
    });
    const tx2 = new Transaction().add(updateIx);
    tx2.recentBlockhash = svm.latestBlockhash();
    tx2.feePayer = ctx.payer.publicKey;
    tx2.sign(ctx.payer);
    const r3 = svm.sendTransaction(tx2);
    if (isTxFailure(r3)) {
      throw new Error(`update_group_member_pointer failed: ${txFailureMessage(r3)}`);
    }
  },

  stripDiscriminator: false,
  accountsToCompare: (ctx) => [{ pubkey: ctx.mint.publicKey, label: "mint" }],
});

/**
 * Token-2022 GroupPointer extension init differential — EM2 Session 3
 * deliverable. Validates the new `cpi_t22_group_pointer_initialize`
 * IR kind. Same OptionalNonZeroPubkey wire layout as
 * MetadataPointer/TransferHook init, parent disc 40.
 *
 * UPDATE NOT EXERCISED: anchor-spl 0.31 AND 0.32 ship a buggy
 * `group_pointer_update` wrapper — it passes
 * `&[ctx.accounts.authority.key]` as signers (which causes
 * `spl_token_2022::extension::group_pointer::instruction::update` to
 * emit a 3-account instruction: [mint, authority-readonly,
 * authority-signer]) BUT only forwards `[token_program_id, mint]` to
 * `invoke_signed`. Runtime: "Instruction references an unknown
 * account". This is upstream-broken regardless of Anvil; both Anchor
 * and any user of anchor-spl group_pointer_update hit it. The
 * companion GroupMemberPointer update wrapper passes `&[]` signers and
 * forwards 3 accounts, so its differential gate (separate test file)
 * exercises Init+Update without issue.
 *
 * Our `cpi_t22_group_pointer_update` IR kind + emit are still wired —
 * the M3 coverage gate sees it because the demo source has the
 * `update_group_pointer` instruction. If upstream ships a fix, this
 * differential can be extended to exercise Update.
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
  "t22-group-pointer.rs",
);
const PROGRAM_ID = "FpAhHvWnX7eHwGNpfxGc7YPiA3tfC84sTVXAm5biCwWR";

defineDifferential({
  fixtureName: "t22-group-pointer",
  programIdBase58: PROGRAM_ID,
  anchorSource: readFileSync(SRC, "utf-8"),
  anchorPackageName: "t22_group_pointer_anchor_diff",
  anchorExtraDeps: 'anchor-spl = { version = "0.31", features = ["token_2022", "token_2022_extensions"] }',

  setup: async () => {
    const payer = Keypair.generate();
    const mint = Keypair.generate();
    const groupAccount = Keypair.generate();
    return { payer, mint, groupAccount };
  },

  callScript: async (svm: LiteSVM, ctx, programId: PublicKey) => {
    svm.withDefaultPrograms().withNativeMints();
    svm.airdrop(ctx.payer.publicKey, BigInt(10_000_000_000));

    const mintLen = getMintLen([ExtensionType.GroupPointer]);
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
      throw new Error(`t22-group-pointer setup failed: ${txFailureMessage(r1)}`);
    }

    const initIx = new TransactionInstruction({
      programId,
      keys: [
        { pubkey: ctx.payer.publicKey, isSigner: true, isWritable: true },
        { pubkey: ctx.mint.publicKey, isSigner: false, isWritable: true },
        { pubkey: ctx.groupAccount.publicKey, isSigner: false, isWritable: false },
        { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false },
      ],
      data: Buffer.from(anchorIxDiscriminator("make_group_pointer")),
    });
    const tx1 = new Transaction().add(initIx);
    tx1.recentBlockhash = svm.latestBlockhash();
    tx1.feePayer = ctx.payer.publicKey;
    tx1.sign(ctx.payer);
    const r2 = svm.sendTransaction(tx1);
    if (isTxFailure(r2)) {
      throw new Error(`make_group_pointer failed: ${txFailureMessage(r2)}`);
    }
    // NOTE: update_group_pointer intentionally not exercised here.
    // anchor-spl 0.31/0.32's `group_pointer_update` wrapper is buggy
    // (signers slot / invoke-accounts mismatch — see header comment).
  },

  stripDiscriminator: false,
  accountsToCompare: (ctx) => [{ pubkey: ctx.mint.publicKey, label: "mint" }],
});

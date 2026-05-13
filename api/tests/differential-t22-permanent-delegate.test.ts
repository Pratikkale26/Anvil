/**
 * Token-2022 PermanentDelegate extension init differential — EM2
 * Session 1 deliverable. Validates that the new
 * `cpi_t22_permanent_delegate_initialize` IR kind emits a CPI that
 * byte-equals what Anchor's `permanent_delegate_initialize` helper
 * produces when run end-to-end.
 *
 * Setup: pre-allocate a mint account with space for the
 * PermanentDelegate extension. The program instruction calls
 * `permanent_delegate_initialize(&payer.key())` once. We byte-compare
 * the resulting mint account between the Anchor-built and Anvil-
 * emitted programs.
 *
 * If the Pinocchio hand-rolled discriminator (35) + Pubkey payload OR
 * the Native spl_token_2022::instruction::initialize_permanent_delegate
 * call diverged from Anchor's helper, the resulting mint TLV bytes
 * would differ and this gate would catch it.
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
  "t22-permanent-delegate.rs",
);
const PROGRAM_ID = "PdL9k1mNoP3Q4R5S6T7U8V9W0X1Y2Z3aA4bB5cC6dD7";

defineDifferential({
  fixtureName: "t22-permanent-delegate",
  programIdBase58: PROGRAM_ID,
  anchorSource: readFileSync(SRC, "utf-8"),
  anchorPackageName: "t22_permanent_delegate_anchor_diff",
  anchorExtraDeps: 'anchor-spl = { version = "0.31", features = ["token_2022", "token_2022_extensions"] }',

  setup: async () => {
    const payer = Keypair.generate();
    const mint = Keypair.generate();
    return { payer, mint };
  },

  callScript: async (svm: LiteSVM, ctx, programId: PublicKey) => {
    svm.withDefaultPrograms().withNativeMints();
    svm.airdrop(ctx.payer.publicKey, BigInt(10_000_000_000));

    const mintLen = getMintLen([ExtensionType.PermanentDelegate]);
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
      throw new Error(`t22-permanent-delegate setup failed: ${txFailureMessage(r1)}`);
    }

    const ix = new TransactionInstruction({
      programId,
      keys: [
        // Account order matches MakePermanentDelegate struct: payer, mint, token_program.
        { pubkey: ctx.payer.publicKey, isSigner: true, isWritable: true },
        { pubkey: ctx.mint.publicKey, isSigner: false, isWritable: true },
        { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false },
      ],
      data: Buffer.from(anchorIxDiscriminator("make_permanent_delegate")),
    });
    const tx = new Transaction().add(ix);
    tx.recentBlockhash = svm.latestBlockhash();
    tx.feePayer = ctx.payer.publicKey;
    tx.sign(ctx.payer);
    const r2 = svm.sendTransaction(tx);
    if (isTxFailure(r2)) {
      throw new Error(`make_permanent_delegate failed: ${txFailureMessage(r2)}`);
    }
  },

  stripDiscriminator: false,
  accountsToCompare: (ctx) => [{ pubkey: ctx.mint.publicKey, label: "mint" }],
});

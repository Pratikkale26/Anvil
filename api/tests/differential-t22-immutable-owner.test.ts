/**
 * Token-2022 ImmutableOwner extension differential — third EM2 family
 * (Session 2 partial). Validates `cpi_t22_immutable_owner_initialize`
 * IR kind emits a CPI byte-equal to Anchor's
 * `immutable_owner_initialize` helper.
 *
 * Setup: pre-allocate a token account with ImmutableOwner extension
 * space, run the program's `lock_owner` instruction, byte-compare
 * the resulting account state. Pinocchio variant exercises the
 * hand-rolled discriminator 22 path.
 *
 * Token-account-level (not mint-level) — the account must already
 * have a base mint reference, so we initialize a mint via
 * @solana/spl-token before the extension call.
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
  getAccountLen,
} from "@solana/spl-token";
import {
  defineDifferential,
  anchorIxDiscriminator,
  Keypair,
  PublicKey,
  LiteSVM,
} from "./differential-harness.ts";

const SRC = join(
  import.meta.dir,
  "..",
  "src",
  "demo-programs",
  "t22-immutable-owner.rs",
);
const PROGRAM_ID = "HHGgMthP3YZQDAzwWrXiLzwNsVjZE4arwoUy6qHypJzT";

defineDifferential({
  fixtureName: "t22-immutable-owner",
  programIdBase58: PROGRAM_ID,
  anchorSource: readFileSync(SRC, "utf-8"),
  anchorPackageName: "t22_immutable_owner_anchor_diff",
  anchorExtraDeps: 'anchor-spl = { version = "0.31", features = ["token_2022"] }',

  setup: async () => {
    const payer = Keypair.generate();
    const tokenAccount = Keypair.generate();
    return { payer, tokenAccount };
  },

  callScript: async (svm: LiteSVM, ctx, programId: PublicKey) => {
    svm.withDefaultPrograms().withNativeMints();
    svm.airdrop(ctx.payer.publicKey, BigInt(10_000_000_000));

    // Allocate token account with ImmutableOwner extension space.
    const accountLen = getAccountLen([ExtensionType.ImmutableOwner]);
    const accountRent = svm.minimumBalanceForRentExemption(BigInt(accountLen));
    const setupTx = new Transaction().add(
      SystemProgram.createAccount({
        fromPubkey: ctx.payer.publicKey,
        newAccountPubkey: ctx.tokenAccount.publicKey,
        lamports: Number(accountRent),
        space: accountLen,
        programId: TOKEN_2022_PROGRAM_ID,
      }),
    );
    setupTx.recentBlockhash = svm.latestBlockhash();
    setupTx.feePayer = ctx.payer.publicKey;
    setupTx.sign(ctx.payer, ctx.tokenAccount);
    const r1 = svm.sendTransaction(setupTx);
    if (r1?.constructor?.name === "FailedTransactionMetadata") {
      const meta = (r1 as { meta?: () => { logs?: () => string[] } }).meta?.();
      throw new Error(`t22-immutable-owner setup failed | logs=${JSON.stringify(meta?.logs?.() ?? [])}`);
    }

    const ix = new TransactionInstruction({
      programId,
      keys: [
        { pubkey: ctx.tokenAccount.publicKey, isSigner: false, isWritable: true },
        { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false },
      ],
      data: Buffer.from(anchorIxDiscriminator("lock_owner")),
    });
    const tx = new Transaction().add(ix);
    tx.recentBlockhash = svm.latestBlockhash();
    tx.feePayer = ctx.payer.publicKey;
    tx.sign(ctx.payer);
    const r2 = svm.sendTransaction(tx);
    if (r2?.constructor?.name === "FailedTransactionMetadata") {
      const meta = (r2 as { meta?: () => { logs?: () => string[] } }).meta?.();
      throw new Error(`lock_owner failed | logs=${JSON.stringify(meta?.logs?.() ?? [])}`);
    }
  },

  stripDiscriminator: false,
  accountsToCompare: (ctx) => [{ pubkey: ctx.tokenAccount.publicKey, label: "token_account" }],
});

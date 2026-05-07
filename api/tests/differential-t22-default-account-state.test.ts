/**
 * Token-2022 DefaultAccountState differential — EM2 Session 3.
 * Validates cpi_t22_default_account_state_initialize +
 * cpi_t22_default_account_state_update on BOTH targets — Pinocchio
 * uses hand-rolled discriminator 28+0/28+1 + 1-byte state payload
 * with literal AccountState::* mapped statically to u8 bytes.
 *
 * Setup: allocate mint with DefaultAccountState extension space, run
 * make_frozen_default + initialize_mint + unfreeze_default. Compare
 * mint state.
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
  Keypair,
  PublicKey,
  LiteSVM,
} from "./differential-harness.ts";

const SRC = join(import.meta.dir, "..", "src", "demo-programs", "t22-default-account-state.rs");
const PROGRAM_ID = "D4gKwUkfMhRbcxr2Enp3D7eQSf1jVdWbaGVm4nKmHZzk";

function expectOk(r: unknown, label: string): void {
  if ((r as { constructor?: { name?: string } })?.constructor?.name === "FailedTransactionMetadata") {
    const meta = (r as { meta?: () => { logs?: () => string[] } }).meta?.();
    throw new Error(`${label} failed | logs=${JSON.stringify(meta?.logs?.() ?? [])}`);
  }
}

defineDifferential({
  fixtureName: "t22-default-account-state",
  programIdBase58: PROGRAM_ID,
  anchorSource: readFileSync(SRC, "utf-8"),
  anchorPackageName: "t22_das_anchor_diff",
  anchorExtraDeps: 'anchor-spl = { version = "0.31", features = ["token_2022"] }',
  // Default Pinocchio target now that the typed emit lands (was "native"
  // when DefaultAccountState was a TODO commentout). Native cargo-build
  // coverage remains via cargo-build-real-anvil.test.ts on the demo.

  setup: async () => ({ payer: Keypair.generate(), mint: Keypair.generate() }),

  callScript: async (svm: LiteSVM, ctx, programId: PublicKey) => {
    svm.withDefaultPrograms().withNativeMints();
    svm.airdrop(ctx.payer.publicKey, BigInt(10_000_000_000));

    const mintLen = getMintLen([ExtensionType.DefaultAccountState]);
    const mintRent = svm.minimumBalanceForRentExemption(BigInt(mintLen));
    // 1. Allocate mint
    const allocTx = new Transaction().add(
      SystemProgram.createAccount({
        fromPubkey: ctx.payer.publicKey,
        newAccountPubkey: ctx.mint.publicKey,
        lamports: Number(mintRent),
        space: mintLen,
        programId: TOKEN_2022_PROGRAM_ID,
      }),
    );
    allocTx.recentBlockhash = svm.latestBlockhash();
    allocTx.feePayer = ctx.payer.publicKey;
    allocTx.sign(ctx.payer, ctx.mint);
    expectOk(svm.sendTransaction(allocTx), "alloc mint");

    // 2. make_frozen_default — sets DefaultAccountState extension to Frozen
    const initIx = new TransactionInstruction({
      programId,
      keys: [
        { pubkey: ctx.mint.publicKey, isSigner: false, isWritable: true },
        { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false },
      ],
      data: Buffer.from(anchorIxDiscriminator("make_frozen_default")),
    });
    const initTx = new Transaction().add(initIx);
    initTx.recentBlockhash = svm.latestBlockhash();
    initTx.feePayer = ctx.payer.publicKey;
    initTx.sign(ctx.payer);
    expectOk(svm.sendTransaction(initTx), "make_frozen_default");

    // 3. Init base mint with payer as freeze_authority
    const mintInitTx = new Transaction().add(
      createInitializeMintInstruction(
        ctx.mint.publicKey, 2, ctx.payer.publicKey, ctx.payer.publicKey, TOKEN_2022_PROGRAM_ID,
      ),
    );
    mintInitTx.recentBlockhash = svm.latestBlockhash();
    mintInitTx.feePayer = ctx.payer.publicKey;
    mintInitTx.sign(ctx.payer);
    expectOk(svm.sendTransaction(mintInitTx), "initialize_mint");

    // 4. unfreeze_default — switches state to Initialized
    const updateIx = new TransactionInstruction({
      programId,
      keys: [
        { pubkey: ctx.payer.publicKey, isSigner: true, isWritable: false },
        { pubkey: ctx.mint.publicKey, isSigner: false, isWritable: true },
        { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false },
      ],
      data: Buffer.from(anchorIxDiscriminator("unfreeze_default")),
    });
    const updateTx = new Transaction().add(updateIx);
    updateTx.recentBlockhash = svm.latestBlockhash();
    updateTx.feePayer = ctx.payer.publicKey;
    updateTx.sign(ctx.payer);
    expectOk(svm.sendTransaction(updateTx), "unfreeze_default");
  },

  stripDiscriminator: false,
  accountsToCompare: (ctx) => [{ pubkey: ctx.mint.publicKey, label: "mint" }],
});

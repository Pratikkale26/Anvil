/**
 * ATA-mint differential — third fixture.
 *
 * Exercises a heavier surface than counter / vault:
 *   - Cross-program invocation: associated_token::create (ATA program)
 *   - SPL Token mint_to CPI (token program)
 *   - Mint pre-existence (created by the test, not the program)
 *   - Recipient ATA derived deterministically from mint + owner
 *
 * If Anvil's ATA-create or mint_to emit drifts semantically, the post-
 * scenario byte-compare on the recipient ATA's data buffer (165 bytes
 * of SPL Token account state) will fire.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  Transaction,
  TransactionInstruction,
  SystemProgram,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
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
import { createMintIxs, sendSetupTx } from "./differential-setup-helpers.ts";
import { isTxFailure, txFailureMessage } from "./litesvm-tx-error.ts";

const SRC = join(import.meta.dir, "..", "src", "demo-programs", "ata-mint.rs");
const PROGRAM_ID = "AtaMint111111111111111111111111111111111111";

defineDifferential({
  fixtureName: "ata-mint",
  programIdBase58: PROGRAM_ID,
  anchorSource: readFileSync(SRC, "utf-8"),
  anchorPackageName: "ata_mint_anchor_diff",
  anchorExtraDeps: `anchor-spl = "0.31"`,

  setup: async () => {
    const payer = Keypair.generate();
    const recipient = Keypair.generate();
    const mint = Keypair.generate();
    const recipientAta = getAssociatedTokenAddressSync(
      mint.publicKey,
      recipient.publicKey,
    );
    return { payer, recipient, mint, recipientAta };
  },

  callScript: async (svm: LiteSVM, ctx, programId: PublicKey) => {
    svm.withDefaultPrograms().withNativeMints();
    svm.airdrop(ctx.payer.publicKey, BigInt(5_000_000_000));

    // Pre-existing mint — both Anchor + Anvil scenarios get an identical
    // starting mint, so any divergence later is attributable to mint_to/
    // ATA-create in the program, not setup.
    const setupTx = new Transaction().add(
      ...createMintIxs(svm, ctx.payer.publicKey, ctx.mint.publicKey, 6, ctx.payer.publicKey, ctx.payer.publicKey),
    );
    sendSetupTx(svm, setupTx, ctx.payer.publicKey, [ctx.payer, ctx.mint], "mint setup");

    // Step 2: Call mint_with_ata. The Anchor + Anvil binaries both produce
    // ATA-create + mint_to invocations; the test's job is just to drive
    // them with identical inputs so the post-state byte-compare is
    // meaningful.
    const ix = new TransactionInstruction({
      programId,
      keys: [
        { pubkey: ctx.payer.publicKey, isSigner: true, isWritable: true },
        { pubkey: ctx.mint.publicKey, isSigner: false, isWritable: true },
        { pubkey: ctx.recipient.publicKey, isSigner: false, isWritable: false },
        { pubkey: ctx.recipientAta, isSigner: false, isWritable: true },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data: Buffer.from(concatBytes(
        anchorIxDiscriminator("mint_with_ata"),
        encodeU64LE(1_000_000n),
      )),
    });
    const tx = new Transaction().add(ix);
    tx.recentBlockhash = svm.latestBlockhash();
    tx.feePayer = ctx.payer.publicKey;
    tx.sign(ctx.payer);
    const r2 = svm.sendTransaction(tx);
    if (isTxFailure(r2)) throw new Error(`mint_with_ata failed: ${txFailureMessage(r2)}`);
  },

  // The mint AND the recipient ATA must be byte-equal across scenarios.
  // Discriminator strip is OFF — these are SPL Token accounts, not Anchor
  // state, so they don't carry the 8-byte Anchor discriminator.
  stripDiscriminator: false,
  accountsToCompare: (ctx) => [
    { pubkey: ctx.mint.publicKey, label: "mint" },
    { pubkey: ctx.recipientAta, label: "recipient_ata" },
  ],
});

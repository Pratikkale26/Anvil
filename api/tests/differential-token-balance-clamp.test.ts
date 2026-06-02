/**
 * Finding B gate — token-balance-read (`ctx.accounts.vault.amount`) byte-equal.
 *
 * The read used to mangle to `0u64` on Pinocchio (resolved on Native), so a
 * payout clamped by `requested.min(vault.amount)` paid 0 on Pinocchio. This
 * gate BITES: two steps on a vault pre-funded with 1000 tokens —
 *
 *   1. payout(requested=300) → actual = 300.min(1000) = 300 → recipient 0→300, vault 1000→700  (ok)
 *   2. payout(requested=999999) → actual = 999999.min(700) = 700 (CLAMPED) → recipient 300→1000, vault 700→0  (ok)
 *
 * Pre-fix Pinocchio (vault.amount == 0) pays 0 on BOTH steps → recipient stays
 * 0, diverging from Anchor on the very first compare. The byte-compare on the
 * recipient + vault token accounts (amount at offset 64) catches it; the clamp
 * in step 2 additionally proves the real balance (not just non-zero) is read.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Transaction, TransactionInstruction } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from "@solana/spl-token";
import {
  defineDifferential,
  anchorIxDiscriminator,
  encodeU64LE,
  concatBytes,
  Keypair,
  PublicKey,
  LiteSVM,
} from "./differential-harness.ts";
import { setupMintAndAtaIxs, createAtaIx, sendSetupTx } from "./differential-setup-helpers.ts";
import { isTxFailure, txFailureMessage } from "./litesvm-tx-error.ts";

const SRC = join(import.meta.dir, "..", "src", "demo-programs", "token-balance-clamp.rs");
const PROGRAM_ID = "ADMVc4SFrupMV9xMhagvQ1ALRPjPjALsMCVw2JYZRbus";

defineDifferential({
  fixtureName: "token-balance-clamp",
  programIdBase58: PROGRAM_ID,
  anchorSource: readFileSync(SRC, "utf-8"),
  anchorPackageName: "token_balance_clamp_anchor_diff",
  anchorExtraDeps: `anchor-spl = "0.31"`,

  setup: async () => {
    const payer = Keypair.generate();
    const authority = Keypair.generate();
    const mint = Keypair.generate();
    const recipientOwner = Keypair.generate();
    const vault = getAssociatedTokenAddressSync(mint.publicKey, authority.publicKey);
    const recipient = getAssociatedTokenAddressSync(mint.publicKey, recipientOwner.publicKey);
    return { payer, authority, mint, recipientOwner, vault, recipient };
  },

  callScript: async (svm: LiteSVM, ctx, programId: PublicKey) => {
    svm.withDefaultPrograms().withNativeMints();
    svm.airdrop(ctx.payer.publicKey, BigInt(10_000_000_000));
    svm.airdrop(ctx.authority.publicKey, BigInt(2_000_000_000));

    // mint + vault ATA (authority-owned, funded 1000) + recipient ATA (0).
    const setupTx = new Transaction()
      .add(...setupMintAndAtaIxs(svm, ctx.payer.publicKey, ctx.mint.publicKey, ctx.vault, ctx.authority.publicKey, 6, 1_000n))
      .add(createAtaIx(ctx.payer.publicKey, ctx.recipient, ctx.recipientOwner.publicKey, ctx.mint.publicKey));
    sendSetupTx(svm, setupTx, ctx.payer.publicKey, [ctx.payer, ctx.mint], "setup");

    const callPayout = (requested: bigint) => {
      const ix = new TransactionInstruction({
        programId,
        keys: [
          { pubkey: ctx.vault, isSigner: false, isWritable: true },
          { pubkey: ctx.recipient, isSigner: false, isWritable: true },
          { pubkey: ctx.authority.publicKey, isSigner: true, isWritable: false },
          { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        ],
        data: Buffer.from(concatBytes(anchorIxDiscriminator("payout"), encodeU64LE(requested))),
      });
      const tx = new Transaction().add(ix);
      tx.recentBlockhash = svm.latestBlockhash();
      tx.feePayer = ctx.authority.publicKey;
      tx.sign(ctx.authority);
      const r = svm.sendTransaction(tx);
      if (isTxFailure(r)) throw new Error(`payout(${requested}) failed: ${txFailureMessage(r)}`);
    };

    callPayout(300n);     // below balance → transfer 300
    callPayout(999_999n); // above balance → clamp to 700
  },

  compareTxOutcomes: true,
  stripDiscriminator: false, // SPL token accounts have no 8-byte Anchor disc
  accountsToCompare: (ctx) => [
    { pubkey: ctx.vault, label: "vault" },
    { pubkey: ctx.recipient, label: "recipient" },
  ],
});

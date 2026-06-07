/**
 * `#[account(close = receiver)]` must leave the closed account System-owned and
 * zero-length, like Anchor (hard-sweep F5, #24).
 *
 * Anvil's close_program_account helper drained lamports and zeroed the data IN
 * PLACE, but never reassigned the owner to the System Program nor shrank the
 * data length to 0 — so the "closed" account stayed program-owned at full
 * length, where Anchor leaves it System-owned and empty (is_closed). A
 * program-owned, intact closed account can be revived / re-deserialized as its
 * old type within the same transaction.
 *
 * TEETH: a 0-lamport closed account is garbage-collected at tx end (both sides
 * would read null — no observable divergence), so the tx closes the account AND
 * THEN refunds it lamports (a System transfer) so it survives to be compared:
 *   - Anchor / fixed-Anvil: close assigns System + realloc(0) -> account ends
 *     System-owned with data_len 0 (then refunded).
 *   - Anvil HEAD: close zeroes data in place -> account ends program-owned with
 *     data_len 48 (then refunded).
 * The `vault` data buffers diverge (len 0 vs 48); the fix matches Anchor. A
 * post-tx assertion confirms the account is actually present (refund landed),
 * so "2 pass" can't be a null-vs-null artifact.
 */
import { createHash } from "node:crypto";
import {
  Transaction,
  TransactionInstruction,
  SystemProgram,
} from "@solana/web3.js";
import {
  defineDifferential,
  anchorIxDiscriminator,
  Keypair,
  PublicKey,
  LiteSVM,
} from "./differential-harness.ts";

const PROGRAM_ID = "FtEW4oaX717t9yQ4fwqWfoyR6cT4ssqRrwYH4mZ15H16";

const SRC = `use anchor_lang::prelude::*;

declare_id!("${PROGRAM_ID}");

#[program]
pub mod close_reassign {
    use super::*;
    pub fn close_it(_ctx: Context<CloseIt>) -> Result<()> {
        Ok(())
    }
}

#[account]
pub struct Vault { pub authority: Pubkey, pub total: u64 }

#[derive(Accounts)]
pub struct CloseIt<'info> {
    #[account(mut, close = receiver)]
    pub vault: Account<'info, Vault>,
    #[account(mut)]
    pub receiver: Signer<'info>,
}
`;

function acctDisc(name: string): Uint8Array {
  return new Uint8Array(createHash("sha256").update(`account:${name}`).digest()).slice(0, 8);
}

function defineFixture(fixtureName: string, anvilTarget?: "native") {
  defineDifferential({
    fixtureName,
    anvilTarget,
    programIdBase58: PROGRAM_ID,
    anchorSource: SRC,
    anchorPackageName: anvilTarget === "native"
      ? "close_reassign_native_diff"
      : "close_reassign_anchor_diff",

    setup: async () => ({
      payer: Keypair.generate(),
      receiver: Keypair.generate(),
      vault: Keypair.generate(),
    }),

    callScript: async (svm: LiteSVM, ctx, programId: PublicKey) => {
      svm.airdrop(ctx.payer.publicKey, BigInt(5_000_000_000));
      svm.airdrop(ctx.receiver.publicKey, BigInt(1_000_000_000));

      // vault: Account<Vault> { authority, total } owned by the program, 8+32+8=48 bytes.
      const data = new Uint8Array(48);
      data.set(acctDisc("Vault"), 0);
      data.set(ctx.receiver.publicKey.toBytes(), 8); // authority
      svm.setAccount(ctx.vault.publicKey, {
        lamports: 5_000_000,
        data: Buffer.from(data),
        owner: programId,
        executable: false,
      });

      // Single tx: close the vault, then refund it lamports so it survives GC
      // and stays observable (System-owned + len 0 on Anchor/fix; program-owned
      // + len 48 on HEAD).
      const closeIx = new TransactionInstruction({
        programId,
        keys: [
          { pubkey: ctx.vault.publicKey, isSigner: false, isWritable: true },
          { pubkey: ctx.receiver.publicKey, isSigner: true, isWritable: true },
        ],
        data: Buffer.from(anchorIxDiscriminator("close_it")),
      });
      const refundIx = SystemProgram.transfer({
        fromPubkey: ctx.payer.publicKey,
        toPubkey: ctx.vault.publicKey,
        lamports: 10_000_000, // well above rent for 48 bytes — keeps it alive
      });
      const tx = new Transaction().add(closeIx).add(refundIx);
      tx.recentBlockhash = svm.latestBlockhash();
      tx.feePayer = ctx.payer.publicKey;
      tx.sign(ctx.payer, ctx.receiver);
      svm.sendTransaction(tx);

      // Guard against a null-vs-null false agreement: the vault MUST be present
      // (the refund landed) for the data-length comparison to be meaningful.
      const acc = svm.getAccount(ctx.vault.publicKey);
      if (!acc || acc.lamports === 0) {
        throw new Error("vault not present after close+refund — comparison would be null-vs-null");
      }
    },

    accountsToCompare: (ctx) => [
      { pubkey: ctx.vault.publicKey, label: "vault" },
    ],
  });
}

defineFixture("close-reassign");
defineFixture("close-reassign-native", "native");

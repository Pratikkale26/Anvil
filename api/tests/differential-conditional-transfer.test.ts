/**
 * Conditional money-movement differential (#13, increment 1a).
 *
 * Squads' realloc_if_needed shape (minus the realloc): a Type-associated method
 * `Vault::top_up_if_needed` that runs `if current < target { system_program::
 * transfer(…) }`. Exercises (a) #18 impl-method inlining and (b) the new #13
 * conditional-CPI emit — the transfer must fire iff the vault is underfunded.
 *
 * Pre-seed the vault below `target`, call top_up, and byte-compare the vault's
 * lamports (= target after the conditional transfer). If Anvil emitted the
 * transfer unconditionally, dropped it, or mis-wrapped the guard, the lamport
 * compare diverges.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Transaction, TransactionInstruction, SystemProgram } from "@solana/web3.js";
import {
  defineDifferential,
  anchorIxDiscriminator,
  encodeU64LE,
  concatBytes,
  Keypair,
  PublicKey,
  LiteSVM,
} from "./differential-harness.ts";
import { isTxFailure } from "./litesvm-tx-error.ts";

const SRC = join(import.meta.dir, "..", "src", "demo-programs", "conditional-transfer.rs");
const PROGRAM_ID = "WNsPBjkFcra8ypL4C5Wke76c2aAaxqsfYnKiXoXLiRo";
const TARGET = 2_000_000n;

defineDifferential({
  fixtureName: "conditional-transfer",
  programIdBase58: PROGRAM_ID,
  anchorSource: readFileSync(SRC, "utf-8"),
  anchorPackageName: "conditional_transfer_anchor_diff",

  setup: async () => {
    const payer = Keypair.generate();
    const vault = Keypair.generate();
    return { payer, vault };
  },

  callScript: async (svm: LiteSVM, ctx, programId: PublicKey) => {
    svm.airdrop(ctx.payer.publicKey, BigInt(10_000_000_000));
    // Pre-seed the vault below TARGET (system-owned, lamport-only).
    svm.setAccount(ctx.vault.publicKey, {
      lamports: 1_000,
      data: new Uint8Array(0),
      owner: SystemProgram.programId,
      executable: false,
    });

    const ix = new TransactionInstruction({
      programId,
      keys: [
        { pubkey: ctx.vault.publicKey, isSigner: false, isWritable: true },
        { pubkey: ctx.payer.publicKey, isSigner: true, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data: Buffer.from(concatBytes(anchorIxDiscriminator("top_up"), encodeU64LE(TARGET))),
    });
    const tx = new Transaction().add(ix);
    tx.recentBlockhash = svm.latestBlockhash();
    tx.feePayer = ctx.payer.publicKey;
    tx.sign(ctx.payer);
    const r = svm.sendTransaction(tx);
    if (isTxFailure(r)) {
      const errStr =
        typeof r.err === "object"
          ? Object.prototype.toString.call(r.err) + " " + (r.err?.toString?.() ?? "")
          : String(r.err);
      throw new Error(`top_up failed: ${errStr} | logs=${JSON.stringify((r as { logs?: string[] }).logs ?? [])}`);
    }
  },

  // Compare the vault only (its lamports must be exactly TARGET after the
  // conditional transfer). Payer is the fee-payer — skip it to avoid fee residual.
  stripDiscriminator: false,
  accountsToCompare: (ctx) => [{ pubkey: ctx.vault.publicKey, label: "vault" }],
});

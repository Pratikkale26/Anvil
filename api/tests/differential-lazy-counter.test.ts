/**
 * LazyAccount whole-struct `load_mut()` byte-equal differential (task #19).
 *
 * Proves at runtime that the LazyAccount Borsh reroute (visitZeroCopyLoadMut →
 * ensureStateReadStructural when isLazy) produces the same on-chain effect as
 * Anchor's real `LazyAccount::load_mut()`. The counter is pre-seeded with a
 * valid Counter (account discriminator + count), the program sets count=42 via
 * load_mut, and we byte-compare the resulting account.
 *
 * Requires the anchor-lang `lazy-account` feature (LazyAccount is feature-gated
 * in 0.31.1) for the reference build.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Transaction, TransactionInstruction } from "@solana/web3.js";
import {
  defineDifferential,
  anchorIxDiscriminator,
  sha256,
  Keypair,
  PublicKey,
  LiteSVM,
} from "./differential-harness.ts";
import { isTxFailure } from "./litesvm-tx-error.ts";

const SRC = join(import.meta.dir, "..", "src", "demo-programs", "lazy-counter.rs");
const PROGRAM_ID = "5WJSTh75J37jHrKN6wvDWTXk8v9BPvZ5d9Eo8FFSXWMG";

// Anchor account discriminator: sha256("account:<Name>")[..8].
const COUNTER_DISC = sha256(new TextEncoder().encode("account:Counter")).slice(0, 8);

function counterData(count: bigint): Buffer {
  const buf = Buffer.alloc(16); // 8 disc + 8 u64
  Buffer.from(COUNTER_DISC).copy(buf, 0);
  buf.writeBigUInt64LE(count, 8);
  return buf;
}

defineDifferential({
  fixtureName: "lazy-counter",
  programIdBase58: PROGRAM_ID,
  anchorSource: readFileSync(SRC, "utf-8"),
  anchorPackageName: "lazy_counter_anchor_diff",
  anchorLangFeatures: ["lazy-account"],

  setup: async () => {
    const payer = Keypair.generate();
    const counter = Keypair.generate();
    return { payer, counter };
  },

  callScript: async (svm: LiteSVM, ctx, programId: PublicKey) => {
    svm.airdrop(ctx.payer.publicKey, BigInt(10_000_000_000));

    // Pre-seed the counter account: owned by the program, valid Counter Borsh
    // (disc + count=7). load_mut deserializes this, sets count=42, writes back.
    const data = counterData(7n);
    const rent = svm.minimumBalanceForRentExemption(BigInt(data.length));
    svm.setAccount(ctx.counter.publicKey, {
      lamports: Number(rent),
      data: new Uint8Array(data),
      owner: programId,
      executable: false,
    });

    const ix = new TransactionInstruction({
      programId,
      keys: [
        { pubkey: ctx.counter.publicKey, isSigner: false, isWritable: true },
        { pubkey: ctx.payer.publicKey, isSigner: true, isWritable: false },
      ],
      data: Buffer.from(anchorIxDiscriminator("bump")),
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
      throw new Error(
        `bump failed: ${errStr} | logs=${JSON.stringify((r as { logs?: string[] }).logs ?? [])}`,
      );
    }
  },

  stripDiscriminator: false,
  accountsToCompare: (ctx) => [{ pubkey: ctx.counter.publicKey, label: "counter" }],
});

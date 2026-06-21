/**
 * enum-discriminant differential — regression teeth for the enum explicit
 * discriminant borsh divergence (prod-readiness eval 2026-06-21, Finding 1).
 *
 * `Kind { A = 10, B = 20, C = 30 }` is stored in account state. anchor-lang
 * pins borsh 0.10, which serializes enum tags by ORDINAL position, so
 * `initialize` (which sets `kind = Kind::B`) must store tag byte 1 — NOT the
 * declared value 20. Anvil emits `#[borsh(use_discriminant = false)]` to match.
 *
 * Fails on HEAD before the fix (Anvil emitted `use_discriminant = true` →
 * borsh-1.x honors the value → stored byte 20 vs Anchor's 1 → BYTE DIVERGED).
 * Passes after the fix (both store byte 1).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Transaction, TransactionInstruction, SystemProgram } from "@solana/web3.js";
import {
  defineDifferential,
  anchorIxDiscriminator,
  Keypair,
  PublicKey,
  LiteSVM,
} from "./differential-harness.ts";

const SRC = join(import.meta.dir, "..", "src", "demo-programs", "enum-discriminant.rs");
const PROGRAM_ID = "EnumD11111111111111111111111111111111111111";

defineDifferential({
  fixtureName: "enum-discriminant",
  programIdBase58: PROGRAM_ID,
  anchorSource: readFileSync(SRC, "utf-8"),
  anchorPackageName: "enum_discriminant_anchor_diff",

  setup: async () => {
    const payer = Keypair.generate();
    const data = Keypair.generate();
    return { payer, data };
  },

  callScript: async (svm: LiteSVM, ctx, programId: PublicKey) => {
    svm.airdrop(ctx.payer.publicKey, BigInt(1_000_000_000));
    const ix = new TransactionInstruction({
      programId,
      keys: [
        { pubkey: ctx.data.publicKey, isSigner: true, isWritable: true },
        { pubkey: ctx.payer.publicKey, isSigner: true, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data: Buffer.from(anchorIxDiscriminator("initialize")),
    });
    const tx = new Transaction().add(ix);
    tx.recentBlockhash = svm.latestBlockhash();
    tx.feePayer = ctx.payer.publicKey;
    tx.sign(ctx.payer, ctx.data);
    const r = svm.sendTransaction(tx);
    if (r?.constructor?.name === "FailedTransactionMetadata") {
      const failed = r as unknown as { err: () => { toString(): string } };
      throw new Error(`tx failed: ${failed.err().toString()}`);
    }
  },

  accountsToCompare: (ctx) => [{ pubkey: ctx.data.publicKey, label: "data" }],
});

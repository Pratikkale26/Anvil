/**
 * realloc_if_needed money-path differential (#13, increments 1b + 1c).
 *
 * Squads' exact realloc_if_needed shape, end to end: a Type-associated method
 * `Vault::realloc_if_needed` (inlined via #18) that (1) computes the rent delta
 * for the grown size, (2) conditionally tops up the account via system_program::
 * transfer iff underfunded (#13 1a), then (3) `account.realloc(new_size, false)`
 * grows it in place (#13 1b). Pinocchio's AccountInfo::realloc mirrors Anchor's
 * signature, so the realloc is a pass-through — this fixture is the byte-equal
 * proof that the pass-through is correct, not just that it compiles.
 *
 * Pre-seed blob program-owned and rent-exempt for INIT_SIZE but NOT for the grown
 * size, so the conditional transfer must fire. After grow(EXTRA) compare blob:
 * its data (INIT_SIZE marker bytes + EXTRA zero-filled tail) and its lamports
 * (= rent-exempt minimum for the grown size). A dropped/unconditional transfer,
 * a wrong realloc target, or a non-zeroed tail all diverge the byte compare.
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

const SRC = join(import.meta.dir, "..", "src", "demo-programs", "realloc-with-rent.rs");
const PROGRAM_ID = "CQXay9KL7pihVii9Jub9J3zYR9j2aUNHdnNKjy5tbsqp";
const INIT_SIZE = 16n;
const EXTRA = 100n;

defineDifferential({
  fixtureName: "realloc-with-rent",
  programIdBase58: PROGRAM_ID,
  anchorSource: readFileSync(SRC, "utf-8"),
  anchorPackageName: "realloc_with_rent_anchor_diff",

  setup: async () => {
    const payer = Keypair.generate();
    const blob = Keypair.generate();
    return { payer, blob };
  },

  callScript: async (svm: LiteSVM, ctx, programId: PublicKey) => {
    svm.airdrop(ctx.payer.publicKey, BigInt(10_000_000_000));
    // Program-owned blob, rent-exempt for INIT_SIZE but under the grown size, so
    // the realloc_if_needed conditional transfer fires.
    const blobData = new Uint8Array(Number(INIT_SIZE));
    blobData.fill(0xab);
    svm.setAccount(ctx.blob.publicKey, {
      lamports: svm.minimumBalanceForRentExemption(INIT_SIZE),
      data: blobData,
      owner: programId,
      executable: false,
    });

    const ix = new TransactionInstruction({
      programId,
      keys: [
        { pubkey: ctx.blob.publicKey, isSigner: false, isWritable: true },
        { pubkey: ctx.payer.publicKey, isSigner: true, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data: Buffer.from(concatBytes(anchorIxDiscriminator("grow"), encodeU64LE(EXTRA))),
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
      throw new Error(`grow failed: ${errStr} | logs=${JSON.stringify((r as { logs?: string[] }).logs ?? [])}`);
    }
  },

  // Compare the resized blob: data length + contents (marker + zero tail) and
  // lamports (rent-exempt minimum for the grown size).
  stripDiscriminator: false,
  accountsToCompare: (ctx) => [{ pubkey: ctx.blob.publicKey, label: "blob" }],
});

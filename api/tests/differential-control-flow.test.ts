/**
 * #4 — control-flow byte-equal differential.
 *
 * Proves at runtime that `for` + `match` in an instruction body produce the
 * same on-chain state under Anchor and Anvil. The gate is built to BITE: it
 * varies the args that control-flow semantics depend on, across 3 steps on a
 * pre-seeded CfState { counter, mode }:
 *
 *   1. run(n=5, action=0) → loop 5×  counter 0→5 ; match arm 0  mode→10   (ok)
 *   2. run(n=0, action=1) → loop 0×  counter 5→5 (zero-iteration) ; arm 1 mode→20 (ok)
 *   3. run(n=3, action=2) → loop would 5→8 IN MEMORY, then match `_ => Err`
 *      reverts the whole tx → counter stays 5, mode stays 20            (revert)
 *
 * If Anvil mis-counts iterations, takes the wrong match arm, fails to roll back
 * the loop mutation on the revert path, or diverges on success-vs-revert, the
 * final byte-compare (counter=5, mode=20) and the txOutcomes parity ([ok, ok,
 * revert]) catch it. A single happy-path run would prove none of that.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Transaction, TransactionInstruction } from "@solana/web3.js";
import {
  defineDifferential,
  anchorIxDiscriminator,
  encodeU64LE,
  concatBytes,
  sha256,
  Keypair,
  PublicKey,
  LiteSVM,
} from "./differential-harness.ts";
import { isTxFailure } from "./litesvm-tx-error.ts";

const SRC = join(import.meta.dir, "..", "src", "demo-programs", "control-flow.rs");
const PROGRAM_ID = "G7YktF9wccZku7o1JDcKCa6CxWYGGuP7cBUni7utHx86";

// Anchor account discriminator: sha256("account:<Name>")[..8].
const CFSTATE_DISC = sha256(new TextEncoder().encode("account:CfState")).slice(0, 8);

function cfStateData(counter: bigint, mode: bigint): Buffer {
  const buf = Buffer.alloc(24); // 8 disc + 8 counter + 8 mode
  Buffer.from(CFSTATE_DISC).copy(buf, 0);
  buf.writeBigUInt64LE(counter, 8);
  buf.writeBigUInt64LE(mode, 16);
  return buf;
}

// run(n: u64, action: u8) — borsh args after the 8-byte ix discriminator.
function runIxData(n: bigint, action: number): Buffer {
  return Buffer.from(concatBytes(
    anchorIxDiscriminator("run"),
    encodeU64LE(n),
    Uint8Array.of(action & 0xff),
  ));
}

defineDifferential({
  fixtureName: "control-flow",
  programIdBase58: PROGRAM_ID,
  anchorSource: readFileSync(SRC, "utf-8"),
  anchorPackageName: "control_flow_anchor_diff",

  setup: async () => {
    const payer = Keypair.generate();
    const state = Keypair.generate();
    return { payer, state };
  },

  callScript: async (svm: LiteSVM, ctx, programId: PublicKey) => {
    svm.airdrop(ctx.payer.publicKey, BigInt(10_000_000_000));

    // Pre-seed CfState (counter=0, mode=0), owned by the program.
    const data = cfStateData(0n, 0n);
    const rent = svm.minimumBalanceForRentExemption(BigInt(data.length));
    svm.setAccount(ctx.state.publicKey, {
      lamports: Number(rent),
      data: new Uint8Array(data),
      owner: programId,
      executable: false,
    });

    const steps: Array<{ n: bigint; action: number; mustRevert: boolean }> = [
      { n: 5n, action: 0, mustRevert: false }, // loop 5×, arm 0
      { n: 0n, action: 1, mustRevert: false }, // zero-iteration, arm 1
      { n: 3n, action: 2, mustRevert: true },  // loop-then-Err: revert rolls back
    ];

    for (const [i, step] of steps.entries()) {
      const ix = new TransactionInstruction({
        programId,
        keys: [{ pubkey: ctx.state.publicKey, isSigner: false, isWritable: true }],
        data: runIxData(step.n, step.action),
      });
      const tx = new Transaction().add(ix);
      tx.recentBlockhash = svm.latestBlockhash();
      tx.feePayer = ctx.payer.publicKey;
      tx.sign(ctx.payer);
      const r = svm.sendTransaction(tx);
      const failed = isTxFailure(r);
      if (failed && !step.mustRevert) {
        const errStr = typeof r.err === "object"
          ? Object.prototype.toString.call(r.err) + " " + (r.err?.toString?.() ?? "")
          : String(r.err);
        throw new Error(`step ${i} (n=${step.n},action=${step.action}) unexpectedly failed: ${errStr} | logs=${JSON.stringify((r as { logs?: string[] }).logs ?? [])}`);
      }
      if (!failed && step.mustRevert) {
        throw new Error(`step ${i} (n=${step.n},action=${step.action}) unexpectedly succeeded (expected revert on the _ => Err arm)`);
      }
    }
  },

  // Outcome parity: [ok, ok, revert] must match on both targets — proves the
  // Err arm is taken (and ONLY on step 3) on both.
  compareTxOutcomes: true,
  // Final state: counter=5 (5 + 0 + rolled-back 3), mode=20 (arm 1 last applied).
  stripDiscriminator: false,
  accountsToCompare: (ctx) => [{ pubkey: ctx.state.publicKey, label: "state" }],
});

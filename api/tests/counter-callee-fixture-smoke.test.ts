/**
 * #5 GOLD-STANDARD fixture proof — the committed counter_callee.so behaves as the
 * differential gate assumes: a correct CPI succeeds, and EVERY adversarial
 * deviation (dropped signer, swapped account metas, truncated data, wrong-owner
 * counter) REVERTS. This is what makes the gold-standard differential a real gate
 * rather than theater: when #5 emits a wrong generic invoke, the divergence the
 * differential observes is a genuine revert-vs-success, not a coincidence.
 *
 * No SBF toolchain / Anchor build needed — it loads the prebuilt, committed .so
 * directly into LiteSVM and sends raw instructions. (Built once from
 * api/tests/fixtures/programs/src/counter_callee.rs via cargo-build-sbf.)
 *
 * The callee contract (counter_callee.rs):
 *   accounts[0] = counter   (writable, MUST be owned by the callee program)
 *   accounts[1] = authority (MUST be a signer)
 *   data        = u64 LE amount (MUST be ≥ 8 bytes)
 *   effect      = counter[0..8] += amount
 *   reverts     = MissingRequiredSignature / IllegalOwner / InvalidInstructionData
 */
import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Transaction, TransactionInstruction, SystemProgram } from "@solana/web3.js";
import {
  Keypair,
  PublicKey,
  LiteSVM,
  encodeU64LE,
  mkTestProgramId,
} from "./differential-harness.ts";

const CALLEE_ID = new PublicKey(
  mkTestProgramId("Counterca11ee111111111111111111111111111111"),
);
const CALLEE_SO = readFileSync(
  join(import.meta.dir, "fixtures", "programs", "counter_callee.so"),
);

interface Env {
  svm: LiteSVM;
  payer: Keypair;
  authority: Keypair;
  counter: PublicKey;
  send: (ix: TransactionInstruction, signers: Keypair[]) => { failed: boolean };
  readCounter: (pk?: PublicKey) => bigint;
}

// Fresh, isolated runtime per test: load the callee, fund a payer, and create a
// callee-OWNED counter account (8 zero bytes, rent-exempt).
function mkEnv(): Env {
  const svm = new LiteSVM();
  svm.addProgram(CALLEE_ID, CALLEE_SO);
  const payer = Keypair.generate();
  const authority = Keypair.generate();
  svm.airdrop(payer.publicKey, BigInt(1_000_000_000));
  const counter = Keypair.generate().publicKey;
  svm.setAccount(counter, {
    lamports: 10_000_000,
    data: new Uint8Array(8), // 0u64 LE
    owner: CALLEE_ID,
    executable: false,
  });
  const send = (ix: TransactionInstruction, signers: Keypair[]) => {
    const tx = new Transaction().add(ix);
    tx.recentBlockhash = svm.latestBlockhash();
    tx.feePayer = payer.publicKey;
    tx.sign(payer, ...signers);
    const r = svm.sendTransaction(tx);
    return { failed: r?.constructor?.name === "FailedTransactionMetadata" };
  };
  const readCounter = (pk: PublicKey = counter): bigint => {
    const acc = svm.getAccount(pk);
    if (!acc) throw new Error("counter account missing");
    return new DataView(Uint8Array.from(acc.data).buffer).getBigUint64(0, true);
  };
  return { svm, payer, authority, counter, send, readCounter };
}

// The CORRECT instruction: [counter(w, non-signer), authority(readonly, SIGNER)],
// data = u64 LE amount. Mirrors what a correct cpi_custom emit must produce.
function correctIx(env: Env, amount: bigint): TransactionInstruction {
  return new TransactionInstruction({
    programId: CALLEE_ID,
    keys: [
      { pubkey: env.counter, isSigner: false, isWritable: true },
      { pubkey: env.authority.publicKey, isSigner: true, isWritable: false },
    ],
    data: Buffer.from(encodeU64LE(amount)),
  });
}

describe("#5 gold-standard — counter_callee.so contract", () => {
  test("CORRECT invoke succeeds and mutates the counter (control)", () => {
    const env = mkEnv();
    expect(env.send(correctIx(env, 7n), [env.authority]).failed).toBe(false);
    expect(env.readCounter()).toBe(7n);
    // a second correct call accumulates — the differential sends 7 then 5 → 12.
    expect(env.send(correctIx(env, 5n), [env.authority]).failed).toBe(false);
    expect(env.readCounter()).toBe(12n);
  });

  test("ADVERSARIAL — dropped signer flag on authority → REVERT", () => {
    const env = mkEnv();
    const ix = new TransactionInstruction({
      programId: CALLEE_ID,
      keys: [
        { pubkey: env.counter, isSigner: false, isWritable: true },
        { pubkey: env.authority.publicKey, isSigner: false, isWritable: false }, // NOT a signer
      ],
      data: Buffer.from(encodeU64LE(7n)),
    });
    expect(env.send(ix, []).failed).toBe(true); // MissingRequiredSignature
    expect(env.readCounter()).toBe(0n); // unchanged
  });

  test("ADVERSARIAL — swapped account-meta order → REVERT", () => {
    const env = mkEnv();
    const ix = new TransactionInstruction({
      programId: CALLEE_ID,
      keys: [
        { pubkey: env.authority.publicKey, isSigner: true, isWritable: true }, // wrong slot 0
        { pubkey: env.counter, isSigner: false, isWritable: true }, // wrong slot 1
      ],
      data: Buffer.from(encodeU64LE(7n)),
    });
    // callee reads accounts[1] (counter) as the authority → not a signer → revert.
    expect(env.send(ix, [env.authority]).failed).toBe(true);
    expect(env.readCounter()).toBe(0n);
  });

  test("ADVERSARIAL — truncated instruction data (<8 bytes) → REVERT", () => {
    const env = mkEnv();
    const ix = new TransactionInstruction({
      programId: CALLEE_ID,
      keys: [
        { pubkey: env.counter, isSigner: false, isWritable: true },
        { pubkey: env.authority.publicKey, isSigner: true, isWritable: false },
      ],
      data: Buffer.from([1, 2, 3]), // len 3 < 8
    });
    expect(env.send(ix, [env.authority]).failed).toBe(true); // InvalidInstructionData
    expect(env.readCounter()).toBe(0n);
  });

  test("ADVERSARIAL — counter owned by another program → REVERT", () => {
    const env = mkEnv();
    const foreign = Keypair.generate().publicKey;
    env.svm.setAccount(foreign, {
      lamports: 10_000_000,
      data: new Uint8Array(8),
      owner: SystemProgram.programId, // NOT the callee
      executable: false,
    });
    const ix = new TransactionInstruction({
      programId: CALLEE_ID,
      keys: [
        { pubkey: foreign, isSigner: false, isWritable: true },
        { pubkey: env.authority.publicKey, isSigner: true, isWritable: false },
      ],
      data: Buffer.from(encodeU64LE(7n)),
    });
    expect(env.send(ix, [env.authority]).failed).toBe(true); // IllegalOwner
    expect(env.readCounter(foreign)).toBe(0n);
  });
});

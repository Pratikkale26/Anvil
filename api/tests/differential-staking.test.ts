/**
 * Staking differential — clock-pinned + emit! event log byte-equality.
 *
 * Exercises a unique combination not covered by any other fixture:
 *   1. Clock::get().unix_timestamp read on every state-mutating tx.
 *   2. Reward math driven by elapsed = now - stake.last_claim.
 *   3. emit!() with a Pubkey + u64 + i64 mixed payload.
 *
 * The harness pins the initial clock identically across both Anchor and
 * Anvil scenarios; the call script then warps the clock between txs to
 * produce non-zero `elapsed` values. Without identical clock pinning,
 * Anchor + Anvil scenarios would see different timestamps and produce
 * different state even when the emit is correct — so the test would
 * fail spuriously on the LiteSVM clock advancing differently across
 * runs. With pinning, both scenarios see byte-identical clock readings,
 * so any divergence is real emit drift.
 *
 * What this protects:
 *   - Clock::get() lowering on Pinocchio (Sysvar trait via pinocchio_pubkey)
 *   - state_field_assign on i64-typed fields (last_claim)
 *   - saturating_mul + integer division producing identical u64 output
 *   - emit!() with a heterogeneous payload (Pubkey, u64, i64): borsh
 *     layout must match Anchor's AnchorSerialize byte-for-byte. The
 *     event discriminator (sha256("event:StakeUpdated")[..8] /
 *     sha256("event:RewardsClaimed")[..8]) must match Anchor's.
 *
 * Scenario:
 *   T=1_700_000_000: initialize_stake(reward_rate=10000)  — amount=0,  accumulated=0
 *   T=1_700_000_100: deposit(100)                          — earned=0,   amount=100
 *   T=1_700_000_150: deposit(50)                           — earned=50,  amount=150, accumulated=50
 *   T=1_700_000_350: claim()                               — earned=300, total=350, accumulated=0
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

const SRC = join(import.meta.dir, "..", "src", "demo-programs", "simple-staking.rs");
const PROGRAM_ID = "Stake11111111111111111111111111111111111111";
const PIN_T0 = 1_700_000_000;

defineDifferential({
  fixtureName: "staking",
  programIdBase58: PROGRAM_ID,
  anchorSource: readFileSync(SRC, "utf-8"),
  anchorPackageName: "simple_staking_anchor_diff",
  pinClockTimestamp: PIN_T0,
  pinClockSlot: 1,
  compareEventLogs: true,
  // Smoke-test the new opt-in surfaces. simple-staking.rs has no
  // msg!() calls and no set_return_data, so both surfaces should
  // observe empty/null on both sides — the assertion proves the
  // capture path doesn't false-positive when there's nothing to
  // capture.
  compareReturnData: true,
  compareMsgLogs: true,

  setup: async () => {
    const user = Keypair.generate();
    const programId = new PublicKey(PROGRAM_ID);
    const [stakePda] = PublicKey.findProgramAddressSync(
      [Buffer.from("stake"), user.publicKey.toBuffer()],
      programId,
    );
    return { user, stakePda };
  },

  callScript: async (svm: LiteSVM, ctx, programId: PublicKey) => {
    svm.airdrop(ctx.user.publicKey, BigInt(1_000_000_000));

    const sendTx = (ix: TransactionInstruction, label: string) => {
      const tx = new Transaction().add(ix);
      tx.recentBlockhash = svm.latestBlockhash();
      tx.feePayer = ctx.user.publicKey;
      tx.sign(ctx.user);
      const r = svm.sendTransaction(tx);
      if (r?.constructor?.name === "FailedTransactionMetadata") {
        const failed = r as unknown as {
          err: () => { toString(): string };
          meta: () => { logs: () => string[] };
        };
        throw new Error(`${label} failed: ${failed.err().toString()}\nlogs:\n${failed.meta().logs().join("\n")}`);
      }
    };

    const warp = (ts: number) => {
      const fn = (svm as { warpToTimestamp?: (t: bigint) => unknown }).warpToTimestamp;
      if (typeof fn === "function") fn.call(svm, BigInt(ts));
    };

    // T0 — initialize_stake(reward_rate = 10000)
    sendTx(new TransactionInstruction({
      programId,
      keys: [
        { pubkey: ctx.stakePda, isSigner: false, isWritable: true },
        { pubkey: ctx.user.publicKey, isSigner: true, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data: Buffer.from(concatBytes(
        anchorIxDiscriminator("initialize_stake"),
        encodeU64LE(10_000n),
      )),
    }), "initialize_stake");

    // T0 + 100 — deposit(100). amount was 0 → earned = 0 → accumulated = 0.
    warp(PIN_T0 + 100);
    sendTx(new TransactionInstruction({
      programId,
      keys: [
        { pubkey: ctx.stakePda, isSigner: false, isWritable: true },
        { pubkey: ctx.user.publicKey, isSigner: true, isWritable: false },
      ],
      data: Buffer.from(concatBytes(
        anchorIxDiscriminator("deposit"),
        encodeU64LE(100n),
      )),
    }), "deposit#1");

    // T0 + 150 — deposit(50). amount=100, elapsed=50 → earned = 100*50*10000/1M = 50.
    warp(PIN_T0 + 150);
    sendTx(new TransactionInstruction({
      programId,
      keys: [
        { pubkey: ctx.stakePda, isSigner: false, isWritable: true },
        { pubkey: ctx.user.publicKey, isSigner: true, isWritable: false },
      ],
      data: Buffer.from(concatBytes(
        anchorIxDiscriminator("deposit"),
        encodeU64LE(50n),
      )),
    }), "deposit#2");

    // T0 + 350 — claim. amount=150, elapsed=200 → earned = 150*200*10000/1M = 300.
    // total claimed = accumulated 50 + earned 300 = 350.
    warp(PIN_T0 + 350);
    sendTx(new TransactionInstruction({
      programId,
      keys: [
        { pubkey: ctx.stakePda, isSigner: false, isWritable: true },
        { pubkey: ctx.user.publicKey, isSigner: true, isWritable: false },
      ],
      data: Buffer.from(anchorIxDiscriminator("claim")),
    }), "claim");
  },

  accountsToCompare: (ctx) => [
    { pubkey: ctx.stakePda, label: "user_stake" },
  ],
});

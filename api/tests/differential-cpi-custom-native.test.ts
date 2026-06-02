/**
 * #23 slice (Native) — generic-CPI real emit, byte-equal gate for the NATIVE target.
 *
 * Sibling of the Pinocchio gold-standard (differential-cpi-custom-goldstandard):
 * same fixture (cpi-counter-caller.rs invokes the committed counter_callee.so via a
 * hand-built Instruction + invoke_signed with a PDA authority that signs ONLY through
 * the CPI), but built against the NATIVE Anvil target (anvilTarget: "native").
 *
 * The Native generic-CPI emit lands FIRST (the advisor's "clean architectural
 * increment": Native's invoke API matches Anchor, so the `let ix = Instruction{…}`
 * pass_through is valid solana_program code and the cpi_custom invoke consumes it;
 * only `.to_account_info()→.clone()` + seed bump-refs differ). This gate is the
 * adjudicator: a wrong emit reverts (counter≠12) — a RED gate, not a silent ship.
 * Anvil's pre-emit stub reverts (counter=0) → the gate BITES; the real emit drives
 * counter==12u64 byte-equal with Anchor.
 *
 * NOT gated behind a flag — it's a permanent gate that is GREEN once the Native emit
 * lands (Native canonical cpi_custom real-emits; Pinocchio + non-canonical still stub).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Transaction, TransactionInstruction } from "@solana/web3.js";
import {
  defineDifferential,
  anchorIxDiscriminator,
  encodeU64LE,
  Keypair,
  PublicKey,
  LiteSVM,
  mkTestProgramId,
} from "./differential-harness.ts";

const MAIN_ID = mkTestProgramId("Counterca11er111111111111111111111111111111");
const CALLEE_ID = mkTestProgramId("Counterca11ee111111111111111111111111111111");
const SRC = join(import.meta.dir, "..", "src", "demo-programs", "cpi-counter-caller.rs");

defineDifferential({
  fixtureName: "cpi-custom-native",
  programIdBase58: MAIN_ID,
  anchorSource: readFileSync(SRC, "utf-8"),
  anchorPackageName: "cpi_custom_native_diff",
  anvilTarget: "native",
  // counter holds a raw u64 (callee-owned, no Anchor discriminator) — never strip.
  stripDiscriminator: false,
  compareTxOutcomes: true,
  auxiliaryPrograms: [{ programId: CALLEE_ID, soFilename: "counter_callee.so" }],

  setup: async () => {
    const mainProgramId = new PublicKey(MAIN_ID);
    const payer = Keypair.generate();
    const counter = Keypair.generate().publicKey;
    const [authority] = PublicKey.findProgramAddressSync([Buffer.from("authority")], mainProgramId);
    return { payer, counter, authority };
  },

  callScript: async (svm: LiteSVM, ctx, programId: PublicKey) => {
    svm.airdrop(ctx.payer.publicKey, BigInt(1_000_000_000));
    svm.setAccount(ctx.counter, {
      lamports: 10_000_000,
      data: new Uint8Array(8),
      owner: new PublicKey(CALLEE_ID),
      executable: false,
    });

    const bump = (amount: bigint) =>
      new TransactionInstruction({
        programId,
        keys: [
          { pubkey: ctx.counter, isSigner: false, isWritable: true },
          // authority: PDA, NOT a tx signer — signs only via invoke_signed inside.
          { pubkey: ctx.authority, isSigner: false, isWritable: false },
          { pubkey: new PublicKey(CALLEE_ID), isSigner: false, isWritable: false },
        ],
        data: Buffer.from([...anchorIxDiscriminator("bump_counter"), ...encodeU64LE(amount)]),
      });

    const send = (amount: bigint) => {
      const tx = new Transaction().add(bump(amount));
      tx.recentBlockhash = svm.latestBlockhash();
      tx.feePayer = ctx.payer.publicKey;
      tx.sign(ctx.payer); // authority is NOT a signer here — the make-or-break.
      svm.sendTransaction(tx);
    };

    send(7n);
    send(5n); // correct emit → counter == 12u64 on both; outcomes [ok, ok].
  },

  accountsToCompare: (ctx) => [{ pubkey: ctx.counter, label: "counter" }],
});

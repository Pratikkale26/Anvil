/**
 * #5 GOLD-STANDARD differential — runtime byte-equal gate for a GENERIC CPI.
 *
 * `cpi_counter_caller.bump_counter` invokes the committed counter_callee.so via a
 * hand-built Instruction + invoke_signed, with a PDA `authority` that signs the
 * CPI ONLY through invoke_signed (it is NEVER a tx signer — the make-or-break
 * property). The callee enforces signer + owner + data-length, so a wrong generic
 * emit (dropped signer seed, swapped account metas, truncated data) makes the CPI
 * REVERT instead of mutating the counter — which this differential catches as a
 * counter-value AND tx-outcome divergence from Anchor.
 *
 * GATING — `CPI_CUSTOM_REAL_EMIT` (default false):
 *   Anvil cannot yet type a generic CPI; today bump_counter emits the
 *   review-required `unimplemented!("Anvil: cpi_custom …")` stub, so a live run
 *   would show Anvil reverting where Anchor succeeds — a TRUE negative for a
 *   loudly-refused gap, but red CI for a known limitation. So while the flag is
 *   false we register a single skipped placeholder and do NOT call
 *   defineDifferential (no SBF build). When #5 lands a real generic-invoke emit,
 *   the always-on companion (cpi-custom-goldstandard-companion.test.ts) FAILS
 *   (the stub is gone) — that is the cue to flip this flag to true and let the
 *   runtime byte-equal gate take over.
 *
 * The fixture below is fully authored + code-reviewed so activation is a one-line
 * flag flip. The callee's adversarial revert behaviour (the gate's reference) is
 * proven independently, with no toolchain, by counter-callee-fixture-smoke.test.ts.
 */
import { describe, test } from "bun:test";
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

// Flip to true once #5 emits a real generic invoke for cpi_custom (the moment the
// companion test starts failing because the unimplemented! stub disappeared).
//
// VERIFIED 2026-06-01 (flag temporarily true, then reverted): the Anchor reference
// HALF is proven — `cpi_counter_caller` builds under anchor-cli 1.0.1 and the
// make-or-break invoke_signed-through-PDA happy path yields counter == 12u64 (0x0c)
// with outcomes [ok, ok]; Anvil's pre-#5 stub diverges to 0 (revert). So the gate
// BITES today — flipping the flag post-#5 turns a real Anvil emit (→ 12) GREEN.
const CPI_CUSTOM_REAL_EMIT = true;

const MAIN_ID = mkTestProgramId("Counterca11er111111111111111111111111111111");
const CALLEE_ID = mkTestProgramId("Counterca11ee111111111111111111111111111111");
const SRC = join(import.meta.dir, "..", "src", "demo-programs", "cpi-counter-caller.rs");

if (CPI_CUSTOM_REAL_EMIT) {
  defineDifferential({
    fixtureName: "cpi-custom-goldstandard",
    programIdBase58: MAIN_ID,
    anchorSource: readFileSync(SRC, "utf-8"),
    anchorPackageName: "cpi_custom_goldstandard_diff",
    // The counter holds a raw u64 (callee-owned, NO Anchor discriminator) — never
    // strip the leading 8 bytes or the compared value vanishes.
    stripDiscriminator: false,
    // Record the per-tx ok/revert sequence: a dropped signer seed flips ok→revert.
    compareTxOutcomes: true,
    auxiliaryPrograms: [{ programId: CALLEE_ID, soFilename: "counter_callee.so" }],

    setup: async () => {
      const mainProgramId = new PublicKey(MAIN_ID);
      const payer = Keypair.generate();
      const counter = Keypair.generate().publicKey;
      // authority is the invoke_signed PDA — derived ONLY from [b"authority"] +
      // the MAIN program id (matches `#[account(seeds=[b"authority"], bump)]`).
      const [authority] = PublicKey.findProgramAddressSync(
        [Buffer.from("authority")],
        mainProgramId,
      );
      return { payer, counter, authority };
    },

    callScript: async (svm: LiteSVM, ctx, programId: PublicKey) => {
      svm.airdrop(ctx.payer.publicKey, BigInt(1_000_000_000));
      // The callee-owned counter: 8 zero bytes, rent-exempt. Created identically
      // on both runtimes so the only variable is the emitted CPI.
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
            // authority: PDA, NOT a tx signer — it signs via invoke_signed inside
            // the program. If the emit drops the signer seed, the callee's
            // is_signer check fails and this tx reverts (≠ Anchor).
            { pubkey: ctx.authority, isSigner: false, isWritable: false },
            { pubkey: new PublicKey(CALLEE_ID), isSigner: false, isWritable: false },
          ],
          data: Buffer.from([
            ...anchorIxDiscriminator("bump_counter"),
            ...encodeU64LE(amount),
          ]),
        });

      const send = (amount: bigint) => {
        const tx = new Transaction().add(bump(amount));
        tx.recentBlockhash = svm.latestBlockhash();
        tx.feePayer = ctx.payer.publicKey;
        tx.sign(ctx.payer); // MAKE-OR-BREAK: authority is NOT a signer here.
        svm.sendTransaction(tx); // non-throwing — outcome recorded + compared.
      };

      send(7n);
      send(5n); // correct emit → counter == 12u64 on both; outcomes [ok, ok].
    },

    accountsToCompare: (ctx) => [{ pubkey: ctx.counter, label: "counter" }],
  });
} else {
  describe(
    "Anchor vs Anvil differential [cpi-custom-goldstandard] [GATED — #5 not landed]",
    () => {
      test.skip(
        "counter == 12u64 across Anchor + Anvil (flip CPI_CUSTOM_REAL_EMIT when the companion test fails)",
        () => {},
      );
    },
  );
}

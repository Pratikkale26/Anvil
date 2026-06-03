/**
 * #2 (S4) build CHECKPOINT — two-program cross-program-invocation runs end to
 * end in LiteSVM, with ZERO Anvil emit involved.
 *
 * This is the foundation the eventual `lever::cpi::switch_power` byte-equal gate
 * plugs into. It proves three things before any parser/emit work is written:
 *   1. `hand` (the CPI caller) BUILDS under anchor-cli 1.0.1 with
 *      `declare_program!(lever)` — the IDL-path resolution under cargo-build-sbf
 *      that was the decisive unknown.
 *   2. `lever` (the callee) + `hand` (the caller) co-deploy in one LiteSVM and
 *      the cross-program invoke executes (Anchor's `Program<'info, Lever>` guard
 *      requires lever to live at its declared id E64F… for the CPI to resolve).
 *   3. The CPI mutates shared state: PowerStatus.is_on flips false → true.
 *
 * Both .so are committed under tests/fixtures/programs/ (mirrors
 * counter_callee.so), built once via cargo-build-sbf from
 * solana-developers/program-examples basics/cross-program-invocation/anchor
 * (lever id E64F…, hand id Bi5N…, anchor-lang 1.0.0-rc.5). No toolchain needed
 * to run this test — it loads the prebuilt binaries directly.
 *
 * NOTE: this is the Anchor-only half. The Anvil-emit half (driving `hand` through
 * Anvil's transpiler) is gated separately by defineDifferential + auxiliaryPrograms
 * once the parser recognizes the `<crate>::cpi::<fn>` form (slice 2).
 */
import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  Transaction,
  TransactionInstruction,
  SystemProgram,
} from "@solana/web3.js";
import {
  anchorIxDiscriminator,
  concatBytes,
  Keypair,
  PublicKey,
  LiteSVM,
} from "./differential-harness.ts";

// Upstream declared ids — hand's declare_program!(lever) embeds lever's address
// (E64F…) from the IDL, and Anchor's Program<Lever> account check enforces it at
// runtime, so the callee MUST be deployed at exactly this id.
const LEVER_ID = new PublicKey("E64FVeubGC4NPNF2UBJYX4AkrVowf74fRJD9q6YhwstN");
const HAND_ID = new PublicKey("Bi5N7SUQhpGknVcqPTzdFFVueQoxoUu8YTLz75J6fT8A");

const PROGRAMS = join(import.meta.dir, "fixtures", "programs");

// Borsh String: u32 LE length + UTF-8 bytes.
function borshString(s: string): Uint8Array {
  const bytes = new TextEncoder().encode(s);
  const out = new Uint8Array(4 + bytes.length);
  new DataView(out.buffer).setUint32(0, bytes.length, true);
  out.set(bytes, 4);
  return out;
}

// PowerStatus = 8-byte Anchor discriminator + `is_on: bool` at offset 8.
function readIsOn(svm: LiteSVM, power: PublicKey): number {
  const acc = svm.getAccount(power);
  if (!acc) throw new Error("PowerStatus account missing");
  return Uint8Array.from(acc.data)[8];
}

describe("#2 (S4) — hand→lever two-program CPI runs in LiteSVM", () => {
  test("pull_lever (hand) CPIs lever::switch_power and flips PowerStatus.is_on", () => {
    const svm = new LiteSVM();
    svm.addProgram(LEVER_ID, readFileSync(join(PROGRAMS, "lever.so")));
    svm.addProgram(HAND_ID, readFileSync(join(PROGRAMS, "hand.so")));

    const payer = Keypair.generate();
    const power = Keypair.generate();
    svm.airdrop(payer.publicKey, BigInt(2_000_000_000));

    // 1) initialize PowerStatus directly via lever (power + payer sign the new account).
    const initIx = new TransactionInstruction({
      programId: LEVER_ID,
      keys: [
        { pubkey: power.publicKey, isSigner: true, isWritable: true },
        { pubkey: payer.publicKey, isSigner: true, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data: Buffer.from(anchorIxDiscriminator("initialize")),
    });
    {
      const tx = new Transaction().add(initIx);
      tx.recentBlockhash = svm.latestBlockhash();
      tx.feePayer = payer.publicKey;
      tx.sign(payer, power);
      const r = svm.sendTransaction(tx);
      expect(r?.constructor?.name).not.toBe("FailedTransactionMetadata");
    }
    expect(readIsOn(svm, power.publicKey)).toBe(0); // starts off

    // 2) pull_lever via hand: accounts [power(mut), lever_program]. hand CPIs into
    //    lever::switch_power(name), which flips is_on. payer signs (power is no
    //    longer a signer post-init).
    const pullIx = new TransactionInstruction({
      programId: HAND_ID,
      keys: [
        { pubkey: power.publicKey, isSigner: false, isWritable: true },
        { pubkey: LEVER_ID, isSigner: false, isWritable: false },
      ],
      data: Buffer.from(concatBytes(anchorIxDiscriminator("pull_lever"), borshString("Chekov"))),
    });
    {
      const tx = new Transaction().add(pullIx);
      tx.recentBlockhash = svm.latestBlockhash();
      tx.feePayer = payer.publicKey;
      tx.sign(payer);
      const r = svm.sendTransaction(tx);
      expect(r?.constructor?.name).not.toBe("FailedTransactionMetadata");
    }
    // The CPI must have flipped is_on — proves the cross-program invoke executed.
    expect(readIsOn(svm, power.publicKey)).toBe(1);
  });
});

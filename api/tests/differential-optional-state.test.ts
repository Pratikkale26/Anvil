/**
 * Optional state differential.
 *
 * Exercises borsh Option<T> encoding in account state. Borsh layout:
 *   None -> 1 byte: 0x00
 *   Some -> 1 byte: 0x01 + N bytes of T
 *
 * If the Anvil emit reads or writes Option<T> as a fixed-size slot, every
 * field after it shifts by N bytes vs the Anchor reference. The byte-equal
 * compare catches that loudly.
 *
 * Two scenarios run sequentially:
 *   1. init with delegate=Some + expiry=None  → exercises Some-then-None
 *   2. clear_delegate                         → mutates Some to None,
 *      validating the post-mutation byte layout still matches Anchor's
 *      borsh re-serialize.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Transaction, TransactionInstruction, SystemProgram } from "@solana/web3.js";
import {
  defineDifferential,
  anchorIxDiscriminator,
  encodeI64LE,
  encodeU64LE,
  concatBytes,
  Keypair,
  PublicKey,
  LiteSVM,
} from "./differential-harness.ts";

const SRC = join(import.meta.dir, "..", "src", "demo-programs", "optional-state.rs");
const PROGRAM_ID = "optn111111111111111111111111111111111111111";

// Borsh Option<T>: 0x00 for None, 0x01 + bytes for Some.
function encodeOptionPubkey(p: PublicKey | null): Uint8Array {
  if (p === null) return new Uint8Array([0]);
  return concatBytes(new Uint8Array([1]), p.toBytes());
}
function encodeOptionI64(v: bigint | null): Uint8Array {
  if (v === null) return new Uint8Array([0]);
  return concatBytes(new Uint8Array([1]), encodeI64LE(v));
}

defineDifferential({
  fixtureName: "optional-state",
  programIdBase58: PROGRAM_ID,
  anchorSource: readFileSync(SRC, "utf-8"),
  anchorPackageName: "optional_state_anchor_diff",

  setup: async () => {
    const owner = Keypair.generate();
    const delegate = Keypair.generate();
    const programId = new PublicKey(PROGRAM_ID);
    const [vaultPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("opt-vault"), owner.publicKey.toBuffer()],
      programId,
    );
    return { owner, delegate, vaultPda };
  },

  callScript: async (svm: LiteSVM, ctx, programId: PublicKey) => {
    svm.airdrop(ctx.owner.publicKey, BigInt(1_000_000_000));

    // 1. init with delegate=Some(delegate.pubkey), expiry=None.
    const initIx = new TransactionInstruction({
      programId,
      keys: [
        { pubkey: ctx.vaultPda, isSigner: false, isWritable: true },
        { pubkey: ctx.owner.publicKey, isSigner: true, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data: Buffer.from(concatBytes(
        anchorIxDiscriminator("init"),
        encodeOptionPubkey(ctx.delegate.publicKey),
        encodeOptionI64(null),
      )),
    });

    // 2. deposit some balance — exercises the post-Option fields are byte-aligned.
    const depositIx = new TransactionInstruction({
      programId,
      keys: [
        { pubkey: ctx.vaultPda, isSigner: false, isWritable: true },
        { pubkey: ctx.owner.publicKey, isSigner: true, isWritable: false },
      ],
      data: Buffer.from(concatBytes(anchorIxDiscriminator("deposit"), encodeU64LE(7777n))),
    });

    // 3. clear_delegate — mutates Option from Some to None, post-state must
    //    re-borsh with the shorter encoding (1 byte instead of 33).
    const clearIx = new TransactionInstruction({
      programId,
      keys: [
        { pubkey: ctx.vaultPda, isSigner: false, isWritable: true },
        { pubkey: ctx.owner.publicKey, isSigner: true, isWritable: false },
      ],
      data: Buffer.from(anchorIxDiscriminator("clear_delegate")),
    });

    for (const ix of [initIx, depositIx, clearIx]) {
      const tx = new Transaction().add(ix);
      tx.recentBlockhash = svm.latestBlockhash();
      tx.feePayer = ctx.owner.publicKey;
      tx.sign(ctx.owner);
      const r = svm.sendTransaction(tx);
      if (r?.constructor?.name === "FailedTransactionMetadata") {
        const failed = r as unknown as {
          err: () => { toString(): string };
          meta: () => { logs: () => string[] };
        };
        throw new Error(`tx failed: ${failed.err().toString()}\nlogs:\n${failed.meta().logs().join("\n")}`);
      }
    }
  },

  accountsToCompare: (ctx) => [
    { pubkey: ctx.vaultPda, label: "vault_pda" },
  ],
});

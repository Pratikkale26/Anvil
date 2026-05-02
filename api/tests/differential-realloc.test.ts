/**
 * Realloc differential — Native target.
 *
 * Exercises Anchor's `realloc = expr` constraint family: the existing
 * PDA's data buffer gets resized + rent topped up by the system_program.
 * Two-call scenario: init creates the account at minimum size with an
 * empty Vec<u8>, then `append` grows it by one byte via `realloc =
 * new_size as usize`.
 *
 * Built against the Native target (anvilTarget: "native") because
 * Pinocchio's AccountInfo doesn't expose realloc in its stable API —
 * the Pinocchio emit leaves a TODO(manual) comment instead of the
 * realloc CPI. Native uses solana_program::AccountInfo::realloc plus
 * an explicit system_instruction::transfer for the rent delta, both
 * of which are exact equivalents of Anchor's macro expansion.
 *
 * The byte-equal compare validates:
 *   1. realloc grows the buffer to the right size on both targets
 *   2. The Vec<u8> push round-trips identically through borsh re-serialize
 *   3. Rent delta is moved between the same source + destination
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  Transaction, TransactionInstruction, SystemProgram,
} from "@solana/web3.js";
import {
  defineDifferential,
  anchorIxDiscriminator,
  encodeU64LE,
  concatBytes,
  Keypair,
  PublicKey,
  LiteSVM,
} from "./differential-harness.ts";

const SRC = join(import.meta.dir, "..", "src", "demo-programs", "realloc.rs");
const PROGRAM_ID = "rea11oc111111111111111111111111111111111111";

defineDifferential({
  fixtureName: "realloc",
  programIdBase58: PROGRAM_ID,
  anchorSource: readFileSync(SRC, "utf-8"),
  anchorPackageName: "realloc_anchor_diff",
  anvilTarget: "native",

  setup: async () => {
    const owner = Keypair.generate();
    const programId = new PublicKey(PROGRAM_ID);
    const [statePda] = PublicKey.findProgramAddressSync(
      [Buffer.from("realloc-st"), owner.publicKey.toBuffer()],
      programId,
    );
    return { owner, statePda };
  },

  callScript: async (svm: LiteSVM, ctx, programId: PublicKey) => {
    svm.airdrop(ctx.owner.publicKey, BigInt(2_000_000_000));

    // 1. init — creates state at 8 + 1 + 4 = 13 bytes (empty log).
    const initIx = new TransactionInstruction({
      programId,
      keys: [
        { pubkey: ctx.statePda, isSigner: false, isWritable: true },
        { pubkey: ctx.owner.publicKey, isSigner: true, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data: Buffer.from(anchorIxDiscriminator("init")),
    });

    // 2. append(0xAB, new_size=14) — pushes one byte, growing data buffer
    //    from 13 to 14. The realloc constraint asks for 14 bytes; both
    //    Anchor + Anvil resize the account and write back. Post-state
    //    must byte-equal: bump=N, log_len=1, log=[0xAB], plus the rent
    //    top-up causes both sides to send the same lamport delta from
    //    owner → state.
    const appendIx = new TransactionInstruction({
      programId,
      keys: [
        { pubkey: ctx.statePda, isSigner: false, isWritable: true },
        { pubkey: ctx.owner.publicKey, isSigner: true, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data: Buffer.from(concatBytes(
        anchorIxDiscriminator("append"),
        new Uint8Array([0xab]),
      )),
    });

    for (const ix of [initIx, appendIx]) {
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
    { pubkey: ctx.statePda, label: "state_pda" },
  ],
});

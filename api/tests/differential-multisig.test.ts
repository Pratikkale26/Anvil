/**
 * Multisig n-of-m differential.
 *
 * Exercises Vec<Pubkey> + Vec<bool> account fields (variable-length Borsh
 * serialization), has_one constraint enforcement, owner-membership check
 * via `.iter().position()`, AND threshold gating via the `execute()`
 * instruction. The 2-of-3 scenario:
 *
 *   1. create(2-of-3) — Vec<Pubkey> serialization
 *   2. propose(amount) — initializes Vec<bool> approval bitmap
 *   3. approve(owner0)  — flips approved[0] = true
 *   4. approve(owner1)  — flips approved[1] = true
 *   5. execute()        — counts approvals, requires >= threshold,
 *                         flips executed = true
 *
 * Post-state byte-compares:
 *   - multisig: Vec<Pubkey> owners + threshold + proposal_count
 *   - proposal: approved = [true, true, false], executed = true
 *
 * If Vec<Pubkey> or Vec<bool> round-trip wrong (length prefix, item
 * order, byte width), the gate fires. If execute()'s threshold check
 * gates differently between runtimes (e.g. Anvil counts approvals
 * differently), the executed flag diverges.
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

const SRC = join(import.meta.dir, "..", "src", "demo-programs", "multisig.rs");
const PROGRAM_ID = "MuLtisig11111111111111111111111111111111111";

// Borsh: u32 LE length prefix, then each Pubkey as 32 raw bytes.
function encodeVecPubkey(pubkeys: PublicKey[]): Uint8Array {
  const len = new Uint8Array(4);
  new DataView(len.buffer).setUint32(0, pubkeys.length, true);
  const items = pubkeys.flatMap((pk) => Array.from(pk.toBytes()));
  return concatBytes(len, new Uint8Array(items));
}

defineDifferential({
  fixtureName: "multisig",
  programIdBase58: PROGRAM_ID,
  anchorSource: readFileSync(SRC, "utf-8"),
  anchorPackageName: "multisig_anchor_diff",

  setup: async () => {
    const programId = new PublicKey(PROGRAM_ID);
    // 3 owners, payer is owner #0.
    const owner0 = Keypair.generate();
    const owner1 = Keypair.generate();
    const owner2 = Keypair.generate();
    const [multisigPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("multisig"), owner0.publicKey.toBuffer()],
      programId,
    );
    // proposal seeds use multisig.proposal_count.to_le_bytes() — 0u64 LE
    // for the first proposal.
    const counterBytes = Buffer.alloc(8); // all zeros = 0u64 LE
    const [proposalPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("proposal"), multisigPda.toBuffer(), counterBytes],
      programId,
    );
    return { owner0, owner1, owner2, multisigPda, proposalPda };
  },

  callScript: async (svm: LiteSVM, ctx, programId: PublicKey) => {
    for (const o of [ctx.owner0, ctx.owner1, ctx.owner2]) {
      svm.airdrop(o.publicKey, BigInt(1_000_000_000));
    }

    // 1. Create multisig (2-of-3).
    const ownersBytes = encodeVecPubkey([
      ctx.owner0.publicKey,
      ctx.owner1.publicKey,
      ctx.owner2.publicKey,
    ]);
    const createIx = new TransactionInstruction({
      programId,
      keys: [
        { pubkey: ctx.multisigPda, isSigner: false, isWritable: true },
        { pubkey: ctx.owner0.publicKey, isSigner: true, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data: Buffer.from(concatBytes(
        anchorIxDiscriminator("create"),
        ownersBytes,
        new Uint8Array([2]), // threshold = 2
      )),
    });

    // 2. Propose (proposer = owner0).
    const proposeIx = new TransactionInstruction({
      programId,
      keys: [
        { pubkey: ctx.multisigPda, isSigner: false, isWritable: false },
        { pubkey: ctx.owner0.publicKey, isSigner: false, isWritable: false }, // multisig_payer
        { pubkey: ctx.proposalPda, isSigner: false, isWritable: true },
        { pubkey: ctx.owner0.publicKey, isSigner: true, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data: Buffer.from(concatBytes(
        anchorIxDiscriminator("propose"),
        encodeU64LE(0n),         // proposal_id
        encodeU64LE(500_000n),   // amount
      )),
    });

    // 3. Approve from owner0 (idx 0) and owner1 (idx 1).
    const approveIx = (signer: Keypair) =>
      new TransactionInstruction({
        programId,
        keys: [
          { pubkey: ctx.multisigPda, isSigner: false, isWritable: false },
          { pubkey: ctx.owner0.publicKey, isSigner: false, isWritable: false }, // multisig_payer
          { pubkey: ctx.proposalPda, isSigner: false, isWritable: true },
          { pubkey: signer.publicKey, isSigner: true, isWritable: false },
        ],
        data: Buffer.from(anchorIxDiscriminator("approve")),
      });

    // Send each instruction in its own tx so a failure points to one ix.
    const sendIx = (ix: TransactionInstruction, signers: Keypair[]) => {
      const tx = new Transaction().add(ix);
      tx.recentBlockhash = svm.latestBlockhash();
      tx.feePayer = signers[0]!.publicKey;
      tx.sign(...signers);
      const r = svm.sendTransaction(tx);
      if (r?.constructor?.name === "FailedTransactionMetadata") {
        const failed = r as unknown as {
          err: () => { toString(): string };
          meta: () => { logs: () => string[] };
        };
        throw new Error(`tx failed: ${failed.err().toString()}\nlogs:\n${failed.meta().logs().join("\n")}`);
      }
    };

    sendIx(createIx, [ctx.owner0]);
    sendIx(proposeIx, [ctx.owner0]);
    sendIx(approveIx(ctx.owner0), [ctx.owner0]);
    sendIx(approveIx(ctx.owner1), [ctx.owner1]);

    // 4. Execute (triggers the threshold check). 2 approvals out of 2
    // required ≥ threshold, so this succeeds and flips executed=true.
    // Either side mis-counting approvals would diverge the executed
    // flag in the proposal's post-state.
    const executeIx = new TransactionInstruction({
      programId,
      keys: [
        { pubkey: ctx.multisigPda, isSigner: false, isWritable: false },
        { pubkey: ctx.owner0.publicKey, isSigner: false, isWritable: false }, // multisig_payer
        { pubkey: ctx.proposalPda, isSigner: false, isWritable: true },
        { pubkey: ctx.owner0.publicKey, isSigner: true, isWritable: true },
      ],
      data: Buffer.from(anchorIxDiscriminator("execute")),
    });
    sendIx(executeIx, [ctx.owner0]);
  },

  accountsToCompare: (ctx) => [
    { pubkey: ctx.multisigPda, label: "multisig_pda" },
    { pubkey: ctx.proposalPda, label: "proposal_pda" },
  ],
});

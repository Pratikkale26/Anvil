/**
 * B2 GOLD-STANDARD — read-only Account<T> owner check REJECTS at runtime, with
 * revert-parity against Anchor.
 *
 * `multisig.approve` reads the `multisig` config account READ-ONLY — it holds
 * the owners list + threshold that authorize the proposal. Anchor's
 * `Account<T>::try_from` enforces `owner == program_id` on it unconditionally;
 * pre-B2 Anvil gated the owner check on `a.isMut`, so it SKIPPED the check on
 * this read-only account. An attacker could pass a same-data, same-discriminator
 * `multisig` account owned by ANOTHER program and have the authorization read
 * succeed.
 *
 * Scenario (run against both the Anchor .so and the Anvil .so):
 *   1. create(2-of-3)            — ok
 *   2. propose(amount)           — ok
 *   3. approve(owner0)           — ok   (CONTROL: approve works when owner is correct)
 *   <corrupt multisig.owner → SystemProgram, same on both runtimes>
 *   4. approve(owner1)           — REVERT on BOTH (the owner check fires)
 *
 * compareTxOutcomes asserts the ok,ok,ok,revert sequence matches between Anchor
 * and Anvil. The contrast between step 3 (ok) and step 4 (revert) — same
 * instruction, only the multisig's OWNER changed — isolates the owner check as
 * the cause. Without B2, step 4 would SUCCEED on Anvil (no owner check) → both
 * the txOutcomes sequence AND the proposal's approved[1] bit would diverge from
 * Anchor, failing this gate. This is the runtime proof that B2 matches Anchor.
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
  fixtureName: "multisig-readonly-owner-reject",
  programIdBase58: PROGRAM_ID,
  anchorSource: readFileSync(SRC, "utf-8"),
  anchorPackageName: "multisig_ro_owner_reject_diff",
  // The expected-revert step (approve after owner corruption) is the point of
  // the fixture — compare the per-tx ok/revert sequence across runtimes.
  compareTxOutcomes: true,

  setup: async () => {
    const programId = new PublicKey(PROGRAM_ID);
    const owner0 = Keypair.generate();
    const owner1 = Keypair.generate();
    const owner2 = Keypair.generate();
    const [multisigPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("multisig"), owner0.publicKey.toBuffer()],
      programId,
    );
    const counterBytes = Buffer.alloc(8); // 0u64 LE — first proposal
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

    const createIx = new TransactionInstruction({
      programId,
      keys: [
        { pubkey: ctx.multisigPda, isSigner: false, isWritable: true },
        { pubkey: ctx.owner0.publicKey, isSigner: true, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data: Buffer.from(concatBytes(
        anchorIxDiscriminator("create"),
        encodeVecPubkey([ctx.owner0.publicKey, ctx.owner1.publicKey, ctx.owner2.publicKey]),
        new Uint8Array([2]), // threshold = 2
      )),
    });

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
        encodeU64LE(0n),       // proposal_id
        encodeU64LE(500_000n), // amount
      )),
    });

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

    // Setup sends MUST succeed — throw loudly if they don't (a broken setup
    // would otherwise masquerade as revert-parity).
    const sendOk = (ix: TransactionInstruction, signers: Keypair[]) => {
      const tx = new Transaction().add(ix);
      tx.recentBlockhash = svm.latestBlockhash();
      tx.feePayer = signers[0]!.publicKey;
      tx.sign(...signers);
      const r = svm.sendTransaction(tx);
      if (r?.constructor?.name === "FailedTransactionMetadata") {
        const f = r as unknown as { err: () => { toString(): string }; meta: () => { logs: () => string[] } };
        throw new Error(`setup tx unexpectedly failed: ${f.err().toString()}\n${f.meta().logs().join("\n")}`);
      }
    };
    // The expected-revert send: do NOT throw — the wrapped sendTransaction
    // records the outcome and the harness compares it across runtimes.
    const send = (ix: TransactionInstruction, signers: Keypair[]) => {
      const tx = new Transaction().add(ix);
      tx.recentBlockhash = svm.latestBlockhash();
      tx.feePayer = signers[0]!.publicKey;
      tx.sign(...signers);
      svm.sendTransaction(tx);
    };

    sendOk(createIx, [ctx.owner0]);                  // ok
    sendOk(proposeIx, [ctx.owner0]);                 // ok
    sendOk(approveIx(ctx.owner0), [ctx.owner0]);     // ok — control: approve works

    // Corrupt the read-only multisig config: keep its data + lamports, flip
    // owner to the System program (≠ this program). Anchor's try_from and
    // Anvil's B2 owner check must both reject it.
    const acc = svm.getAccount(ctx.multisigPda);
    if (!acc) throw new Error("multisig account missing after create");
    svm.setAccount(ctx.multisigPda, {
      lamports: acc.lamports,
      data: acc.data,
      owner: SystemProgram.programId,
      executable: false,
    });

    send(approveIx(ctx.owner1), [ctx.owner1]);       // REVERT on both (owner check)
  },

  accountsToCompare: (ctx) => [
    { pubkey: ctx.multisigPda, label: "multisig_pda" },
    { pubkey: ctx.proposalPda, label: "proposal_pda" },
  ],
  // The multisig owner is intentionally corrupted to System on both runtimes,
  // so its owner is equal across runs but is NOT this program — keep the owner
  // comparison on (both must read System) to prove no runtime quietly reassigns.
});

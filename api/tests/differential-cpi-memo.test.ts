/**
 * cpi-memo differential — full byte-equal via msg-log comparison (#36).
 *
 * Both Anchor + Anvil-Pinocchio scenarios call write_memo, which CPIs into
 * the SPL Memo program (MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr). Memo
 * doesn't store on-chain state, so accountsToCompare is empty; the
 * correctness signal is the user-emitted msg!() lines (the harness drops
 * framework lines + CU lines that diverge by design).
 *
 * SPL Memo is preloaded by LiteSVM 0.7's withDefaultPrograms (verified via
 * svm.getAccount(MEMO_PROGRAM_ID)) — no harness extension needed for
 * additionalPrograms. Bumped from M3 stub to real defineDifferential.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Transaction, TransactionInstruction } from "@solana/web3.js";
import {
  defineDifferential,
  anchorIxDiscriminator,
  Keypair,
  PublicKey,
  LiteSVM,
} from "./differential-harness.ts";

const SRC = join(import.meta.dir, "..", "src", "demo-programs", "cpi-memo.rs");
const PROGRAM_ID = "CpiMemo111111111111111111111111111111111111";
const MEMO_PROGRAM_ID = new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");

defineDifferential({
  fixtureName: "cpi-memo",
  programIdBase58: PROGRAM_ID,
  anchorSource: readFileSync(SRC, "utf-8"),
  anchorPackageName: "cpi_memo_anchor_diff",
  // anchor-spl with the memo feature so `anchor_spl::memo::{self, Memo, BuildMemo}`
  // resolves on the Anchor reference build.
  anchorExtraDeps: `anchor-spl = { version = "0.31.0", features = ["memo"] }\n`,
  // Memo emits no state changes; gate is purely on the runtime log surface.
  compareMsgLogs: true,

  setup: async () => {
    const authority = Keypair.generate();
    return { authority };
  },

  callScript: async (svm: LiteSVM, ctx, programId: PublicKey) => {
    svm.airdrop(ctx.authority.publicKey, BigInt(1_000_000_000));

    // write_memo(data: Vec<u8>) — Anchor ix data is the discriminator
    // followed by a borsh-encoded Vec<u8>: u32 LE length + bytes.
    const memoData = new TextEncoder().encode("hello-from-anvil");
    const lenBuf = Buffer.alloc(4);
    lenBuf.writeUInt32LE(memoData.length, 0);
    const data = Buffer.concat([
      Buffer.from(anchorIxDiscriminator("write_memo")),
      lenBuf,
      memoData,
    ]);

    const ix = new TransactionInstruction({
      programId,
      keys: [
        { pubkey: ctx.authority.publicKey, isSigner: true, isWritable: true },
        { pubkey: MEMO_PROGRAM_ID, isSigner: false, isWritable: false },
      ],
      data,
    });
    const tx = new Transaction().add(ix);
    tx.recentBlockhash = svm.latestBlockhash();
    tx.feePayer = ctx.authority.publicKey;
    tx.sign(ctx.authority);
    const r = svm.sendTransaction(tx);
    if (r?.constructor?.name === "FailedTransactionMetadata") {
      const failed = r as unknown as {
        err: () => { toString(): string };
        meta: () => { logs: () => string[] };
      };
      throw new Error(`write_memo failed: ${failed.err().toString()}\nlogs:\n${failed.meta().logs().join("\n")}`);
    }
  },

  // No state to compare — Memo is a logging-only CPI.
  accountsToCompare: () => [],
});
